import "server-only";

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
  type PermissionRuleValue,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue } from "./async-queue";
import { findClaudeBinary } from "./claude-binary";
import {
  createPlanMcpServer,
  PLAN_MCP_SERVER_NAME,
  SUBMIT_PLAN_FQN,
} from "./plan-mcp";
import {
  createNotesMcpServer,
  LIST_NOTES_FQN,
  NOTES_MCP_SERVER_NAME,
  SUBMIT_NOTE_FQN,
} from "./notes-mcp";
import {
  ADOPT_PLAN_FQN,
  ARCHIVE_PLAN_FQN,
  createLeaderMcpServer,
  LEADER_LIST_NOTES_FQN,
  LEADER_MCP_SERVER_NAME,
  MERGE_PLAN_FQN,
  READ_PHASE_DIFF_FQN,
  READ_PLAN_STATE_FQN,
  RECORD_SHARED_CONTEXT_FQN,
  RUN_INTEGRATION_REVIEW_FQN,
} from "./leader-mcp";
import { getDbMcpEntries } from "./postgres-mcp";
import { MCP_DB_TOOL_RE } from "@/lib/mcp-db-tools";
import {
  deleteStoredSession,
  loadAllStoredSessions,
  persistStoredSession,
  type StoredSession,
} from "./session-store";
import { listAllPlans } from "./plans";
import { startRlResetWatchdog } from "./rl-watchdog";
import { ensureSkillsInstalled } from "./skills-installer";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionEntry,
  AskUserQuestionRequest,
  Attachment,
  ChatEvent,
  ContextUsageBreakdown,
  HandoffRecord,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  RateLimitInfo,
  SessionProvider,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  SessionUsage,
} from "@/lib/chat-types";
import { driveCodexSession } from "./codex-driver";
import { listCodexConfigDirs, resolveCodexAuth } from "./codex-auth";
import { loadOpenRouterConfigSync, openRouterEnv } from "./openrouter-config";
import {
  listSnapshots as fhListSnapshots,
  pathsForTool as fhPathsForTool,
  restoreCode as fhRestoreCode,
  trackEdit as fhTrackEdit,
  type FileSnapshot,
  type RestoreFileAction,
} from "./file-history";
import type { PlanRecord } from "@/lib/plan-types";
import { deriveSubagents } from "@/lib/subagents";

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
  // SDK ships PermissionUpdate suggestions alongside each canUseTool
  // call (e.g. "addRules: Bash(git status:*) for session"). We hand
  // them to the UI only as opaque records so the chat-types layer
  // doesn't depend on SDK internals; the original typed array stays
  // here for resolvePermission to echo back as updatedPermissions
  // when the user clicks "Always allow".
  suggestions?: PermissionUpdate[];
}

interface PendingQuestion {
  request: AskUserQuestionRequest;
  // Original questions (with options) shipped back to the SDK alongside
  // the user's answers; the SDK passes them through as the tool result.
  questions: AskUserQuestionEntry[];
  resolve: (result: PermissionResult) => void;
}

interface ChatSession {
  id: string;
  cwd: string;
  configDir: string;
  accountName?: string;
  createdAt: Date;
  model?: string;
  effort?: EffortLevel;
  provider?: SessionProvider;
  permissionMode: PermissionMode;
  // Set when this session is a phase executor (spawned from plan approve).
  // Sidebar uses these to group phase sessions under their owning plan;
  // PhaseBoard joins on (plan_id, phase_slug) to attach live status.
  planId?: string;
  phaseSlug?: string;

  inputQueue: AsyncQueue<SDKUserMessage>;
  query: Query;
  history: SDKMessage[];
  status: SessionStatus;
  pendingPermission?: PendingPermission;
  pendingQuestion?: PendingQuestion;
  emitter: EventEmitter;
  abortController: AbortController;
  // Cache of (clientRequestId -> expiresAt) used to drop duplicate
  // input POSTs from a flaky network or a double-pressed Enter. We
  // store on the session itself so dedupe is scoped per chat.
  recentRequestIds: Map<string, number>;
  // Latest plan submitted via the submit_plan MCP tool. Only the most
  // recent submission is shown in the panel; older ones remain on disk
  // under ~/.claude/projects/<encoded-cwd>/plans/.
  latestPlan?: PlanRecord;
  // Per-API-call usage snapshot, captured from the most recent
  // top-level `assistant` message (NOT from `result.usage`). The SDK
  // sums `result.usage` across every API round-trip in a turn, so on
  // a tool-heavy turn `cache_read_input_tokens` balloons to N x the
  // real cached prefix. Reading from the assistant message gives the
  // live cached/new-input split for that single call, which is what
  // the context-window meter falls back to when the SDK control
  // channel is unavailable.
  latestUsage?: SessionUsage;
  // Authoritative context breakdown from the SDK control channel
  // (Query.getContextUsage). This is the same data Claude CLI's
  // /context renders. Refreshed once per turn (after `result`).
  // Preferred over derived `latestUsage` when present.
  latestContextUsage?: ContextUsageBreakdown;
  // Session-local cache of "always allow" rules. We ship the same
  // rules to the SDK as updatedPermissions so the underlying claude
  // binary's matcher gates them too, but empirically that round-trip
  // doesn't always silence subsequent canUseTool calls (the binary's
  // session-scoped rule store and the SDK's TS matcher disagree about
  // when a rule applies). Caching here lets makeCanUseTool short-
  // circuit identical Bash invocations regardless of what the binary
  // decides — matching the user's mental model of "I clicked Always".
  alwaysAllowRules: PermissionRuleValue[];
  // Most recent rate_limit_event observed. The SDK auto-retries
  // internally — we just hold this so the UI can render a countdown
  // and the field survives restart via session-store.
  rateLimit?: RateLimitInfo;
  rateLimitObservedAt?: string;
  // Provider handoffs that have fired on this session (chronological).
  // When non-empty, the last entry's to_provider matches session.provider
  // and the driver loop is driveCodexSession instead of driveSession.
  handoffs?: HandoffRecord[];
  // True while a handoff is in progress (claude turn for the summary
  // is in flight, or codex respawn is queued). Guards re-entry: a
  // user can't fire two handoffs simultaneously.
  handoffInFlight?: boolean;
}

// InterruptedSession is the on-restart shadow of a ChatSession: just
// the persistable fields. We hold one in `interruptedSessions` for
// every session loaded from disk that hasn't been re-materialized yet.
// On the first interaction (sendMessage / SSE subscribe / option
// change) we promote it to a real ChatSession via resumeSession() and
// drop the shadow.
interface InterruptedSession {
  id: string;
  cwd: string;
  configDir: string;
  accountName?: string;
  createdAt: Date;
  model?: string;
  effort?: EffortLevel;
  provider?: SessionProvider;
  permissionMode: PermissionMode;
  history: SDKMessage[];
  latestUsage?: SessionUsage;
  latestContextUsage?: ContextUsageBreakdown;
  latestPlan?: PlanRecord;
  planId?: string;
  phaseSlug?: string;
  rateLimit?: RateLimitInfo;
  rateLimitObservedAt?: string;
  // Handoffs survive a restart so a session that was already routed
  // through codex resumes through codex (not back through claude).
  handoffs?: HandoffRecord[];
}

// Stash the registries on globalThis so they survive Next.js dev module
// reloads (Turbopack re-evaluates server modules unpredictably; without
// this, every recompile drops in-flight chat sessions). The disk-load
// init flag is also stashed so HMR doesn't trigger a re-read on every
// recompile — only the first import in a fresh process initialises.
const SESSIONS_KEY = Symbol.for("claude-monitor.web.sessions");
const INTERRUPTED_KEY = Symbol.for("claude-monitor.web.interrupted-sessions");
const INIT_KEY = Symbol.for("claude-monitor.web.sessions-init");
const PERSIST_TIMERS_KEY = Symbol.for("claude-monitor.web.persist-timers");
type SessionsGlobal = typeof globalThis & {
  [SESSIONS_KEY]?: Map<string, ChatSession>;
  [INTERRUPTED_KEY]?: Map<string, InterruptedSession>;
  [INIT_KEY]?: boolean;
  [PERSIST_TIMERS_KEY]?: Map<string, ReturnType<typeof setTimeout>>;
};
const g = globalThis as SessionsGlobal;
const sessions: Map<string, ChatSession> = (g[SESSIONS_KEY] ??= new Map());
const interruptedSessions: Map<string, InterruptedSession> = (g[
  INTERRUPTED_KEY
] ??= new Map());
// Per-session debounce timers for disk writes. Coalesces a burst of
// stream_event/assistant/result messages within a turn into one write.
const persistTimers: Map<string, ReturnType<typeof setTimeout>> = (g[
  PERSIST_TIMERS_KEY
] ??= new Map());

// Kick off the disk hydrate exactly once per process. Subsequent module
// re-evals (HMR) skip it because globalThis already has the maps. We
// don't await: callers hitting GET /api/chat in the first ~50ms after
// boot may briefly see fewer sessions than there really are, but the
// 5s sidebar poll picks them up. Awaiting would block every API route
// behind I/O on every cold start.
if (!g[INIT_KEY]) {
  g[INIT_KEY] = true;
  void initFromDisk();
}

async function initFromDisk(): Promise<void> {
  try {
    const stored = await loadAllStoredSessions();
    for (const s of stored) {
      // Don't clobber a session we already have in memory (e.g. a
      // dev-mode HMR that somehow happened before the init flag was
      // set, or a session created during the brief async window
      // between flag-set and readdir).
      if (sessions.has(s.id) || interruptedSessions.has(s.id)) continue;
      interruptedSessions.set(s.id, {
        id: s.id,
        cwd: s.cwd,
        configDir: s.config_dir,
        accountName: s.account_name,
        createdAt: new Date(s.created_at),
        model: s.model,
        effort: s.effort,
        provider: s.provider,
        permissionMode: s.permission_mode,
        history: s.history,
        latestUsage: s.latest_usage,
        latestContextUsage: s.latest_context_usage,
        latestPlan: s.latest_plan,
        planId: s.plan_id,
        phaseSlug: s.phase_slug,
        rateLimit: s.rate_limit,
        rateLimitObservedAt: s.rate_limit_observed_at,
        handoffs: s.handoffs,
      });
    }
    if (stored.length > 0) {
      console.log(`[sessions] restored ${stored.length} interrupted session(s) from disk`);
    }
  } catch (err) {
    console.warn("[sessions] disk hydrate failed:", err);
  }

  // Eagerly re-spawn phase sessions for every approved plan. Without
  // this, a session that was rate-limited / mid-turn when the daemon
  // went down stays as a shadow until the user navigates to its tab —
  // which defeats the whole point of unattended phase scheduling.
  // Promoting via getOrResume re-launches the SDK Query in `resume`
  // mode so the claude binary picks the transcript back up; whether it
  // re-emits a stalled turn is the binary's job.
  //
  // Skipped: phases that already committed (clean / committed). Those
  // are done — re-hydrating wastes a Query. failed/unset stay eligible
  // because the user may still want to retry.
  await rehydratePhaseSessions();

  // Background watchdog: phase sessions that hit a hard rate limit and
  // exhausted the SDK's internal retries get auto-restarted once their
  // resetsAt window opens. Idempotent — only arms the timer once per
  // process, regardless of how often this module is re-evaluated.
  startRlResetWatchdog();

  // Install vendored skills (web/skills/*) into ~/.claude/skills/ so
  // every Claude Code session the orchestrator spawns can discover
  // them via the native skill-trigger mechanism — phase agents pick
  // them up by description match without us having to nail content
  // into every kickoff prompt. Idempotent on unchanged content.
  try {
    await ensureSkillsInstalled();
  } catch (err) {
    console.warn("[sessions] ensureSkillsInstalled failed:", err);
  }
}

async function rehydratePhaseSessions(): Promise<void> {
  let revived = 0;
  try {
    const plans = await listAllPlans();
    for (const plan of plans) {
      if (plan.status !== "approved") continue;
      for (const link of plan.phase_sessions ?? []) {
        if (link.commit_status === "clean" || link.commit_status === "committed") {
          continue;
        }
        // Already live? Nothing to do. Only the shadow path needs a kick.
        if (sessions.has(link.session_id)) continue;
        if (!interruptedSessions.has(link.session_id)) continue;
        try {
          getOrResume(link.session_id);
          revived++;
        } catch (err) {
          console.warn(
            `[sessions] re-hydrate ${link.session_id} (plan ${plan.id} / phase ${link.phase_slug}) failed:`,
            err,
          );
        }
      }
    }
  } catch (err) {
    console.warn("[sessions] phase re-hydrate sweep failed:", err);
    return;
  }
  if (revived > 0) {
    console.log(`[sessions] re-hydrated ${revived} phase session(s) from approved plans`);
  }
}

