import "server-only";

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
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
  deleteStoredSession,
  loadAllStoredSessions,
  persistStoredSession,
  type StoredSession,
} from "./session-store";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionEntry,
  AskUserQuestionRequest,
  Attachment,
  ChatEvent,
  ContextUsageBreakdown,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  SessionUsage,
} from "@/lib/chat-types";
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
  permissionMode: PermissionMode;

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
  permissionMode: PermissionMode;
  history: SDKMessage[];
  latestUsage?: SessionUsage;
  latestContextUsage?: ContextUsageBreakdown;
  latestPlan?: PlanRecord;
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
        permissionMode: s.permission_mode,
        history: s.history,
        latestUsage: s.latest_usage,
        latestContextUsage: s.latest_context_usage,
        latestPlan: s.latest_plan,
      });
    }
    if (stored.length > 0) {
      console.log(`[sessions] restored ${stored.length} interrupted session(s) from disk`);
    }
  } catch (err) {
    console.warn("[sessions] disk hydrate failed:", err);
  }
}

const PERSIST_DEBOUNCE_MS = 500;

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
      permission_mode: s.permissionMode,
      history: s.history,
      latest_usage: s.latestUsage,
      latest_context_usage: s.latestContextUsage,
      latest_plan: s.latestPlan,
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
    permission_mode: session.permissionMode,
    usage: session.latestUsage,
    context_usage: session.latestContextUsage,
    subagents: subagents.length > 0 ? subagents : undefined,
  };
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

interface BuildLiveInit {
  id: string;
  cwd: string;
  configDir: string;
  accountName?: string;
  createdAt: Date;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  history: SDKMessage[];
  latestUsage?: SessionUsage;
  latestContextUsage?: ContextUsageBreakdown;
  latestPlan?: PlanRecord;
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
    permissionMode: init.permissionMode,
    inputQueue,
    history: init.history,
    status: "starting",
    recentRequestIds: new Map(),
    emitter,
    abortController,
    latestUsage: init.latestUsage,
    latestContextUsage: init.latestContextUsage,
    latestPlan: init.latestPlan,
    query: undefined as unknown as Query, // assigned below
  };

  // SDK locates a native binary via optional deps; if those got
  // skipped during install we end up throwing "Native CLI binary
  // for darwin-arm64 not found" at first iteration. findClaudeBinary
  // returns the path of whatever `claude` is on PATH (or null if
  // there really is none, in which case the SDK's own error wins).
  const claudeBin = findClaudeBinary();

  session.query = query({
    prompt: inputQueue,
    options: {
      cwd: init.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: init.configDir },
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      permissionMode: init.permissionMode,
      // bypassPermissions ("Auto / Yolo" in the UI) requires the
      // session to be launched with this opt-in. Without it the SDK
      // refuses both the initial config and any later
      // setPermissionMode("bypassPermissions") call. We're a desktop
      // app for trusted local repos — match the CLI's
      // `--allow-dangerously-skip-permissions` flag.
      allowDangerouslySkipPermissions: true,
      canUseTool: makeCanUseTool(session),
      mcpServers: { [PLAN_MCP_SERVER_NAME]: makePlanMcp(session) },
      abortController,
      // Resume vs fresh: `resume` loads the session's transcript via
      // claude's own jsonl on disk; `sessionId` opens a fresh session
      // file with that id. The two are mutually exclusive in the SDK.
      ...(init.isResume ? { resume: init.id } : { sessionId: init.id }),
      // Stream Anthropic content_block_delta events through as
      // SDKPartialAssistantMessage (type: "stream_event"). Note: when
      // extended thinking is on (effort high/xhigh/max), the SDK
      // suppresses these and only ships the final assistant message.
      includePartialMessages: true,
      ...(init.model ? { model: init.model } : {}),
      ...(init.effort ? { effort: init.effort } : {}),
    },
  });

  sessions.set(init.id, session);
  void driveSession(session);
  return session;
}

export function createSession(opts: {
  cwd: string;
  configDir: string;
  accountName?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
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
    permissionMode: opts.permissionMode ?? "default",
    history: [],
    isResume: false,
  });
  schedulePersist(id);
  return summarize(session);
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
    permissionMode: stored.permissionMode,
    history: stored.history,
    latestUsage: stored.latestUsage,
    latestContextUsage: stored.latestContextUsage,
    latestPlan: stored.latestPlan,
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
  try {
    for await (const msg of session.query) {
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
      } else if (
        (msg.type === "assistant" || msg.type === "stream_event") &&
        (session.status === "starting" || session.status === "idle")
      ) {
        // Real model output is starting — Claude is working. Earlier
        // we flipped on *any* non-result message, but the SDK also
        // ships `system` control messages for things like
        // setPermissionMode acknowledgements; flipping on those left
        // the session stuck on "thinking" after a mode change with
        // no actual turn in flight.
        setStatus(session, "thinking");
      }
    }
    setStatus(session, "closed");
    emit(session, { type: "closed", data: {} });
  } catch (err) {
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
    permission_mode: s.permissionMode,
    usage: s.latestUsage,
    context_usage: s.latestContextUsage,
    subagents: subagents.length > 0 ? subagents : undefined,
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
    // it then short-circuits future canUseTool calls that match — no
    // more dialog for the same Bash command, etc. Fall through to
    // plain allow when there were no suggestions to begin with.
    const stored = s.pendingPermission.suggestions ?? [];
    const includeSuggestions = decision.always_allow === true && stored.length > 0;
    result = {
      behavior: "allow",
      updatedInput: decision.updated_input ?? s.pendingPermission.request.input,
      ...(includeSuggestions ? { updatedPermissions: stored } : {}),
    };
  } else {
    result = { behavior: "deny", message: decision.message };
  }
  s.pendingPermission.resolve(result);

  // Status stays "awaiting_permission" for one tick so the resolver can
  // emit permission_resolved before driveSession bumps it back; the next
  // SDK message will set it to "thinking".
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
}

// updateSessionOptions mutates a running Query's model and/or effort
// in place via the SDK's setModel + applyFlagSettings helpers. Both
// require streaming-input mode (we always use AsyncQueue, so we're
// fine). Errors propagate so the route handler can surface them.
//
// Auto-resumes an interrupted session: the user changing model on a
// chat they reopened after a restart should "just work" rather than
// throw "session not found".
export async function updateSessionOptions(
  sessionId: string,
  opts: { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode },
): Promise<SessionSummary> {
  const s = getOrResume(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
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
  // Read/Glob/Grep/WebFetch/etc. could be added here as we learn the
  // canonical rule shape per tool. For now leave them to the SDK.
  return [];
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
