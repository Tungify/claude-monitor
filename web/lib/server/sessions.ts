import "server-only";

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { AsyncQueue } from "./async-queue";
import {
  createPlanMcpServer,
  PLAN_MCP_SERVER_NAME,
  SUBMIT_PLAN_FQN,
} from "./plan-mcp";
import type {
  ChatEvent,
  PermissionDecision,
  PermissionRequest,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
} from "@/lib/chat-types";
import type { PlanRecord } from "@/lib/plan-types";

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
}

interface ChatSession {
  id: string;
  cwd: string;
  configDir: string;
  accountName?: string;
  createdAt: Date;

  inputQueue: AsyncQueue<SDKUserMessage>;
  query: Query;
  history: SDKMessage[];
  status: SessionStatus;
  pendingPermission?: PendingPermission;
  emitter: EventEmitter;
  abortController: AbortController;
  // Latest plan submitted via the submit_plan MCP tool. Only the most
  // recent submission is shown in the panel; older ones remain on disk
  // under ~/.claude/projects/<encoded-cwd>/plans/.
  latestPlan?: PlanRecord;
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
  return {
    id: session.id,
    cwd: session.cwd,
    config_dir: session.configDir,
    account_name: session.accountName,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    history_length: session.history.length,
  };
}

export function createSession(opts: {
  cwd: string;
  configDir: string;
  accountName?: string;
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
    inputQueue,
    history: [],
    status: "starting",
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

  session.query = query({
    prompt: inputQueue,
    options: {
      cwd: opts.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
      permissionMode: "default",
      canUseTool,
      mcpServers: { [PLAN_MCP_SERVER_NAME]: planMcp },
      abortController,
      sessionId: id,
    },
  });

  sessions.set(id, session);
  void driveSession(session);
  return summarize(session);
}

async function driveSession(session: ChatSession): Promise<void> {
  try {
    for await (const msg of session.query) {
      if (session.history.length >= HISTORY_CAP) session.history.shift();
      session.history.push(msg);
      emit(session, { type: "message", data: msg });

      // The SDK signals end-of-turn with a `result` message. Move back
      // to "idle" so the UI knows it can prompt for another turn.
      if (msg.type === "result") {
        setStatus(session, "idle");
      } else if (
        session.status === "starting" ||
        session.status === "idle"
      ) {
        // First non-result message after a quiet period — Claude is
        // working again.
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

export function sendMessage(sessionId: string, text: string): void {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("session not found");
  if (s.status === "closed" || s.status === "errored") {
    throw new Error(`session is ${s.status}`);
  }
  // The SDK consumes user messages from the input queue but does NOT
  // echo them back through the Query iterator (verified empirically),
  // so we synthesize a history entry here. uuid + emit make the wire
  // shape indistinguishable from an SDK-emitted message.
  const uuid = randomUUID();
  const msg: SDKUserMessage = {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
  s.inputQueue.push(msg);
  if (s.history.length >= HISTORY_CAP) s.history.shift();
  s.history.push(msg);
  emit(s, { type: "message", data: msg });
  setStatus(s, "thinking");
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