const PERSIST_DEBOUNCE_MS = 500;

// Appended to every owner/leader session's system prompt. Default
// behavior is unchanged — act like a normal Claude Code session. The
// only addition is recognizing the explicit multi-phase directive the
// composer's MultiPhaseToggle prepends to a user message.
//
// We deliberately don't teach the model to triage or volunteer the
// multi-phase path on its own — the user has the toggle in the
// composer for that. Phase sessions don't see this append: they have
// a curated kickoff prompt and a single-purpose scope.
const OWNER_TRIAGE_APPEND = `## Orchestrator: multi-phase directive

This chat runs inside the claude-monitor orchestrator. By default behave as a normal Claude Code single-session agent — plan, edit, and run tools in this chat as usual.

If a user message arrives with a leading \`<orchestrator-intent>multi-phase</orchestrator-intent>\` directive, the chat has already been flipped into Plan mode (\`permissionMode: "plan"\`) by the composer — Edit / Write / Bash file-modifying tools are blocked. Use the read-only window to research the codebase (Read, Grep, Glob), then draft the phases and call the \`mcp__plans__submit_plan\` MCP tool with them. \`submit_plan\` is auto-approved past Plan mode's read-only gate; it serves as your plan-mode exit and writes the structured plan into the orchestrator. After it returns, the user reviews and approves the plan in the chat panel; phase agents then spawn into their own git worktrees and this chat becomes the leader (\`mcp__leader__*\` tools). Without the directive, do NOT volunteer the multi-phase path or call \`submit_plan\`.`;

// DB_MCP_PRESENTATION_APPEND is injected only when the session has at
// least one DB MCP connection configured. The chat UI lifts every
// \`mcp__<conn>__execute_sql\` / \`mcp__<conn>__run_query\` call into a
// SQL playground card (header + editable SQL + interactive result
// table with row-click JSON expansion). If you ALSO re-render the
// rows as a markdown table the user sees the same data twice — exactly
// the duplication this directive prevents.
//
// Placed FIRST in the system-prompt append list (before owner-triage
// / post-handoff) because it's a strict output rule — putting it after
// other long blocks let the model treat it as a "general tip" and
// continue mirroring tables. Concrete examples are required: prior
// versions used only "DO NOT" prose and the model still produced
// markdown tables in ~every reply.
const DB_MCP_PRESENTATION_APPEND = `## CRITICAL OUTPUT RULE: DB MCP query results

When you call \`mcp__<conn>__execute_sql\` (postgres) or \`mcp__<conn>__run_query\` (clickhouse), the chat UI ALREADY renders the full result as an interactive sortable table directly inside the user's view. Your reply MUST NOT contain a markdown table that restates the same rows. This is a hard rule — the user flagged the duplication explicitly.

### What "duplicate" means here

❌ Forbidden — reproducing the SQL result as a markdown table:

\`\`\`
| id  | name    | status |
| --- | ------- | ------ |
| 1   | Tungify | active |
| 2   | Alice   | active |
\`\`\`

❌ Also forbidden — same rows reformatted as a numbered list, bullet list, JSON code block, or "key: value" pairs. The format doesn't matter; restating the rows is what's banned.

### What to do instead

✅ Reference specific cells inline in prose:
"The \`Tungify\` row (id=1) is the only one with \`status=active\` — Alice was archived last week."

✅ Summarize what the data means, what's surprising, or the next step.

✅ If the user explicitly asks "show me the table" or "format as a table" — comply (their direct request overrides this rule).

✅ A DIFFERENT cut (aggregation, grouping, filtered subset, a join across two earlier queries) is fine as a table — that's NEW information, not a mirror of the playground.

### Scope

Applies ONLY to the immediate reply following a query tool call. Markdown tables for analytical summaries, plan breakdowns, comparison matrices, schema overviews, etc. are unaffected.

If you find yourself about to write \`| col1 | col2 |\` directly after a SQL tool result — stop, delete it, and write prose instead.`;

// schedulePersist coalesces rapid changes (token deltas + history pushes
// + status flips during a single turn) into one write. The first
// schedule sets a 500ms timer; subsequent calls within that window reset
// it. When the timer fires we read the *current* session state — so a
// burst of 200 history pushes still results in one snapshot of the
// final state, not 200 partial snapshots.
function schedulePersist(id: string): void {
  const existing = persistTimers.get(id);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    id,
    setTimeout(() => {
      persistTimers.delete(id);
      void persistNow(id);
    }, PERSIST_DEBOUNCE_MS),
  );
}

async function persistNow(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return; // session was stopped between schedule and fire — nothing to write
  try {
    const stored: StoredSession = {
      version: 1,
      id: s.id,
      cwd: s.cwd,
      config_dir: s.configDir,
      account_name: s.accountName,
      created_at: s.createdAt.toISOString(),
      model: s.model,
      effort: s.effort,
      provider: s.provider,
      permission_mode: s.permissionMode,
      history: s.history,
      latest_usage: s.latestUsage,
      latest_context_usage: s.latestContextUsage,
      latest_plan: s.latestPlan,
      plan_id: s.planId,
      phase_slug: s.phaseSlug,
      rate_limit: s.rateLimit,
      rate_limit_observed_at: s.rateLimitObservedAt,
      handoffs: s.handoffs,
    };
    await persistStoredSession(stored);
  } catch (err) {
    console.warn(`[sessions] persist ${id} failed:`, err);
  }
}

// Cap history per session to prevent unbounded memory growth from a long-
// running chat. The full transcript stays in the SDK's session store on
// disk anyway; this is just for live-replay to newly connected clients.
const HISTORY_CAP = 1000;

function setStatus(session: ChatSession, status: SessionStatus): void {
  if (session.status === status) return;
  session.status = status;
  emit(session, { type: "status", data: { status } });
  // Status itself isn't persisted (we always restore as "interrupted"),
  // but every status flip also marks a moment where history/usage may
  // have just changed — piggy-back the debounced flush so the on-disk
  // copy keeps up with the live one without us threading schedulePersist
  // through every callsite that mutates state.
  schedulePersist(session.id);
}

function emit(session: ChatSession, event: ChatEvent): void {
  // EventEmitter is synchronous fan-out — slow SSE clients buffer at the
  // HTTP layer (controller.enqueue) rather than blocking us here.
  session.emitter.emit("event", event);
}

function summarize(session: ChatSession): SessionSummary {
  const subagents = deriveSubagents(session.history).list;
  return {
    id: session.id,
    cwd: session.cwd,
    config_dir: session.configDir,
    account_name: session.accountName,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    history_length: session.history.length,
    title: firstUserText(session.history),
    model: session.model,
    effort: session.effort,
    provider: session.provider,
    permission_mode: session.permissionMode,
    usage: session.latestUsage,
    context_usage: session.latestContextUsage,
    subagents: subagents.length > 0 ? subagents : undefined,
    plan_id: session.planId,
    phase_slug: session.phaseSlug,
    rate_limit: session.rateLimit,
    rate_limit_observed_at: session.rateLimitObservedAt,
    handoffs: session.handoffs && session.handoffs.length > 0
      ? session.handoffs
      : undefined,
  };
}

// handleRateLimitEvent translates an SDKRateLimitEvent into our
// snake_case wire shape, persists it on the session for restart-
// survivability, and emits a `rate_limit` SSE event. Status flips to
// `rate_limited` only on the `rejected` outcome — `allowed_warning` is
// a heads-up the badge can show without claiming the agent is paused;
// `allowed` is silent (we still record it so a UI countdown clock has
// something to display once it expires, but no SSE noise).
function handleRateLimitEvent(
  session: ChatSession,
  msg: Extract<SDKMessage, { type: "rate_limit_event" }>,
): void {
  const raw = msg.rate_limit_info;
  const info: RateLimitInfo = {
    status: raw.status,
    resetsAt: raw.resetsAt,
    rate_limit_type: raw.rateLimitType,
    utilization: raw.utilization,
    overage_status: raw.overageStatus,
    overage_resets_at: raw.overageResetsAt,
    is_using_overage: raw.isUsingOverage,
    surpassed_threshold: raw.surpassedThreshold,
  };
  const observedAt = new Date().toISOString();
  session.rateLimit = info;
  session.rateLimitObservedAt = observedAt;
  schedulePersist(session.id);
  emit(session, {
    type: "rate_limit",
    data: { info, observed_at: observedAt },
  });
  if (info.status === "rejected") {
    // Don't trample awaiting_permission — a pending tool dialog is
    // strictly more important and the user-facing state stays accurate
    // (the dialog will resolve, then the next turn either gets through
    // or hits the same rate limit and re-emits).
    if (
      session.status !== "awaiting_permission" &&
      session.status !== "errored" &&
      session.status !== "closed"
    ) {
      setStatus(session, "rate_limited");
    }
  }
}

// refreshContextUsage queries the SDK control channel for an
// authoritative breakdown of what's currently in the context window
// (system prompt, tools, MCP, memory files, skills, messages, ...).
// This is the same data the CLI's /context shows. We call it after
// `result` messages so the sidebar/meter always reflects the latest
// turn. Failures are swallowed: SDK versions without the control
// method just leave `latestContextUsage` undefined and the UI falls
// back to deriving from `latestUsage`.
async function refreshContextUsage(session: ChatSession): Promise<void> {
  const q = session.query as unknown as {
    getContextUsage?: () => Promise<{
      categories: Array<{
        name: string;
        tokens: number;
        color: string;
        isDeferred?: boolean;
      }>;
      totalTokens: number;
      maxTokens: number;
      percentage: number;
      model: string;
      memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
      mcpTools?: Array<{
        name: string;
        serverName: string;
        tokens: number;
        isLoaded?: boolean;
      }>;
      systemTools?: Array<{ name: string; tokens: number }>;
      deferredBuiltinTools?: Array<{
        name: string;
        tokens: number;
        isLoaded: boolean;
      }>;
      systemPromptSections?: Array<{ name: string; tokens: number }>;
    }>;
  };
  if (typeof q.getContextUsage !== "function") return;
  try {
    const r = await q.getContextUsage();
    const breakdown: ContextUsageBreakdown = {
      categories: r.categories.map((c) => ({
        name: c.name,
        tokens: c.tokens,
        color: c.color,
        is_deferred: c.isDeferred,
      })),
      total_tokens: r.totalTokens,
      max_tokens: r.maxTokens,
      percentage: r.percentage,
      model: r.model,
      memory_files: r.memoryFiles,
      mcp_tools: r.mcpTools?.map((t) => ({
        name: t.name,
        server_name: t.serverName,
        tokens: t.tokens,
        is_loaded: t.isLoaded,
      })),
      system_tools: r.systemTools,
      deferred_builtin_tools: r.deferredBuiltinTools?.map((t) => ({
        name: t.name,
        tokens: t.tokens,
        is_loaded: t.isLoaded,
      })),
      system_prompt_sections: r.systemPromptSections,
    };
    session.latestContextUsage = breakdown;
    emit(session, { type: "context_usage", data: breakdown });
  } catch {
    // Control request can fail mid-shutdown or on transport hiccups;
    // not worth surfacing — UI keeps the previous breakdown.
  }
}

const TITLE_MAX = 80;

// buildUserContent translates the wire input (text + attachments) into the
// shape the Claude API expects on user messages. Plain text with no
// attachments stays as a string — that's what the SDK has always seen,
// and keeping the simple case unchanged means existing chats behave the
// same. Attachments force a content-block array.
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const ALLOWED_IMAGE_TYPES: ReadonlySet<ImageMediaType> = new Set<ImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ImageMediaType; data: string };
    };

