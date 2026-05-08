import "server-only";

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
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
import type {
  AskUserQuestionAnswers,
  AskUserQuestionEntry,
  AskUserQuestionRequest,
  Attachment,
  ChatEvent,
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
  // Token counts from the most recent `result` SDK message. The composer
  // divides input_tokens by the model's context window for the % display.
  latestUsage?: SessionUsage;
}

// Stash the registry on globalThis so it survives Next.js dev module
// reloads (Turbopack re-evaluates server modules unpredictably; without
// this, every recompile drops in-flight chat sessions). Production
// multi-instance still needs externalization (Redis/DB), but for the
// single-process Next dev/run we use, this is enough.
const SESSIONS_KEY = Symbol.for("claude-monitor.web.sessions");
type SessionsGlobal = typeof globalThis & {
  [SESSIONS_KEY]?: Map<string, ChatSession>;
};
const g = globalThis as SessionsGlobal;
const sessions: Map<string, ChatSession> = (g[SESSIONS_KEY] ??= new Map());

// Cap history per session to prevent unbounded memory growth from a long-
// running chat. The full transcript stays in the SDK's session store on
// disk anyway; this is just for live-replay to newly connected clients.
const HISTORY_CAP = 1000;

function setStatus(session: ChatSession, status: SessionStatus): void {
  if (session.status === status) return;
  session.status = status;
  emit(session, { type: "status", data: { status } });
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
    subagents: subagents.length > 0 ? subagents : undefined,
  };
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

export function createSession(opts: {
  cwd: string;
  configDir: string;
  accountName?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}): SessionSummary {
  const id = randomUUID();
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const abortController = new AbortController();
  const emitter = new EventEmitter();
  // Lift the EventEmitter listener cap; multiple SSE subscribers + the
  // permission flow easily exceed the default 10. We unsubscribe on
  // disconnect so this isn't a leak.
  emitter.setMaxListeners(64);

  // Session is filled in fully before we start the SDK so the
  // canUseTool callback can close over it safely.
  const session: ChatSession = {
    id,
    cwd: opts.cwd,
    configDir: opts.configDir,
    accountName: opts.accountName,
    createdAt: new Date(),
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode ?? "default",
    inputQueue,
    history: [],
    status: "starting",
    recentRequestIds: new Map(),
    emitter,
    abortController,
    query: undefined as unknown as Query, // assigned below
  };

  const canUseTool: CanUseTool = (toolName, input, ctx) => {
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
      const request: PermissionRequest = {
        id: randomUUID(),
        tool_name: toolName,
        input,
        tool_use_id: ctx.toolUseID,
      };
      session.pendingPermission = {
        request,
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

  const planMcp = createPlanMcpServer({
    sessionId: id,
    cwd: opts.cwd,
    onPlanSubmitted: (plan) => {
      session.latestPlan = plan;
      emit(session, { type: "plan_submitted", data: plan });
    },
  });

  // SDK locates a native binary via optional deps; if those got
  // skipped during install we end up throwing "Native CLI binary
  // for darwin-arm64 not found" at first iteration. findClaudeBinary
  // returns the path of whatever `claude` is on PATH (or null if
  // there really is none, in which case the SDK's own error wins).
  const claudeBin = findClaudeBinary();

  session.query = query({
    prompt: inputQueue,
    options: {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      permissionMode: session.permissionMode,
      // bypassPermissions ("Auto / Yolo" in the UI) requires the
      // session to be launched with this opt-in. Without it the SDK
      // refuses both the initial config and any later
      // setPermissionMode("bypassPermissions") call. We're a desktop
      // app for trusted local repos — match the CLI's
      // `--allow-dangerously-skip-permissions` flag.
      allowDangerouslySkipPermissions: true,
      canUseTool,
      mcpServers: { [PLAN_MCP_SERVER_NAME]: planMcp },
      abortController,
      sessionId: id,
      // Stream Anthropic content_block_delta events through as
      // SDKPartialAssistantMessage (type: "stream_event"). Note: when
      // extended thinking is on (effort high/xhigh/max), the SDK
      // suppresses these and only ships the final assistant message.
      includePartialMessages: true,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
  });

  sessions.set(id, session);
  void driveSession(session);
  return summarize(session);
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
      }
      emit(session, { type: "message", data: msg });

      // The SDK signals end-of-turn with a `result` message. Move back
      // to "idle" so the UI knows it can prompt for another turn.
      if (msg.type === "result") {
        const u = (msg as { usage?: SessionUsage }).usage;
        if (u) {
          session.latestUsage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          };
        }
        setStatus(session, "idle");
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

export function listSessions(): SessionSummary[] {
  return Array.from(sessions.values())
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(summarize);
}

export function snapshotSession(id: string): SessionSnapshot | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  return {
    summary: summarize(s),
    history: s.history,
    pending_permission: s.pendingPermission?.request,
    pending_question: s.pendingQuestion?.request,
    latest_plan: s.latestPlan,
  };
}

export function getLatestPlan(sessionId: string): PlanRecord | undefined {
  return sessions.get(sessionId)?.latestPlan;
}

export function setLatestPlan(sessionId: string, plan: PlanRecord): void {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  s.latestPlan = plan;
}

export function emitPlanEvent(
  sessionId: string,
  type: "plan_approved" | "plan_failed",
  plan: PlanRecord,
): void {
  const s = sessions.get(sessionId);
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
  const s = sessions.get(sessionId);
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
  const result: PermissionResult =
    decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updated_input }
      : { behavior: "deny", message: decision.message };
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
export async function updateSessionOptions(
  sessionId: string,
  opts: { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode },
): Promise<SessionSummary> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  if (opts.model && opts.model !== s.model) {
    await s.query.setModel(opts.model);
    s.model = opts.model;
  }
  if (opts.effort && opts.effort !== s.effort) {
    await s.query.applyFlagSettings({ effort: opts.effort });
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
  const s = sessions.get(sessionId);
  if (!s) return;
  s.abortController.abort();
  s.inputQueue.end();
  try {
    s.query.close();
  } catch {
    // close() can throw if already closed — ignore.
  }
  setStatus(s, "closed");
  sessions.delete(sessionId);
}

// subscribe wires an SSE handler to a session's event bus. Returns an
// unsubscribe function the route handler MUST call on disconnect to
// avoid leaking listeners.
export function subscribe(
  sessionId: string,
  handler: (event: ChatEvent) => void,
): () => void {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  s.emitter.on("event", handler);
  return () => s.emitter.off("event", handler);
}