function buildUserContent(
  text: string,
  attachments?: Attachment[],
): string | ContentBlock[] {
  if (!attachments || attachments.length === 0) return text;

  const blocks: ContentBlock[] = [];
  // Inline text-file attachments first so the model has the context
  // before reading the prompt. Mirrors how Claude CLI renders pasted
  // file content as fenced code above the user prompt.
  for (const att of attachments) {
    if (att.type === "text_file") {
      const fence = att.language ? `\`\`\`${att.language}` : "```";
      blocks.push({
        type: "text",
        text: `${att.filename}:\n${fence}\n${att.content}\n\`\`\``,
      });
    }
  }
  for (const att of attachments) {
    if (att.type !== "image") continue;
    const m = /^data:([^;]+);base64,(.+)$/.exec(att.data_url);
    if (!m) continue;
    const mediaType = m[1] as ImageMediaType;
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      // The Claude API rejects formats outside this set (avif, heic, …).
      // Surface as a fenced text note instead of dropping silently.
      blocks.push({
        type: "text",
        text: `[skipped image ${att.filename ?? ""}: unsupported format ${m[1]}]`,
      });
      continue;
    }
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: m[2] },
    });
  }
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

// firstUserText pulls a snippet from the earliest plain-text user message.
// Tool-result messages are also `type: "user"` in SDKMessage but their
// content is a structured array, so we skip those.
function firstUserText(history: SDKMessage[]): string | undefined {
  for (const msg of history) {
    if (msg.type !== "user") continue;
    const content = msg.message.content;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    return trimmed.length > TITLE_MAX
      ? trimmed.slice(0, TITLE_MAX - 1) + "…"
      : trimmed;
  }
  return undefined;
}

// latestUserMessageId scans history for the most recent user message
// uuid. Used by the file-history hook in canUseTool so each snapshot
// is tagged with its parent user turn — the /rewind picker groups
// snapshots by parent so a single user message that drove ten Edits
// shows up as one restore point.
function latestUserMessageId(s: ChatSession): string | undefined {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if (m.type === "user") {
      return (m as { uuid?: string }).uuid;
    }
  }
  return undefined;
}

// makeCanUseTool returns a CanUseTool callback bound to the given
// session. Factored out so createSession (fresh) and resumeSession
// (reanimated from disk) share one implementation — both need the
// closure to point at the *same* live session object that callers see
// in the `sessions` map.
function makeCanUseTool(session: ChatSession): CanUseTool {
  return (toolName, input, ctx) => {
    // submit_plan is purely informational: it persists structured plan
    // data and emits an SSE event. Auto-allow so the model isn't blocked
    // on a UI dialog the user doesn't need to see.
    if (toolName === SUBMIT_PLAN_FQN) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // Phase notes are sibling broadcasts — the MCP closure scopes them
    // to this session's plan + phase, so there is no privileged surface
    // for the user to gate. Auto-allow both the writer and the reader
    // for the same reason submit_plan is auto-allowed.
    if (toolName === SUBMIT_NOTE_FQN || toolName === LIST_NOTES_FQN) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // Leader read tools + plan-scoped writes (shared brief, merge,
    // integration review, archive flag) auto-allow — they touch plan.json
    // and the integration branch the owner already controls. Cleanup
    // (cleanup_worktrees) intentionally falls through to the user
    // dialog because it deletes worktree dirs and phase branches.
    if (
      toolName === READ_PLAN_STATE_FQN ||
      toolName === LEADER_LIST_NOTES_FQN ||
      toolName === READ_PHASE_DIFF_FQN ||
      toolName === RECORD_SHARED_CONTEXT_FQN ||
      toolName === MERGE_PLAN_FQN ||
      toolName === RUN_INTEGRATION_REVIEW_FQN ||
      toolName === ARCHIVE_PLAN_FQN ||
      toolName === ADOPT_PLAN_FQN
    ) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    // AskUserQuestion is a conversational tool, not a privileged action.
    // Route it through its own form UI instead of the generic permission
    // gate — the user picks an option, and we ship the answers back to
    // the SDK via updatedInput.answers. The SDK forwards them as the
    // tool result (no real tool execution happens here).
    if (toolName === "AskUserQuestion") {
      return new Promise<PermissionResult>((resolve) => {
        const questions = (input as { questions?: AskUserQuestionEntry[] })
          .questions;
        if (!Array.isArray(questions) || questions.length === 0) {
          resolve({
            behavior: "deny",
            message: "AskUserQuestion called with no questions array",
          });
          return;
        }
        const request: AskUserQuestionRequest = {
          id: randomUUID(),
          tool_use_id: ctx.toolUseID,
          questions,
        };
        session.pendingQuestion = {
          request,
          questions,
          resolve: (decision) => {
            session.pendingQuestion = undefined;
            emit(session, {
              type: "ask_user_question_resolved",
              data: { id: request.id },
            });
            resolve(decision);
          },
        };
        setStatus(session, "awaiting_permission");
        emit(session, { type: "ask_user_question", data: request });

        ctx.signal.addEventListener(
          "abort",
          () => {
            if (session.pendingQuestion?.request.id === request.id) {
              session.pendingQuestion.resolve({
                behavior: "deny",
                message: "question aborted before user answered",
              });
            }
          },
          { once: true },
        );
      });
    }
    // Snapshot file-mutating tool inputs BEFORE the permission gate so
    // /rewind has something to restore from even when the user
    // approves on auto. We fire-and-forget the trackEdit call so the
    // permission flow isn't blocked on disk I/O — a failed snapshot
    // surfaces in the server log but doesn't deny the tool.
    const fhPaths = fhPathsForTool(toolName, input, session.cwd);
    if (fhPaths.length > 0) {
      void fhTrackEdit({
        sessionId: session.id,
        parentMessageId: latestUserMessageId(session),
        toolName,
        toolUseId: ctx.toolUseID,
        paths: fhPaths,
      });
    }
    // Short-circuit if a previous "Always allow" already covered this
    // exact tool+input. The SDK is supposed to silence matching calls
    // once we hand back updatedPermissions, but in practice it still
    // re-asks — so we maintain a session-local cache and resolve here
    // before bothering the user. See alwaysAllowRules on ChatSession.
    if (matchesAlwaysAllow(session, toolName, input)) {
      return Promise.resolve<PermissionResult>({
        behavior: "allow",
        updatedInput: input,
      });
    }
    return new Promise<PermissionResult>((resolve) => {
      // Forward SDK-suggested rules to the UI as opaque records so the
      // dialog can offer "Always allow" without our chat-types layer
      // having to mirror the SDK's PermissionUpdate union. The server
      // keeps the typed copy on PendingPermission for the round trip.
      //
      // Empirically the SDK does not always populate `ctx.suggestions`
      // (depends on tool + bridge version). For tools where we *know*
      // the right session-scoped rule shape — currently Bash with a
      // concrete command — synthesize a fallback so users still get an
      // "Always allow" affordance instead of being stuck re-approving
      // identical commands. Anything unrecognized falls back to the
      // SDK's list (possibly empty → no button).
      const suggestions: PermissionUpdate[] =
        ctx.suggestions && ctx.suggestions.length > 0
          ? ctx.suggestions
          : synthesizeSuggestions(toolName, input);
      // One-time-ish console log so we can confirm what the SDK ships
      // for each tool in real sessions. Cheap (one line per prompt) and
      // strictly diagnostic — strip once the matrix is understood.
      console.log(
        `[permission] tool=${toolName} sdkSuggestions=${
          ctx.suggestions?.length ?? 0
        } effective=${suggestions.length}`,
      );
      const request: PermissionRequest = {
        id: randomUUID(),
        tool_name: toolName,
        input,
        tool_use_id: ctx.toolUseID,
        permission_suggestions:
          suggestions.length > 0
            ? (suggestions as unknown as Record<string, unknown>[])
            : undefined,
      };
      session.pendingPermission = {
        request,
        suggestions,
        resolve: (decision) => {
          session.pendingPermission = undefined;
          emit(session, { type: "permission_resolved", data: { id: request.id } });
          resolve(decision);
        },
      };
      setStatus(session, "awaiting_permission");
      emit(session, { type: "permission_request", data: request });

      // If the SDK aborts the tool call (e.g. user interrupts the turn)
      // before the user decides, auto-deny so we don't leak the resolver.
      ctx.signal.addEventListener(
        "abort",
        () => {
          if (session.pendingPermission?.request.id === request.id) {
            session.pendingPermission.resolve({
              behavior: "deny",
              message: "tool call aborted before user decision",
            });
          }
        },
        { once: true },
      );
    });
  };
}

// makePlanMcp returns a session-bound plan MCP server. Same factoring
// rationale as makeCanUseTool — the onPlanSubmitted callback needs to
// mutate the live session both for fresh and resumed sessions, and a
// resumed session has to use a server tied to its own object identity.
function makePlanMcp(session: ChatSession) {
  return createPlanMcpServer({
    sessionId: session.id,
    cwd: session.cwd,
    onPlanSubmitted: (plan) => {
      session.latestPlan = plan;
      schedulePersist(session.id);
      emit(session, { type: "plan_submitted", data: plan });
    },
  });
}

// makeNotesMcp returns a session-bound phase-notes MCP server. Only
// meaningful for phase sessions (planId + phaseSlug both set); the
// caller checks before invoking. Closure pins the planId/phaseSlug at
// build time so submit_phase_note can append without the agent having
// to identify itself in every call.
function makeNotesMcp(session: ChatSession) {
  if (!session.planId || !session.phaseSlug) {
    throw new Error(
      "makeNotesMcp requires session.planId and session.phaseSlug",
    );
  }
  return createNotesMcpServer({
    planId: session.planId,
    phaseSlug: session.phaseSlug,
  });
}

// makeLeaderMcp builds the cross-phase read-only toolkit for an owner
// session — the chat that submitted the plan. Closures over the live
// session so resolveCurrentPlanId tracks whatever submit_plan most
// recently wrote without the leader having to thread plan_id through
// every call. snapshotPhaseSession is wired through `summarize` so
// read_plan_state surfaces live SDK status (thinking/idle/...) and
// context_usage alongside the on-disk plan record.
function makeLeaderMcp(session: ChatSession) {
  return createLeaderMcpServer({
    sessionId: session.id,
    resolveCurrentPlanId: () => session.latestPlan?.id,
    snapshotPhaseSession: (sid) => {
      const s = sessions.get(sid);
      return s ? summarize(s) : undefined;
    },
    // adopt_plan calls this so the live ChatSession's latestPlan flips
    // to the adopted plan; subsequent leader tool calls then resolve
    // plan_id automatically. schedulePersist mirrors the change to
    // session-store so it survives daemon restarts.
    bindCurrentPlan: (plan) => {
      session.latestPlan = plan;
      schedulePersist(session.id);
    },
  });
}

interface BuildLiveInit {
  id: string;
  cwd: string;
  configDir: string;
  accountName?: string;
  createdAt: Date;
  model?: string;
  effort?: EffortLevel;
  provider?: SessionProvider;
  permissionMode: PermissionMode;
  history: SDKMessage[];
  latestUsage?: SessionUsage;
  latestContextUsage?: ContextUsageBreakdown;
  latestPlan?: PlanRecord;
  planId?: string;
  phaseSlug?: string;
  rateLimit?: RateLimitInfo;
  rateLimitObservedAt?: string;
  handoffs?: HandoffRecord[];
  // isResume → query() is launched with `resume` instead of
  // `sessionId`, telling the claude binary to load the session's
  // transcript from ~/.claude/projects/<dir>/<id>.jsonl and continue
  // from the last persisted message instead of starting fresh.
  isResume: boolean;
}

// buildLiveSession constructs the in-memory ChatSession + the SDK
// Query and registers them. Shared between createSession (fresh) and
// resumeSession (reanimated from disk). `session` must be built
// before query() because makeCanUseTool / makePlanMcp close over it.
function buildLiveSession(init: BuildLiveInit): ChatSession {
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const abortController = new AbortController();
  const emitter = new EventEmitter();
  // Lift the EventEmitter listener cap; multiple SSE subscribers + the
  // permission flow easily exceed the default 10. We unsubscribe on
  // disconnect so this isn't a leak.
  emitter.setMaxListeners(64);

  const session: ChatSession = {
    id: init.id,
    cwd: init.cwd,
    configDir: init.configDir,
    accountName: init.accountName,
    createdAt: init.createdAt,
    model: init.model,
    effort: init.effort,
    provider: init.provider,
    permissionMode: init.permissionMode,
    planId: init.planId,
    phaseSlug: init.phaseSlug,
    inputQueue,
    history: init.history,
    status: "starting",
    recentRequestIds: new Map(),
    emitter,
    abortController,
    latestUsage: init.latestUsage,
    latestContextUsage: init.latestContextUsage,
    latestPlan: init.latestPlan,
    alwaysAllowRules: [],
    rateLimit: init.rateLimit,
    rateLimitObservedAt: init.rateLimitObservedAt,
    handoffs: init.handoffs,
    query: undefined as unknown as Query, // assigned below
  };

  // Provider branch: a session that's already been handed off to
  // codex (provider==="codex" + at least one handoff record) doesn't
  // get a Claude SDK Query. Instead, install a stub query (close()
  // no-op so updateSessionOptions / shutdown paths don't crash) and
  // drive turns via the codex driver.
  if (
    init.provider === "codex" &&
    init.handoffs &&
    init.handoffs.length > 0
  ) {
    session.query = codexStubQuery();
    sessions.set(init.id, session);
    void driveCodexFromSession(session);
    return session;
  }

  attachSDKQuery(session, init.isResume);

  sessions.set(init.id, session);
  void driveSession(session);
  return session;
}

// codexStubQuery is the sentinel "I'm not a real SDK Query" object we
// install on codex-routed sessions. None of its methods should be
// called for a codex session in normal flow (driveCodexSession owns
// the loop; updateSessionOptions is gated; refreshContextUsage is
// also gated). Defensive no-ops here mean a stray call surfaces as a
// log line rather than a TypeError that takes the session down.
function codexStubQuery(): Query {
  const stub = {
    close: () => Promise.resolve(),
    interrupt: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    // Intentionally undefined — refreshContextUsage's `typeof
    // q.getContextUsage !== "function"` guard then skips the call,
    // no error log noise from the stub being prodded.
    getContextUsage: undefined,
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          Promise.resolve({ value: undefined as never, done: true as const }),
      };
    },
  };
  return stub as unknown as Query;
}

// driveCodexFromSession adapts the live ChatSession to the
// driveCodexSession contract. The bridges (pushHistory / emit /
// setStatus / recordUsage / isStillCurrent) keep the driver oblivious
// to ChatSession internals while still mutating the right object —
// schedulePersist fires on each history push so a daemon restart in
// the middle of a codex turn doesn't lose the latest delta.
function driveCodexFromSession(session: ChatSession): Promise<void> {
  const handoff = session.handoffs?.[session.handoffs.length - 1];
  if (!handoff) {
    setStatus(session, "errored");
    emit(session, {
      type: "error",
      data: { message: "codex session has no handoff record" },
    });
    return Promise.resolve();
  }
  const ownAbort = session.abortController;
  return driveCodexSession({
    id: session.id,
    cwd: session.cwd,
    history: session.history,
    handoff,
    // resolveModel is read fresh on EVERY turn so a mid-session
    // model hot-swap (composer picker on a codex session) takes
    // effect on the very next user message without a respawn.
    // Priority: session.model (live, mutable) → handoff record
    // (initial pick) → hardcoded fallback.
    resolveModel: () =>
      session.model || handoff.codex_model || "gpt-5.5",
    resolveEffort: () => session.effort,
    inputQueue: session.inputQueue,
    abortSignal: session.abortController.signal,
    pushHistory: (msg) => {
      if (session.history.length >= HISTORY_CAP) session.history.shift();
      session.history.push(msg);
      schedulePersist(session.id);
    },
    emit: (event) => emit(session, event),
    setStatus: (status) => setStatus(session, status),
    recordUsage: (usage) => {
      session.latestUsage = usage;
    },
    // Driver mutates handoff.codex_thread_id in place when codex emits
    // thread.started. We force a snapshot write so the id lands on disk
    // immediately — without this the persistence only happens on the
    // next history push, which is after the first turn's worth of
    // events. A daemon restart between thread.started and the first
    // pushHistory would otherwise lose the resume handle.
    recordThreadId: () => schedulePersist(session.id),
    // The session's still ours as long as nobody re-pointed its abort
    // controller. A future codex→codex respawn would mint a new
    // controller, the same way respawnQuery does on the claude side.
    isStillCurrent: () => session.abortController === ownAbort,
  });
}

// attachSDKQuery wires a fresh SDK Query onto an existing ChatSession.
// Reads provider/model/effort/cwd/configDir straight off the session
// so it can be reused for both initial spawn (buildLiveSession) and
// in-place respawn (provider switch via updateSessionOptions). The
// caller is responsible for ensuring session.inputQueue and
// session.abortController are fresh — leftover references from a
// previous spawn would have already been aborted/closed.
function attachSDKQuery(session: ChatSession, isResume: boolean): void {
  // SDK locates a native binary via optional deps; if those got
  // skipped during install we end up throwing "Native CLI binary
  // for darwin-arm64 not found" at first iteration. findClaudeBinary
  // returns the path of whatever `claude` is on PATH (or null if
  // there really is none, in which case the SDK's own error wins).
  const claudeBin = findClaudeBinary();

  // Provider routing. For OpenRouter, layer ANTHROPIC_BASE_URL +
  // ANTHROPIC_AUTH_TOKEN onto the env so the SDK's HTTP traffic goes
  // to OR instead of Anthropic. Falls back to native if the user
  // selected OR but the global config was wiped — better to spawn
  // against the active Anthropic account than to refuse outright,
  // and the missing env block surfaces in the very next API call as
  // a normal Anthropic auth response the user can read.
  const orConfig =
    session.provider === "openrouter" ? loadOpenRouterConfigSync() : undefined;
  // Pass the session's chosen model so OR's tier env vars resolve to
  // the user's pick. Without this the env block falls back to
  // config.default_model — fine for the binary's tier requests, but
  // the SDK's `model:` option overrides anyway, so the env vars matter
  // only for whichever request goes through the binary's tier-naming
  // path (rare but real).
  const providerEnv = orConfig ? openRouterEnv(orConfig, session.model) : {};

  // Snapshot DB MCP servers once — used both for the mcpServers spread
  // below AND for the DB_MCP_PRESENTATION_APPEND directive gating.
  // Re-reading from disk per use would risk drift between the two
  // (e.g. a connection added mid-construction would appear in one
  // place but not the other).
  const dbMcpEntries = getDbMcpEntries();

  session.query = query({
    prompt: session.inputQueue,
    options: {
      cwd: session.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: session.configDir,
        ...providerEnv,
      },
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      // Without this, the Agent SDK uses an empty/agent-flavored system
      // prompt and the session loses Claude Code's tone guidelines,
      // environment block (cwd/OS/git), tool tactics, and CLAUDE.md
      // dynamic injection — output drifts toward generic Claude. Opt
      // in to match the `claude` CLI.
      //
      // For owner/leader sessions (no phaseSlug → there is no parent
      // plan agent driving them) we append a triage instruction so the
      // model offers the user an explicit single-vs-multi-phase choice
      // before doing work. Phase sessions get a curated kickoff prompt
      // and shouldn't see this.
      systemPrompt: ((): { type: "preset"; preset: "claude_code"; append?: string } => {
        const parts: string[] = [];
        // DB rendering rule goes FIRST. The model gives strict
        // output rules better adherence when they appear before the
        // longer narrative blocks below.
        if (Object.keys(dbMcpEntries).length > 0) {
          parts.push(DB_MCP_PRESENTATION_APPEND);
        }
        if (!session.phaseSlug) parts.push(OWNER_TRIAGE_APPEND);
        const postHandoff = computePostHandoffPreamble(session);
        if (postHandoff) parts.push(postHandoff);
        const append = parts.join("\n\n");
        return append
          ? { type: "preset", preset: "claude_code", append }
          : { type: "preset", preset: "claude_code" };
      })(),
      permissionMode: session.permissionMode,
      // bypassPermissions ("Auto / Yolo" in the UI) requires the
      // session to be launched with this opt-in. Without it the SDK
      // refuses both the initial config and any later
      // setPermissionMode("bypassPermissions") call. We're a desktop
      // app for trusted local repos — match the CLI's
      // `--allow-dangerously-skip-permissions` flag.
      allowDangerouslySkipPermissions: true,
      canUseTool: makeCanUseTool(session),
      mcpServers: {
        [PLAN_MCP_SERVER_NAME]: makePlanMcp(session),
        // Notes server only registers for phase sessions; owner sessions
        // (no planId) skip it because there are no siblings to broadcast
        // to and the tools would be no-ops.
        ...(session.planId && session.phaseSlug
          ? { [NOTES_MCP_SERVER_NAME]: makeNotesMcp(session) }
          : {}),
        // Leader toolkit is the inverse: registers ONLY for owner
        // sessions (no phaseSlug). A phase agent doesn't need to query
        // its siblings' state — that's the planner's job, and giving
        // every phase the cross-phase read surface would dilute the
        // sibling-isolation discipline the kickoff prompt sets up.
        ...(session.phaseSlug
          ? {}
          : { [LEADER_MCP_SERVER_NAME]: makeLeaderMcp(session) }),
        // Postgres / ClickHouse read-only stanzas. Snapshot taken
        // once above (dbMcpEntries) so the directive that depends on
        // their presence reflects the same view. The helper returns {}
        // when no driver is configured or uvx is missing on this host.
        ...dbMcpEntries,
      },
      abortController: session.abortController,
      // Resume vs fresh: `resume` loads the session's transcript via
      // claude's own jsonl on disk; `sessionId` opens a fresh session
      // file with that id. The two are mutually exclusive in the SDK.
      ...(isResume ? { resume: session.id } : { sessionId: session.id }),
      // Stream Anthropic content_block_delta events through as
      // SDKPartialAssistantMessage (type: "stream_event"). Note: when
      // extended thinking is on (effort high/xhigh/max), the SDK
      // suppresses these and only ships the final assistant message.
      includePartialMessages: true,
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
    },
  });
}

// respawnQuery tears down the running SDK Query for a live session and
// stands up a fresh one against the session's CURRENT provider/model
// fields. Used by updateSessionOptions when the provider switches —
// the env vars that route traffic to OR vs Anthropic are baked into
// the spawned binary's process env, so a flip needs a full respawn.
//
// Preserves the ChatSession identity (and its emitter, recentRequestIds,
// alwaysAllowRules, history). SSE subscribers stay attached. The OLD
// driveSession loop's terminal branches compare session.query to the
// instance they were started with; mismatch (which we cause here by
// reassigning) makes them swallow the closed/errored flips instead of
// killing the session.
function respawnQuery(session: ChatSession): void {
  try {
    session.abortController.abort();
  } catch {
    // already-aborted controllers throw — swallow.
  }
  try {
    session.inputQueue.end();
  } catch {
    // already-ended queue — swallow.
  }
  try {
    session.query.close();
  } catch {
    // close() can throw on an already-closed query — ignore.
  }
  session.inputQueue = new AsyncQueue<SDKUserMessage>();
  session.abortController = new AbortController();
  // Resume from the on-disk jsonl so the new binary picks up the
  // conversation where the previous one left off — the user
  // shouldn't lose context just because they swapped providers.
  attachSDKQuery(session, true);
  setStatus(session, "starting");
  void driveSession(session);
}

export function createSession(opts: {
  cwd: string;
  configDir: string;
  accountName?: string;
  model?: string;
  effort?: EffortLevel;
  provider?: SessionProvider;
  permissionMode?: PermissionMode;
  planId?: string;
  phaseSlug?: string;
}): SessionSummary {
  const id = randomUUID();
  const session = buildLiveSession({
    id,
    cwd: opts.cwd,
    configDir: opts.configDir,
    accountName: opts.accountName,
    createdAt: new Date(),
    model: opts.model,
    effort: opts.effort,
    provider: opts.provider,
    permissionMode: opts.permissionMode ?? "default",
    planId: opts.planId,
    phaseSlug: opts.phaseSlug,
    history: [],
    isResume: false,
  });
  schedulePersist(id);
  return summarize(session);
}

// createCodexSession spawns a brand-new chat that talks directly to
// OpenAI Codex (ChatGPT-subscription) from the very first user
// message — bypasses the claude→codex handoff entirely. The codex
// driver requires at least one HandoffRecord per session (it reads
// codex_config_dir + codex_model off it), so we synthesize a sentinel
// record with empty summary + at_message_index = -1; buildInstructions
// detects that pair and switches to a "fresh codex chat" preamble
// instead of the "handed off from claude" one.
//
// Validates auth before creating the session so a missing/expired
// refresh token surfaces as a 422 from the caller route, not as a
// dead session in the sidebar.
export async function createCodexSession(opts: {
  cwd: string;
  codex_config_dir: string;
  codex_account_name?: string;
  codex_model?: string;
  effort?: EffortLevel;
  planId?: string;
  phaseSlug?: string;
}): Promise<SessionSummary> {
  await resolveCodexAuth(opts.codex_config_dir);
  const id = randomUUID();
  const model = opts.codex_model || "gpt-5.5";
  const handoff: HandoffRecord = {
    at_message_index: -1,
    from_provider: "anthropic",
    to_provider: "codex",
    summary: "",
    at: new Date().toISOString(),
    codex_config_dir: opts.codex_config_dir,
    codex_account_name: opts.codex_account_name,
    codex_model: model,
  };
  const session = buildLiveSession({
    id,
    cwd: opts.cwd,
    // Codex sessions don't bind to a claude account, but ChatSession
    // typing requires configDir. We use the codex config dir as a
    // best-effort tag; the SDK Query never instantiates here so the
    // value is never read for routing.
    configDir: opts.codex_config_dir,
    accountName: opts.codex_account_name,
    createdAt: new Date(),
    model,
    effort: opts.effort,
    provider: "codex",
    permissionMode: "default",
    planId: opts.planId,
    phaseSlug: opts.phaseSlug,
    history: [],
    handoffs: [handoff],
    isResume: false,
  });
  schedulePersist(id);
  return summarize(session);
}

// registerImportedSession slots a session built outside the orchestrator
// (e.g. parsed from a Claude Code CLI jsonl by cli-import.ts) into the
// interrupted-shadow map without spawning a Query. The session is
// listed in the sidebar immediately; the SDK gets fired up only when
// the user actually opens the tab — at which point getOrResume promotes
// it via SDK `resume: <id>` and the binary loads the transcript from
// ~/.claude/projects/<encoded-cwd>/<id>.jsonl on its own.
//
// Returns false when a session with the same id is already registered
// (live or shadow); the caller decides whether that's an error or a
// no-op. Persisted snapshot is written by cli-import.ts before this
// call so a daemon restart picks the import back up via initFromDisk().
export function registerImportedSession(stored: {
  id: string;
  cwd: string;
  config_dir: string;
  account_name?: string;
  created_at: string;
  model?: string;
  permission_mode: PermissionMode;
  history: SDKMessage[];
}): boolean {
  if (sessions.has(stored.id) || interruptedSessions.has(stored.id)) {
    return false;
  }
  interruptedSessions.set(stored.id, {
    id: stored.id,
    cwd: stored.cwd,
    configDir: stored.config_dir,
    accountName: stored.account_name,
    createdAt: new Date(stored.created_at),
    model: stored.model,
    permissionMode: stored.permission_mode,
    history: stored.history,
  });
  return true;
}

// resumeSession promotes an InterruptedSession (loaded from disk on
// startup) to a live ChatSession by re-spawning the SDK Query in
// `resume` mode. We reuse the in-memory history so the chat panel
// doesn't blink while the SDK reloads its own jsonl transcript for
// context. The shadow entry is removed once the live session is
// registered so subsequent lookups hit the live map directly.
function resumeSession(stored: InterruptedSession): ChatSession {
  const session = buildLiveSession({
    id: stored.id,
    cwd: stored.cwd,
    configDir: stored.configDir,
    accountName: stored.accountName,
    createdAt: stored.createdAt,
    model: stored.model,
    effort: stored.effort,
    provider: stored.provider,
    permissionMode: stored.permissionMode,
    planId: stored.planId,
    phaseSlug: stored.phaseSlug,
    history: stored.history,
    latestUsage: stored.latestUsage,
    latestContextUsage: stored.latestContextUsage,
    latestPlan: stored.latestPlan,
    rateLimit: stored.rateLimit,
    rateLimitObservedAt: stored.rateLimitObservedAt,
    handoffs: stored.handoffs,
    isResume: true,
  });
  interruptedSessions.delete(stored.id);
  return session;
}

// getOrResume returns the live ChatSession, materializing it from the
// interrupted shadow on first access. Callers that need a live SDK
// Query (sendMessage, subscribe, updateSessionOptions) should go
// through this; callers that only need metadata (listSessions,
// snapshotSession) read from both maps without forcing a spawn.
function getOrResume(id: string): ChatSession | undefined {
  const live = sessions.get(id);
  if (live) return live;
  const stored = interruptedSessions.get(id);
  if (!stored) return undefined;
  return resumeSession(stored);
}

async function driveSession(session: ChatSession): Promise<void> {
  // Capture the SDK Query we were started against. respawnQuery
  // (provider switch) tears this query down and assigns a new one to
  // session.query, then kicks off a fresh driveSession for it. When
  // the abort propagates through the OLD iterator and lands us in the
  // terminal branches below, we compare against this captured ref to
  // tell "real shutdown" from "stale instance after respawn" — the
  // latter must not flip status to closed/errored.
  const ownQuery = session.query;
  try {
    // The SDK Query iterator is constructed synchronously in
    // buildLiveSession but only starts producing messages once a user
    // message lands in the input queue. Sitting on "starting" until
    // then leaves the sidebar forever spinning the sky-blue loader for
    // a /clear-created chat that's actually just waiting for the user
    // to type. Flip to "idle" the moment the loop is live; sendMessage
    // (which flips to "thinking") races us harmlessly because both
    // setStatus calls are no-ops when the target state already matches.
    if (session.status === "starting") {
      setStatus(session, "idle");
    }
    for await (const msg of ownQuery) {
      // stream_event messages are token deltas — we push them through
      // SSE so live clients can render incremental text, but we do NOT
      // persist them in `history`. Replay on reconnect would bloat the
      // wire and re-trigger animation; the final `assistant` message
      // already carries the complete content.
      if (msg.type !== "stream_event") {
        if (session.history.length >= HISTORY_CAP) session.history.shift();
        session.history.push(msg);
        // History grew — flag for the next debounced disk flush. The
        // setStatus calls below also schedule, so during a normal turn
        // the timer just keeps resetting until the turn settles.
        schedulePersist(session.id);
      }
      emit(session, { type: "message", data: msg });

      // Snapshot per-API-call usage from each top-level assistant
      // message. Subagent (Task) assistant messages have a non-null
      // parent_tool_use_id and run inside their own context window, so
      // their usage must not override the main session's display.
      if (
        msg.type === "assistant" &&
        !(msg as { parent_tool_use_id?: string | null }).parent_tool_use_id
      ) {
        const u = (msg as { message?: { usage?: Partial<SessionUsage> } })
          .message?.usage;
        if (u) {
          session.latestUsage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          };
        }
      }

      // The SDK signals end-of-turn with a `result` message. Move back
      // to "idle" so the UI knows it can prompt for another turn, and
      // pull a fresh authoritative context-usage breakdown via the
      // control channel (fire-and-forget — UI gets it via SSE).
      if (msg.type === "result") {
        setStatus(session, "idle");
        void refreshContextUsage(session);
      } else if (msg.type === "rate_limit_event") {
        // SDK auto-retries internally up to CLAUDE_CODE_MAX_RETRIES;
        // we observe so the UI can render a countdown. We DON'T
        // pause input or change the abort signal — that would compete
        // with the SDK's own retry. Status flip is purely informational
        // and reverts on the next assistant/stream_event.
        handleRateLimitEvent(session, msg);
      } else if (
        (msg.type === "assistant" || msg.type === "stream_event") &&
        (session.status === "starting" ||
          session.status === "idle" ||
          session.status === "rate_limited")
      ) {
        // Real model output is starting — Claude is working. Earlier
        // we flipped on *any* non-result message, but the SDK also
        // ships `system` control messages for things like
        // setPermissionMode acknowledgements; flipping on those left
        // the session stuck on "thinking" after a mode change with
        // no actual turn in flight.
        // Including "rate_limited" here lets the SDK's successful
        // internal retry naturally clear the badge state when output
        // resumes.
        setStatus(session, "thinking");
      }
    }
    if (session.query !== ownQuery) {
      // Provider switch tore down our query and started a fresh
      // driveSession on a new one — leave the session alive.
      return;
    }
    setStatus(session, "closed");
    emit(session, { type: "closed", data: {} });
  } catch (err) {
    if (session.query !== ownQuery) {
      // Same logic as the natural-end branch: an abort during a
      // provider switch must not surface as a session error.
      return;
    }
    setStatus(session, "errored");
    emit(session, {
      type: "error",
      data: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

export function getSession(id: string): ChatSession | undefined {
  return sessions.get(id);
}

// summarizeInterrupted mirrors `summarize` for shadow sessions. Status
// is fixed to "interrupted" so the sidebar can render a distinct chip;
// subagents are derived from the persisted history just like for live
// sessions, since deriveSubagents only walks SDKMessage[] state.
function summarizeInterrupted(s: InterruptedSession): SessionSummary {
  const subagents = deriveSubagents(s.history).list;
  return {
    id: s.id,
    cwd: s.cwd,
    config_dir: s.configDir,
    account_name: s.accountName,
    status: "interrupted",
    created_at: s.createdAt.toISOString(),
    history_length: s.history.length,
    title: firstUserText(s.history),
    model: s.model,
    effort: s.effort,
    provider: s.provider,
    permission_mode: s.permissionMode,
    usage: s.latestUsage,
    context_usage: s.latestContextUsage,
    subagents: subagents.length > 0 ? subagents : undefined,
    plan_id: s.planId,
    phase_slug: s.phaseSlug,
    rate_limit: s.rateLimit,
    rate_limit_observed_at: s.rateLimitObservedAt,
    handoffs: s.handoffs && s.handoffs.length > 0 ? s.handoffs : undefined,
  };
}

export function listSessions(): SessionSummary[] {
  // Merge live + interrupted under one timeline. createdAt is the
  // original session creation time (preserved across persist/load), so
  // sorting still reflects "which chat did I start most recently?"
  // even if some are alive and some are still on disk.
  const live = Array.from(sessions.values()).map((s) => ({
    createdAt: s.createdAt,
    summary: summarize(s),
  }));
  const dead = Array.from(interruptedSessions.values()).map((s) => ({
    createdAt: s.createdAt,
    summary: summarizeInterrupted(s),
  }));
  return [...live, ...dead]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((entry) => entry.summary);
}

export function snapshotSession(id: string): SessionSnapshot | undefined {
  const s = sessions.get(id);
  if (s) {
    return {
      summary: summarize(s),
      history: s.history,
      pending_permission: s.pendingPermission?.request,
      pending_question: s.pendingQuestion?.request,
      latest_plan: s.latestPlan,
    };
  }
  // Interrupted: serve metadata + history from disk so the chat panel
  // can render the transcript without spawning a Query. The first time
  // the user actually interacts (sendMessage / SSE subscribe / option
  // change) we materialize via getOrResume; this read path is purely
  // observational and stays cheap.
  const stored = interruptedSessions.get(id);
  if (!stored) return undefined;
  return {
    summary: summarizeInterrupted(stored),
    history: stored.history,
    // pending_permission / pending_question carry resolve callbacks
    // that don't survive a restart — there's nothing to dispatch even
    // if we surfaced them, so we drop them on load.
    latest_plan: stored.latestPlan,
  };
}

export function getLatestPlan(sessionId: string): PlanRecord | undefined {
  return (
    sessions.get(sessionId)?.latestPlan ??
    interruptedSessions.get(sessionId)?.latestPlan
  );
}

export function setLatestPlan(sessionId: string, plan: PlanRecord): void {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  s.latestPlan = plan;
  schedulePersist(sessionId);
}

export function emitPlanEvent(
  sessionId: string,
  type: "plan_approved" | "plan_failed",
  plan: PlanRecord,
): void {
  // Plan events fire after the user clicks approve/reject in the UI,
  // which always implies a live session is needed for the SDK to
  // continue the turn — so resume if necessary.
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  emit(s, { type, data: plan });
}

const REQUEST_DEDUPE_TTL_MS = 30_000;

// Drop any cached id older than the TTL. Cheap to call before each
// dedupe lookup; the map stays bounded because expirations sweep here.
function pruneRecentIds(s: ChatSession, now: number): void {
  for (const [id, exp] of s.recentRequestIds) {
    if (exp <= now) s.recentRequestIds.delete(id);
  }
}

export function sendMessage(
  sessionId: string,
  text: string,
  attachments?: Attachment[],
  clientRequestId?: string,
): { sent: boolean; deduped: boolean } {
  // getOrResume reanimates the session via SDK `resume` on the fly if
  // it was loaded from disk after a restart. The user shouldn't have
  // to "re-open" the chat — typing into the composer should Just Work.
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  if (clientRequestId) {
    // Sessions created before this field existed (HMR survivors)
    // arrive here with `recentRequestIds === undefined`. Initialise
    // on demand so the iteration in pruneRecentIds doesn't throw.
    if (!s.recentRequestIds) s.recentRequestIds = new Map();
    const now = Date.now();
    pruneRecentIds(s, now);
    if (s.recentRequestIds.has(clientRequestId)) {
      // Same id within the TTL — silently treat as a no-op so the
      // duplicate response still resolves 200 on the client without
      // pushing a duplicate user message into history.
      return { sent: false, deduped: true };
    }
    s.recentRequestIds.set(clientRequestId, now + REQUEST_DEDUPE_TTL_MS);
  }
  // The SDK consumes user messages from the input queue but does NOT
  // echo them back through the Query iterator (verified empirically),
  // so we synthesize a history entry here. uuid + emit make the wire
  // shape indistinguishable from an SDK-emitted message.
  const uuid = randomUUID();
  const content = buildUserContent(text, attachments);
  const msg: SDKUserMessage = {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
  s.inputQueue.push(msg);
  if (s.history.length >= HISTORY_CAP) s.history.shift();
  s.history.push(msg);
  emit(s, { type: "message", data: msg });
  setStatus(s, "thinking");
  return { sent: true, deduped: false };
}

// editQueuedMessage rewrites a user message that the SDK queue still
// holds (i.e. the SDK iterator hasn't pulled it yet). Once a message
// is in flight we can't edit it without aborting the turn, so this
// returns `edited: false` and the route hands back 409 Conflict.
//
// Both inputQueue and history are updated to point at a fresh
// SDKUserMessage with the SAME uuid — the uuid is what the live UI
// keys off, so reusing it lets the client patch its history slot in
// place rather than appending a new entry.
export function editQueuedMessage(
  sessionId: string,
  uuid: string,
  text: string,
  attachments?: Attachment[],
): { edited: boolean; reason?: "not_queued" | "session_missing" } {
  const s = sessions.get(sessionId);
  if (!s) return { edited: false, reason: "session_missing" };
  const idx = s.inputQueue.findIndex(
    (m) => (m as { uuid?: string }).uuid === uuid,
  );
  if (idx < 0) return { edited: false, reason: "not_queued" };
  // The SDK types narrow `uuid` to a UUID template-literal string;
  // our route param comes through as plain `string`, so we cast at
  // the boundary. The runtime check above (idx >= 0) confirms the
  // uuid actually identifies a real message, so the value is well-
  // formed in practice.
  const next: SDKUserMessage = {
    type: "user",
    uuid: uuid as SDKUserMessage["uuid"],
    session_id: sessionId,
    message: { role: "user", content: buildUserContent(text, attachments) },
    parent_tool_use_id: null,
  };
  s.inputQueue.replaceAt(idx, next);
  // Mirror the change in history. Walk from the end since queued
  // messages are always near the tail; cheaper than scanning the full
  // 1000-message cap when an early prompt happens to share the uuid
  // shape (it shouldn't, but defense in depth).
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if ((m as { uuid?: string }).uuid === uuid) {
      s.history[i] = next;
      break;
    }
  }
  emit(s, { type: "queue_edited", data: next });
  schedulePersist(s.id);
  return { edited: true };
}

// cancelQueuedMessage yanks a queued user message back from the SDK
// queue and drops it from history. Same constraint as editQueuedMessage
// — once the SDK pulls it, we can't take it back without an interrupt,
// so the route reports 409 Conflict.
export function cancelQueuedMessage(
  sessionId: string,
  uuid: string,
): { cancelled: boolean; reason?: "not_queued" | "session_missing" } {
  const s = sessions.get(sessionId);
  if (!s) return { cancelled: false, reason: "session_missing" };
  const idx = s.inputQueue.findIndex(
    (m) => (m as { uuid?: string }).uuid === uuid,
  );
  if (idx < 0) return { cancelled: false, reason: "not_queued" };
  s.inputQueue.removeAt(idx);
  for (let i = s.history.length - 1; i >= 0; i--) {
    const m = s.history[i];
    if ((m as { uuid?: string }).uuid === uuid) {
      s.history.splice(i, 1);
      break;
    }
  }
  emit(s, { type: "queue_cancelled", data: { uuid } });
  schedulePersist(s.id);
  return { cancelled: true };
}

export function resolvePermission(
  sessionId: string,
  permissionId: string,
  decision: PermissionDecision,
): void {
  const s = sessions.get(sessionId);
  if (!s?.pendingPermission || s.pendingPermission.request.id !== permissionId) {
    throw new Error("no pending permission with that id");
  }
  // Translate snake_case wire shape to the SDK's camelCase PermissionResult.
  // The SDK's TS type marks `updatedInput` as optional, but the native
  // claude binary on the other side of the control channel runs a strict
  // Zod schema that requires `updatedInput` as a record on the "allow"
  // branch. The bundled `assistant.mjs` also unconditionally spreads
  // `updatedInput` into the response, so an `{ behavior: "allow" }` with
  // no key gets serialized as `{ behavior: "allow", updatedInput: undefined }`
  // and rejected. Echo the original input back when the user just approves
  // without modifying it — that's the documented canonical shape.
  let result: PermissionResult;
  if (decision.behavior === "allow") {
    // "Always allow" round-trips the SDK's own suggestions back as
    // updatedPermissions. The SDK applies them across whatever
    // destinations it suggested (typically session + project rules);
    // it then SHOULD short-circuit future canUseTool calls that match.
    // In practice this round-trip isn't always honored, so we ALSO
    // cache the rules locally — see rememberAlwaysAllow + the
    // matchesAlwaysAllow short-circuit at the top of canUseTool.
    const stored = s.pendingPermission.suggestions ?? [];
    const includeSuggestions = decision.always_allow === true && stored.length > 0;
    if (includeSuggestions) {
      const added = rememberAlwaysAllow(s, stored);
      console.log(
        `[permission] always-allow cached ${added} rule(s) for session ${sessionId}`,
      );
    }
    result = {
      behavior: "allow",
      updatedInput: decision.updated_input ?? s.pendingPermission.request.input,
      ...(includeSuggestions ? { updatedPermissions: stored } : {}),
    };
  } else {
    result = { behavior: "deny", message: decision.message };
  }
  s.pendingPermission.resolve(result);

  // The resolver clears pendingPermission and emits permission_resolved
  // synchronously. Flip status back to "thinking" right away — the SDK
  // is now resuming work (running the tool, or threading the deny
  // message back to the model). driveSession's existing
  // assistant/stream_event handler does NOT auto-flip from
  // "awaiting_permission" (it only covers starting/idle), so without
  // this nudge the sidebar would stay stuck until the next `result`.
  setStatus(s, "thinking");
}

// resolveAskUserQuestion ships the user's answers back to the SDK in
// the canonical shape: {questions, answers: {[questionText]: label}}.
// The SDK reads this from updatedInput and synthesizes the tool result
// (no actual tool execution happens). Pass an empty answers map for
// "cancelled" — we still allow the tool so the agent isn't stuck, but
// the model sees no answers and can decide what to do.
export function resolveAskUserQuestion(
  sessionId: string,
  requestId: string,
  answers: AskUserQuestionAnswers,
): void {
  const s = sessions.get(sessionId);
  if (!s?.pendingQuestion || s.pendingQuestion.request.id !== requestId) {
    throw new Error("no pending question with that id");
  }
  s.pendingQuestion.resolve({
    behavior: "allow",
    updatedInput: {
      questions: s.pendingQuestion.questions,
      answers,
    },
  });
  // Same status nudge as resolvePermission: driveSession won't auto-
  // flip from "awaiting_permission" on the next assistant message, so
  // do it explicitly here. The model is now processing the answers.
  setStatus(s, "thinking");
}

export function cancelAskUserQuestion(
  sessionId: string,
  requestId: string,
  message: string,
): void {
  const s = sessions.get(sessionId);
  if (!s?.pendingQuestion || s.pendingQuestion.request.id !== requestId) {
    throw new Error("no pending question with that id");
  }
  s.pendingQuestion.resolve({
    behavior: "deny",
    message: message || "user cancelled the question",
  });
  setStatus(s, "thinking");
}

// updateSessionOptions mutates a running Query's model and/or effort
// in place via the SDK's setModel + applyFlagSettings helpers. Both
// require streaming-input mode (we always use AsyncQueue, so we're
// fine). Errors propagate so the route handler can surface them.
//
// Auto-resumes an interrupted session: the user changing model on a
// chat they reopened after a restart should "just work" rather than
// throw "session not found".
//
// Provider switch (anthropic ↔ openrouter) needs a respawn — the SDK
// reads ANTHROPIC_BASE_URL/AUTH_TOKEN from the spawned binary's env,
// which is baked in at query() construction. We tear down the running
// query, rebuild on the same ChatSession object, and resume the
// transcript from disk — emitter / history / SSE subscribers stay
// pointed at the same session so the user doesn't notice the
// reconnect except for a brief "starting" flicker.
export async function updateSessionOptions(
  sessionId: string,
  opts: {
    model?: string;
    effort?: EffortLevel;
    permissionMode?: PermissionMode;
    provider?: SessionProvider;
  },
): Promise<SessionSummary> {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  // Codex isn't reachable via the generic provider-switch path because
  // it needs a handoff summary turn first. Route the caller to
  // handoffToCodex instead.
  if (opts.provider === "codex") {
    throw new Error(
      "switching to codex requires POST /api/chat/<id>/handoff (handoff summary turn)",
    );
  }
  // Codex sessions hot-swap models in place — the next turn picks up
  // the new id when codex-driver reads session.model. Other knobs
  // (effort, permission_mode, provider) aren't honored on codex
  // sessions: codex doesn't expose effort the same way, codex turns
  // can't call tools so permission_mode is moot, and switching
  // provider away from codex needs a reverse handoff (out of scope).
  if (s.provider === "codex") {
    // opts.provider === "codex" was rejected above; anything else
    // here (anthropic / openrouter) is a reverse-handoff request.
    if (opts.provider) {
      throw new Error(
        "reverse handoff (codex → claude) is not supported yet",
      );
    }
    if (opts.model && opts.model !== s.model) {
      s.model = opts.model;
      // No respawn needed — codex-driver re-reads session.model at
      // the top of every turn. Persist so a daemon restart resumes
      // with the new model.
      schedulePersist(s.id);
    }
    if (opts.effort && opts.effort !== s.effort) {
      s.effort = opts.effort;
      schedulePersist(s.id);
    }
    return summarize(s);
  }
  // Provider change first — it respawns the SDK Query, after which the
  // new query takes the rest of the patch (model/effort/permissionMode)
  // straight via attachSDKQuery's options. Subsequent setModel /
  // applyFlagSettings calls would race the still-spawning binary; we
  // skip them when we already respawned with the right settings.
  const providerChanged = opts.provider && opts.provider !== s.provider;
  if (providerChanged) {
    if (opts.model) s.model = opts.model;
    if (opts.effort) s.effort = opts.effort;
    if (opts.permissionMode) s.permissionMode = opts.permissionMode;
    s.provider = opts.provider;
    respawnQuery(s);
    schedulePersist(s.id);
    return summarize(s);
  }
  if (opts.model && opts.model !== s.model) {
    await s.query.setModel(opts.model);
    s.model = opts.model;
  }
  if (opts.effort && opts.effort !== s.effort) {
    // Settings flag layer key is `effortLevel` (per SDK Settings type) —
    // NOT `effort`. `effort` is a top-level Options key for query() init;
    // applyFlagSettings merges into Settings, so passing `effort` here
    // silently no-ops (mapped-type signature doesn't reject excess keys).
    //
    // Settings.effortLevel's typed union excludes "max" even though the
    // wider EffortLevel/Options.effort includes it. The SDK appears to
    // accept "max" at runtime (it's a valid effort level model-side), so
    // we cast through `EffortLevel` rather than clamp to xhigh and lose
    // the user's choice.
    await s.query.applyFlagSettings({
      effortLevel: opts.effort as Exclude<EffortLevel, "max">,
    });
    s.effort = opts.effort;
  }
  if (opts.permissionMode && opts.permissionMode !== s.permissionMode) {
    // setPermissionMode applies immediately to the next tool call.
    // Plan/acceptEdits change canUseTool decision flow; bypassPermissions
    // turns canUseTool off entirely on the SDK side.
    await s.query.setPermissionMode(opts.permissionMode);
    s.permissionMode = opts.permissionMode;
  }
  return summarize(s);
}

// HANDOFF_PROMPT is the magic user message we feed claude to elicit
// a self-contained brief codex can pick up from. We deliberately
// don't hide it from the transcript — the user should see what was
// handed over, and the boundary card rendered AFTER this turn marks
// the divide. Length cap is empirical: under ~600 words covers most
// in-progress coding sessions while staying well under codex's
// instructions ceiling.
const HANDOFF_PROMPT = `[Orchestrator: handoff to codex]

A different model (OpenAI Codex via ChatGPT subscription) will continue this conversation after your next response. Codex will see ONLY your reply, not the prior transcript — it can't read Anthropic-format messages or replay tool calls. Write a self-contained brief so codex picks up seamlessly.

Wrap the brief in <handoff-summary>...</handoff-summary> tags. Cover:
1. What the user is trying to accomplish (the overarching task).
2. What you've already done — files touched, decisions made, findings, important code locations (with file:line refs where useful).
3. Current state — where the work sits right this moment.
4. Next step — what should happen on the next user message.
5. Open questions or constraints codex needs to know.

Keep the brief under 600 words. After the closing tag, write a single line confirming the handoff is ready. Do not call any tools in this turn — text only.`;

// REVERSE_HANDOFF_PROMPT is the symmetric prompt we feed CODEX when
// the user wants to hand control back to Claude. Same shape as
// HANDOFF_PROMPT — codex writes a self-contained <handoff-summary>
// — but framed for the opposite direction: codex narrates what it
// did during its turn(s) so claude can resume with full context.
const REVERSE_HANDOFF_PROMPT = `[Orchestrator: handoff back to claude]

The user wants Anthropic Claude to continue this conversation after your next reply. Claude will see ONLY your summary, not the codex-side transcript — it can't replay the codex thread on its own. Write a self-contained brief so claude resumes seamlessly.

Wrap the brief in <handoff-summary>...</handoff-summary> tags. Cover:
1. What you (codex) worked on during this segment — files touched, commands run, findings, decisions made (with file:line refs where useful).
2. Current state — where the work sits right this moment.
3. Next step — what should happen on the next user message.
4. Open questions or constraints claude needs to know.

Keep the brief under 600 words. After the closing tag, write a single line confirming the handoff is ready. Do not call any tools in this turn — text only.`;

// computePostHandoffPreamble returns the system-prompt append text we
// layer onto claude when the most recent handoff record routed the
// session from codex back to anthropic (or openrouter). Claude's own
// jsonl transcript is frozen at the original claude→codex moment, so
// without this preamble the resumed claude session is unaware of
// anything codex did. We inject the summary as part of the system
// prompt every time attachSDKQuery fires — the codex segment is
// permanently missing from claude's disk transcript, so the summary
// has to ride along on every claude respawn for as long as the
// session lives.
function computePostHandoffPreamble(session: ChatSession): string | undefined {
  const handoffs = session.handoffs ?? [];
  if (handoffs.length === 0) return undefined;
  const last = handoffs[handoffs.length - 1];
  if (last.from_provider !== "codex") return undefined;
  if (last.to_provider === "codex") return undefined;
  const summary = (last.summary || "").trim();
  if (!summary) return undefined;
  return `## Resumed after a Codex handoff

You're picking this chat back up from OpenAI Codex, who was driving it for a stretch. Codex doesn't share an Anthropic-format transcript, so your on-disk jsonl skips the codex segment entirely — treat the brief below as a /resume preamble for everything that happened while you were paused.

${summary}`;
}

// handoffToCodex is the entry point the /api/chat/<id>/handoff route
// hits. Flow:
//
//  1. Validate the codex slot (auth.json present, refresh works).
//  2. Push HANDOFF_PROMPT through the live claude session so the
//     model writes a self-contained brief in-transcript.
//  3. Wait for the matching `result` SDK message via the emitter.
//     Extract the <handoff-summary> body — fall back to the full
//     result text if the model forgot the tag.
//  4. Append a HandoffRecord, flip provider to "codex", model to
//     opts.codex_model (default gpt-5.5), persist, tear down
//     the claude Query, and respawn under driveCodexFromSession.
//  5. Emit a `handoff` ChatEvent so the chat panel can drop a
//     boundary card.
//
// On failure between (1) and (4), the session stays on claude — the
// only side effect is the visible summary turn in the transcript.
// We surface the error to the caller (route returns 422) and leave
// it to the user to retry.
export async function handoffToCodex(
  sessionId: string,
  opts: {
    codex_config_dir: string;
    codex_account_name?: string;
    codex_model?: string;
  },
): Promise<HandoffRecord> {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  if (s.provider === "codex") {
    throw new Error("session is already routed through codex");
  }
  if (s.handoffInFlight) {
    throw new Error("handoff already in flight");
  }
  // Probe codex auth FIRST so a missing/expired refresh token surfaces
  // before we spend a claude turn on the summary. resolveCodexAuth
  // refreshes proactively, so a successful probe means the very next
  // codex turn will have a valid bearer.
  await resolveCodexAuth(opts.codex_config_dir);

  s.handoffInFlight = true;

  // Listen for the next `result` SDK message so we know when claude
  // finishes the summary turn. We snapshot the response text from
  // either the assistant message content (preferred — preserves
  // formatting) or the result.result string (fallback).
  const summaryPromise = waitForNextResult(s);
  sendMessage(sessionId, HANDOFF_PROMPT);

  let summaryText: string;
  try {
    summaryText = await summaryPromise;
  } finally {
    s.handoffInFlight = false;
  }

  // Extract <handoff-summary>...</handoff-summary> body when present.
  // Some models drop the tags on shorter contexts; in that case we
  // keep the full text — codex gets slightly more noise but doesn't
  // lose information.
  const tagMatch = summaryText.match(
    /<handoff-summary>([\s\S]*?)<\/handoff-summary>/i,
  );
  const summary = (tagMatch ? tagMatch[1] : summaryText).trim();

  const handoff: HandoffRecord = {
    at_message_index: Math.max(s.history.length - 1, 0),
    from_provider: s.provider ?? "anthropic",
    to_provider: "codex",
    summary,
    at: new Date().toISOString(),
    codex_config_dir: opts.codex_config_dir,
    codex_account_name: opts.codex_account_name,
    codex_model: opts.codex_model || "gpt-5.5",
  };
  s.handoffs = [...(s.handoffs ?? []), handoff];
  s.provider = "codex";
  s.model = handoff.codex_model;
  schedulePersist(s.id);

  respawnAsCodex(s);
  emit(s, { type: "handoff", data: handoff });
  return handoff;
}

// waitForNextResult subscribes to the session's emitter and resolves
// on the first `result` SDK message that arrives. Used by handoff to
// know when the summary turn settled. We extract text in order:
//
//  1. The assistant message immediately preceding the result (richer
//     content — multiple text blocks, etc.).
//  2. result.result string (fallback when the SDK consolidates the
//     turn's text there).
function waitForNextResult(s: ChatSession): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let lastAssistantText = "";
    const onEvent = (event: ChatEvent) => {
      if (event.type === "error") {
        s.emitter.off("event", onEvent);
        reject(
          new Error(
            (event.data as { message?: string }).message ?? "unknown error",
          ),
        );
        return;
      }
      if (event.type !== "message") return;
      const msg = event.data as SDKMessage & {
        message?: { content?: Array<{ type: string; text?: string }> };
        result?: string;
        parent_tool_use_id?: string | null;
      };
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        const blocks = msg.message?.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter(
              (b): b is { type: "text"; text: string } =>
                b.type === "text" && typeof b.text === "string",
            )
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) lastAssistantText = text;
        }
      } else if (msg.type === "result") {
        s.emitter.off("event", onEvent);
        const fallback = typeof msg.result === "string" ? msg.result : "";
        resolve(lastAssistantText || fallback);
      }
    };
    s.emitter.on("event", onEvent);
  });
}

// respawnAsCodex tears down the SDK Query and stands up the codex
// driver on the same ChatSession. Parallel to respawnQuery (claude
// side) — same lifecycle, different driver. The history array is
// preserved verbatim so the user keeps the full pre-handoff
// transcript.
function respawnAsCodex(session: ChatSession): void {
  try {
    session.abortController.abort();
  } catch {
    // already-aborted controller — swallow.
  }
  try {
    session.inputQueue.end();
  } catch {
    // already-ended queue — swallow.
  }
  try {
    session.query.close();
  } catch {
    // claude binary may already be exiting — ignore.
  }
  session.inputQueue = new AsyncQueue<SDKUserMessage>();
  session.abortController = new AbortController();
  session.query = codexStubQuery();
  setStatus(session, "starting");
  void driveCodexFromSession(session);
}

// handoffFromCodex is the inverse of handoffToCodex: the user has a
// codex-routed session and wants claude (native or via OpenRouter) to
// take over again. We drive codex once more to produce a self-contained
// summary, then tear down the codex driver and respawn under the
// claude SDK Query. claude's own jsonl is still frozen at the original
// claude→codex moment, so attachSDKQuery layers the new summary into
// claude's systemPrompt.append via computePostHandoffPreamble — that
// keeps claude aware of what codex did despite the disk transcript
// gap.
//
// Flow mirrors handoffToCodex:
//   1. Validate session is codex-routed and not mid-handoff.
//   2. Subscribe to next `result` SDK message via waitForNextResult.
//   3. Push REVERSE_HANDOFF_PROMPT through the live codex session so
//      codex writes the brief in-transcript.
//   4. Extract <handoff-summary> body (fallback: full text).
//   5. Append a reverse HandoffRecord, flip provider/model, persist.
//   6. Tear down codex driver and respawn under driveSession.
//   7. Emit `handoff` ChatEvent so the chat panel can drop a boundary
//      card on the codex→claude divide.
export async function handoffFromCodex(
  sessionId: string,
  opts: {
    // Target claude model id (e.g. "claude-opus-4-7[1m]"). Required so
    // the resumed claude session knows what to spawn against.
    model: string;
    // Target provider — defaults to "anthropic". "openrouter" routes
    // through the saved OR config (ANTHROPIC_BASE_URL/AUTH_TOKEN env)
    // exactly like a regular OR session.
    provider?: SessionProvider;
  },
): Promise<HandoffRecord> {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  if (s.provider !== "codex") {
    throw new Error("session is not routed through codex");
  }
  if (s.handoffInFlight) {
    throw new Error("handoff already in flight");
  }
  if (!opts.model || typeof opts.model !== "string") {
    throw new Error("target claude model is required");
  }
  const targetProvider: SessionProvider = opts.provider ?? "anthropic";
  if (targetProvider === "codex") {
    throw new Error("reverse handoff target must be anthropic or openrouter");
  }

  s.handoffInFlight = true;

  const summaryPromise = waitForNextResult(s);
  sendMessage(sessionId, REVERSE_HANDOFF_PROMPT);

  let summaryText: string;
  try {
    summaryText = await summaryPromise;
  } finally {
    s.handoffInFlight = false;
  }

  const tagMatch = summaryText.match(
    /<handoff-summary>([\s\S]*?)<\/handoff-summary>/i,
  );
  const summary = (tagMatch ? tagMatch[1] : summaryText).trim();

  // Carry forward the source codex slot's identity (config dir / account
  // / model / thread id) so the boundary card can show "left codex
  // (acct/model)" and so a future forward handoff back to codex could
  // reuse the same thread. The destination claude model lives on
  // session.model post-flip.
  const priorForward = [...(s.handoffs ?? [])]
    .reverse()
    .find((h) => h.to_provider === "codex");
  const handoff: HandoffRecord = {
    at_message_index: Math.max(s.history.length - 1, 0),
    from_provider: "codex",
    to_provider: targetProvider,
    summary,
    at: new Date().toISOString(),
    codex_config_dir: priorForward?.codex_config_dir,
    codex_account_name: priorForward?.codex_account_name,
    codex_model: s.model ?? priorForward?.codex_model,
    codex_thread_id: priorForward?.codex_thread_id,
  };
  s.handoffs = [...(s.handoffs ?? []), handoff];
  s.provider = targetProvider;
  s.model = opts.model;
  schedulePersist(s.id);

  respawnQuery(s);
  emit(s, { type: "handoff", data: handoff });
  return handoff;
}

// listAvailableCodexSlots is the read API the UI hits when opening the
// "Hand off to Codex" picker. Returns the authenticated codex
// directories on disk with display labels + the per-account model
// catalog when present. Empty list → UI surfaces "no codex accounts
// authenticated; run `codex login` first".
export async function listAvailableCodexSlots(): Promise<
  Array<{
    config_dir: string;
    name: string;
    email?: string;
    plan_type?: string;
    models?: Array<{
      slug: string;
      display_name: string;
      description?: string;
      default_reasoning_level?: string;
      supported_reasoning_levels?: string[];
    }>;
  }>
> {
  return listCodexConfigDirs();
}

// listFileSnapshots is the public read API for /rewind. Returns the
// raw FileSnapshot list — the route handler shapes it into a UI
// payload (groups by parentMessageId, joins with history excerpts).
export async function listFileSnapshots(
  sessionId: string,
): Promise<FileSnapshot[]> {
  return fhListSnapshots(sessionId);
}

// rewindSession performs the actual restore. Takes a snapshot id and a
// mode that selects which surfaces get rolled back:
//   - "code"        — only files; conversation untouched
//   - "conversation"— only history + transcript jsonl; on-disk files
//                     untouched
//   - "both"        — code + conversation
// Returns the actions taken on each surface so the route can shape a
// response the user can scan ("restored 3 files, truncated 8 messages").
export interface RewindResult {
  files?: RestoreFileAction[];
  // For conversation rewinds: the index in the new (truncated)
  // history that was kept as the last entry. Lets the UI hint the
  // user "you're now at message #N".
  truncatedFromIndex?: number;
}

export async function rewindSession(
  sessionId: string,
  opts: {
    snapshotId?: string;
    // Conversation-only rewinds: the picker passes the target user
    // message id directly when no file snapshot exists for that turn.
    // Code/both still require snapshotId — file restore can't happen
    // without backups to write back.
    parentMessageId?: string;
    mode: "code" | "conversation" | "both";
  },
): Promise<RewindResult> {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");

  // Resolve the cut id once. Prefer the explicit parentMessageId so
  // conversation-only rewinds work without touching file history; fall
  // back to the snapshot's recorded parent when only snapshotId came in.
  let cutId = opts.parentMessageId;
  if (!cutId && opts.snapshotId) {
    const snapshots = await fhListSnapshots(sessionId);
    const target = snapshots.find((sn) => sn.id === opts.snapshotId);
    if (!target) throw new Error("snapshot not found");
    cutId = target.parentMessageId;
  }
  if (opts.snapshotId && opts.mode !== "conversation") {
    // Validate the snapshot exists when we'll actually use it for file
    // restore — listSnapshots reads disk so we avoid the extra call
    // unless code/both is the active mode.
    const snapshots = await fhListSnapshots(sessionId);
    if (!snapshots.some((sn) => sn.id === opts.snapshotId)) {
      throw new Error("snapshot not found");
    }
  }

  const result: RewindResult = {};
  if ((opts.mode === "code" || opts.mode === "both") && opts.snapshotId) {
    result.files = await fhRestoreCode(sessionId, opts.snapshotId);
  }
  if (opts.mode === "conversation" || opts.mode === "both") {
    // Conversation rewind: stop the live query, slice the in-memory
    // history at the parent user message, persist the trimmed view,
    // and re-resume so the SDK reads the truncated transcript on next
    // turn. Without the abort the running query would keep streaming
    // into stale history slots.
    if (!cutId) {
      throw new Error(
        "parent_message_id missing — conversation rewind needs a target user message",
      );
    }
    const cutIdx = s.history.findIndex(
      (m) => m.type === "user" && (m as { uuid?: string }).uuid === cutId,
    );
    if (cutIdx < 0) {
      throw new Error("parent user message no longer in history");
    }
    // Drop everything strictly AFTER the parent user message —
    // including the parent itself's tool_use/result chain — so the
    // session reads as "user turn submitted, no response yet".
    s.history = s.history.slice(0, cutIdx + 1);
    result.truncatedFromIndex = cutIdx;

    try {
      s.abortController.abort();
      s.inputQueue.end();
      try {
        s.query.close();
      } catch {
        // close() can throw on an already-closed query — ignore.
      }
    } catch (err) {
      console.warn("[rewind] abort failed:", err);
    }
    sessions.delete(sessionId);

    // Rewrite the on-disk transcript to match the trimmed history.
    // The SDK's `resume` reads this file on the next spawn, and any
    // entries past the cut would re-introduce the very state we
    // just rewound away from.
    await rewriteTranscript(s);
    schedulePersist(sessionId);
  }
  return result;
}

// rewriteTranscript flushes the session's current in-memory history to
// the SDK transcript jsonl so a subsequent `resume` reads the same
// view. Touches Claude's project storage at
// ~/.claude/projects/<projectDir>/<sessionId>.jsonl — the same file
// the binary itself appends to during a live session.
async function rewriteTranscript(s: ChatSession): Promise<void> {
  // The CLI hashes cwd to derive projectDir. We mirror that with the
  // same convention the binary uses: replace `/` with `-` and prefix
  // with `-` (matches `~/.claude/projects/<-Users-tungngo-...>/<id>.jsonl`).
  const projectDir = s.cwd.replace(/\//g, "-");
  const file = path.join(
    s.configDir,
    "projects",
    projectDir,
    `${s.id}.jsonl`,
  );
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lines = s.history.map((m) => JSON.stringify(m));
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    await fs.rename(tmp, file);
  } catch (err) {
    console.warn("[rewind] transcript rewrite failed:", err);
    // The user still gets the in-memory rewind; the next resume may
    // re-introduce trimmed messages. Visible enough to surface in the
    // server log without crashing the operation.
  }
}

// interruptTurn aborts the current in-flight Claude turn and respawns the
// SDK query so the session goes back to idle. Unlike stopSession, the
// session stays alive — the user can send a new message immediately.
// Emits turn_interrupted before the respawn so SSE clients clear their
// streaming-block previews.
export function interruptTurn(
  sessionId: string,
): { ok: boolean; reason?: "not_running" | "session_missing" } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, reason: "session_missing" };
  if (
    s.status !== "thinking" &&
    s.status !== "awaiting_permission" &&
    s.status !== "rate_limited"
  ) {
    return { ok: false, reason: "not_running" };
  }
  emit(s, { type: "turn_interrupted", data: {} });
  respawnQuery(s);
  return { ok: true };
}

export async function stopSession(sessionId: string): Promise<void> {
  const live = sessions.get(sessionId);
  if (live) {
    live.abortController.abort();
    live.inputQueue.end();
    try {
      live.query.close();
    } catch {
      // close() can throw if already closed — ignore.
    }
    setStatus(live, "closed");
    sessions.delete(sessionId);
  } else {
    // Interrupted: nothing live to abort, but still wipe the shadow
    // entry + disk file so the UI doesn't see it again next time.
    interruptedSessions.delete(sessionId);
  }
  // Cancel any pending debounced flush for this session — there's
  // nothing left to write, and a late timer firing after the unlink
  // would just recreate the file.
  const timer = persistTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(sessionId);
  }
  // Best-effort disk cleanup. Failures are logged inside
  // deleteStoredSession's caller path; we don't surface them because
  // the in-memory state is already gone and that's what the UI cares
  // about.
  try {
    await deleteStoredSession(sessionId);
  } catch (err) {
    console.warn(`[sessions] stop ${sessionId}: disk cleanup failed:`, err);
  }
}

// synthesizeSuggestions builds a session-scoped addRules update for
// tools where we know the canonical rule shape and the SDK didn't
// ship one in `ctx.suggestions`. Mirrors what `claude --add-rules`
// would write for the same call.
//
// Bash uses the exact-prefix syntax `Bash(<command>:*)` — the trailing
// `:*` tells the matcher "this command and any args after it",
// matching CLI behavior. We escape parentheses by passing them
// verbatim; the SDK's matcher treats ruleContent as a literal pattern
// for Bash, not a regex.
function synthesizeSuggestions(
  toolName: string,
  input: Record<string, unknown>,
): PermissionUpdate[] {
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.trim();
    if (!cmd) return [];
    return [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: `${cmd}:*` }],
        behavior: "allow",
        destination: "session",
      },
    ];
  }
  // MCP DB tools (`mcp__<conn>__execute_sql` / `__run_query`) — every
  // call carries a different SQL string, so a content-aware rule like
  // Bash's `<cmd>:*` would never match. Authorize the whole tool name
  // instead; the upstream postgres-mcp/mcp-clickhouse servers already
  // enforce read-only at the SQL parser level, so granting the tool
  // is no broader than what the user opted into when registering the
  // connection.
  if (MCP_DB_TOOL_RE.test(toolName)) {
    return [
      {
        type: "addRules",
        rules: [{ toolName, ruleContent: "" }],
        behavior: "allow",
        destination: "session",
      },
    ];
  }
  // Read/Glob/Grep/WebFetch/etc. could be added here as we learn the
  // canonical rule shape per tool. For now leave them to the SDK.
  return [];
}

// matchesAlwaysAllow checks whether a freshly-seen tool call matches
// any rule the user already approved with "Always allow" earlier in
// the session. We mirror the matcher Claude CLI uses for its
// settings.json `permissions` block — currently Bash with the
// `<prefix>:*` suffix-wildcard form.
function matchesAlwaysAllow(
  session: ChatSession,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (session.alwaysAllowRules.length === 0) return false;
  for (const rule of session.alwaysAllowRules) {
    if (rule.toolName !== toolName) continue;
    if (matchSingleRule(rule, toolName, input)) return true;
  }
  return false;
}

function matchSingleRule(
  rule: PermissionRuleValue,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const content = (rule.ruleContent ?? "").trim();
  if (!content) {
    // Empty ruleContent = wildcard on input. Matches the CLI's
    // settings.json convention where `permissions.allow: ["mcp__pg__execute_sql"]`
    // (no parens) authorizes every invocation of that tool. We
    // synthesize this shape for MCP DB tools; the SDK may also ship it
    // for other tool families.
    return true;
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.trim();
    if (!cmd) return false;
    if (content.endsWith(":*")) {
      // "git status:*" matches "git status" and "git status -s" but not
      // "git status-foo" — the prefix must be followed by EOS or a space.
      const prefix = content.slice(0, -2);
      return cmd === prefix || cmd.startsWith(prefix + " ");
    }
    return cmd === content;
  }
  // Other tools don't yet have a synthesized rule shape, so an exact
  // match on the full ruleContent is the only safe behavior.
  return false;
}

// rememberAlwaysAllow persists the rules the user just approved into
// the session's local cache. De-dupes against existing rules so
// repeated "Always allow" clicks on the same command don't bloat the
// list. Returns the count of newly added rules so the caller can log.
function rememberAlwaysAllow(
  session: ChatSession,
  updates: PermissionUpdate[],
): number {
  let added = 0;
  for (const upd of updates) {
    if (upd.type !== "addRules" || upd.behavior !== "allow") continue;
    for (const rule of upd.rules) {
      const dup = session.alwaysAllowRules.some(
        (r) =>
          r.toolName === rule.toolName && r.ruleContent === rule.ruleContent,
      );
      if (!dup) {
        session.alwaysAllowRules.push(rule);
        added++;
      }
    }
  }
  return added;
}

// subscribe wires an SSE handler to a session's event bus. Returns an
// unsubscribe function the route handler MUST call on disconnect to
// avoid leaking listeners.
//
// SSE is the "user is actively viewing this chat" signal, so this is
// the natural place to materialize an interrupted session: the moment
// the chat panel opens, we resume the SDK Query in the background and
// the next assistant turn streams through this handler as if the
// restart never happened.
export function subscribe(
  sessionId: string,
  handler: (event: ChatEvent) => void,
): () => void {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  s.emitter.on("event", handler);
  return () => s.emitter.off("event", handler);
}
