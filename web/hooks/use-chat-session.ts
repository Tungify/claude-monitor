"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionRequest,
  ContextUsageBreakdown,
  PermissionDecision,
  PermissionRequest,
  SessionStatus,
  StreamingBlock,
  SubagentSummary,
} from "@/lib/chat-types";
import type { PlanRecord } from "@/lib/plan-types";
import { deriveSubagents } from "@/lib/subagents";

export type ConnectionState = "connecting" | "open" | "closed";

interface State {
  history: SDKMessage[];
  status: SessionStatus;
  pendingPermission: PermissionRequest | null;
  pendingQuestion: AskUserQuestionRequest | null;
  latestPlan: PlanRecord | null;
  errors: string[];
  connection: ConnectionState;
  // Per-block streaming state for the in-flight assistant turn. Cleared
  // when the full `assistant` SDKMessage arrives (history takes over) or
  // a fresh turn begins. Indexed by Anthropic's content_block_index.
  streamingBlocks: StreamingBlock[];
  // Authoritative context-window breakdown from the SDK's
  // get_context_usage control request. Server pushes a fresh one
  // after every `result` (end-of-turn). Drives the meter directly so
  // we don't have to re-derive from `usage` deltas.
  contextUsage: ContextUsageBreakdown | null;
  // Flips true when the SSE source emits `history_replayed` — the
  // sentinel the events route writes after iterating snap.history.
  // Lets ChatPanel gate Virtuoso mount until items.length is final,
  // so `initialTopMostItemIndex` lands on the actual last message.
  hydrated: boolean;
}

type Action =
  | { kind: "message"; msg: SDKMessage }
  | { kind: "status"; status: SessionStatus }
  | { kind: "permission_request"; req: PermissionRequest }
  | { kind: "permission_resolved" }
  | { kind: "ask_user_question"; req: AskUserQuestionRequest }
  | { kind: "ask_user_question_resolved" }
  | { kind: "plan"; plan: PlanRecord }
  | { kind: "context_usage"; breakdown: ContextUsageBreakdown }
  // queue_edited: replace history entry by uuid. queue_cancelled:
  // drop history entry by uuid. Both fire when the user mutates a
  // queued (not yet processing) user message via the queue route.
  | { kind: "queue_edited"; msg: SDKMessage }
  | { kind: "queue_cancelled"; uuid: string }
  | { kind: "hydrated" }
  // Wipe state back to the initial shape. Dispatched whenever the
  // hook's `sessionId` argument changes — defensive against the page-
  // level `key={id}` failing to actually remount ChatPanel (which
  // would otherwise leak the previous session's history into the new
  // one and confuse Virtuoso's bottom-anchoring).
  | { kind: "reset" }
  | { kind: "chat_error"; message: string }
  | { kind: "connection"; state: ConnectionState };

const ERROR_CAP = 10;

// Anthropic streaming-event envelope as forwarded by the SDK's
// SDKPartialAssistantMessage. Only the fields we actually read are typed;
// the SDK validates the rest upstream.
interface StreamEnvelope {
  event?: {
    type: string;
    index?: number;
    content_block?: {
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
}

function setBlock(
  blocks: StreamingBlock[],
  index: number,
  block: StreamingBlock,
): StreamingBlock[] {
  const out = blocks.slice();
  out[index] = block;
  return out;
}

function patchBlock(
  blocks: StreamingBlock[],
  index: number,
  patch: Partial<StreamingBlock>,
): StreamingBlock[] {
  const existing = blocks[index];
  if (!existing) return blocks;
  return setBlock(blocks, index, { ...existing, ...patch } as StreamingBlock);
}

function reduceStreamEvent(state: State, msg: SDKMessage): State {
  const ev = (msg as unknown as StreamEnvelope).event;
  if (!ev) return state;
  // message_start opens a fresh turn — drop any leftover preview blocks.
  if (ev.type === "message_start") {
    return { ...state, streamingBlocks: [] };
  }
  if (ev.type === "content_block_start" && typeof ev.index === "number" && ev.content_block) {
    const cb = ev.content_block;
    const i = ev.index;
    if (cb.type === "text") {
      return { ...state, streamingBlocks: setBlock(state.streamingBlocks, i, { type: "text", text: "" }) };
    }
    if (cb.type === "thinking") {
      return {
        ...state,
        streamingBlocks: setBlock(state.streamingBlocks, i, { type: "thinking", thinking: "" }),
      };
    }
    if (cb.type === "tool_use") {
      return {
        ...state,
        streamingBlocks: setBlock(state.streamingBlocks, i, {
          type: "tool_use",
          id: cb.id ?? "",
          name: cb.name ?? "",
          partial_json: "",
        }),
      };
    }
    return state;
  }
  if (ev.type === "content_block_delta" && typeof ev.index === "number" && ev.delta) {
    const i = ev.index;
    const d = ev.delta;
    const existing = state.streamingBlocks[i];
    if (!existing) return state;
    if (d.type === "text_delta" && existing.type === "text") {
      const chunk = d.text ?? "";
      if (!chunk) return state;
      return {
        ...state,
        streamingBlocks: patchBlock(state.streamingBlocks, i, { text: existing.text + chunk }),
      };
    }
    if (d.type === "thinking_delta" && existing.type === "thinking") {
      const chunk = d.thinking ?? "";
      if (!chunk) return state;
      return {
        ...state,
        streamingBlocks: patchBlock(state.streamingBlocks, i, {
          thinking: existing.thinking + chunk,
        }),
      };
    }
    if (d.type === "input_json_delta" && existing.type === "tool_use") {
      const chunk = d.partial_json ?? "";
      if (!chunk) return state;
      return {
        ...state,
        streamingBlocks: patchBlock(state.streamingBlocks, i, {
          partial_json: existing.partial_json + chunk,
        }),
      };
    }
    return state;
  }
  return state;
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "message": {
      // stream_event: token deltas. Update per-block streaming state, leave history.
      if (action.msg.type === "stream_event") {
        return reduceStreamEvent(state, action.msg);
      }
      // Full assistant reply arrived — drop streaming preview so the real
      // bubble (rendered from history) takes over without overlap.
      if (action.msg.type === "assistant") {
        return {
          ...state,
          history: [...state.history, action.msg],
          streamingBlocks: [],
        };
      }
      return { ...state, history: [...state.history, action.msg] };
    }
    case "status":
      return { ...state, status: action.status };
    case "permission_request":
      return { ...state, pendingPermission: action.req };
    case "permission_resolved":
      return { ...state, pendingPermission: null };
    case "ask_user_question":
      return { ...state, pendingQuestion: action.req };
    case "ask_user_question_resolved":
      return { ...state, pendingQuestion: null };
    case "plan":
      return { ...state, latestPlan: action.plan };
    case "context_usage":
      return { ...state, contextUsage: action.breakdown };
    case "queue_edited": {
      const incomingUuid = (action.msg as { uuid?: string }).uuid;
      if (!incomingUuid) return state;
      const next = state.history.map((m) =>
        (m as { uuid?: string }).uuid === incomingUuid ? action.msg : m,
      );
      return { ...state, history: next };
    }
    case "queue_cancelled":
      return {
        ...state,
        history: state.history.filter(
          (m) => (m as { uuid?: string }).uuid !== action.uuid,
        ),
      };
    case "hydrated":
      // Idempotent — repeated history_replayed events (shouldn't
      // happen, but guards reconnects) keep state stable.
      return state.hydrated ? state : { ...state, hydrated: true };
    case "reset":
      return initial;
    case "chat_error":
      return { ...state, errors: [action.message, ...state.errors].slice(0, ERROR_CAP) };
    case "connection":
      return { ...state, connection: action.state };
  }
}

const initial: State = {
  history: [],
  status: "starting",
  pendingPermission: null,
  pendingQuestion: null,
  latestPlan: null,
  errors: [],
  connection: "connecting",
  streamingBlocks: [],
  contextUsage: null,
  hydrated: false,
};

export interface UseChatSession extends State {
  send: (text: string) => Promise<void>;
  decide: (decision: PermissionDecision) => Promise<void>;
  answer: (answers: AskUserQuestionAnswers) => Promise<void>;
  cancelQuestion: (message?: string) => Promise<void>;
  approvePlan: (planId: string) => Promise<void>;
  stop: () => Promise<void>;
  // Queue mutators — only valid for user messages still waiting in
  // the SDK input queue. The server enforces that constraint and
  // returns 409 once a message is in flight.
  editQueued: (uuid: string, text: string) => Promise<void>;
  cancelQueued: (uuid: string) => Promise<void>;
  // Subagent grouping derived from history. byTaskId is keyed by Task
  // tool_use_id; childrenByTaskId carries the SDKMessages emitted while
  // the subagent ran; resultTaskIds names tasks whose tool_result echo
  // can be hidden from the main viewport (the SubagentCard owns it).
  subagents: SubagentSummary[];
  subagentsByTaskId: Map<string, SubagentSummary>;
  subagentChildrenByTaskId: Map<string, SDKMessage[]>;
  subagentResultTaskIds: Set<string>;
}

// useChatSession owns the EventSource subscription for one chat session
// plus the POST helpers for sending input, resolving permission prompts,
// and stopping the session. The subscription replays full history on
// connect so a tab refresh doesn't lose context.
export function useChatSession(sessionId: string): UseChatSession {
  const [state, dispatch] = useReducer(reducer, initial);
  const sourceRef = useRef<EventSource | null>(null);
  // Track the most recent sessionId we set up SSE for. When this
  // hook is reused across navigations (i.e. ChatPanel wasn't
  // remounted by `key={id}` for any reason — Next.js caching, parent
  // optimisation, etc.), the [sessionId] effect below re-runs with a
  // new id but the reducer state still holds the previous session's
  // history + hydrated=true. We dispatch reset BEFORE opening the
  // new EventSource to wipe that leak; the first mount sees identity
  // unchanged and skips, so initial state isn't double-reset.
  const lastSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastSessionIdRef.current !== null && lastSessionIdRef.current !== sessionId) {
      dispatch({ kind: "reset" });
    }
    lastSessionIdRef.current = sessionId;

    const es = new EventSource(`/api/chat/${sessionId}/events`);
    sourceRef.current = es;

    es.addEventListener("open", () => dispatch({ kind: "connection", state: "open" }));

    es.addEventListener("message", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as SDKMessage;
      dispatch({ kind: "message", msg: data });
    });
    es.addEventListener("status", (e) => {
      const { status } = JSON.parse((e as MessageEvent).data) as { status: SessionStatus };
      dispatch({ kind: "status", status });
      // Nudge the sidebar to refetch so the row's "Awaiting permission /
      // Working / Idle" badge reflects the new state without waiting on
      // the 5s background poll. We piggy-back on the same event the
      // subagent fingerprint uses; the provider's debounce coalesces.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("cm:session-subagents", { detail: { sessionId } }),
        );
      }
    });
    es.addEventListener("permission_request", (e) => {
      const req = JSON.parse((e as MessageEvent).data) as PermissionRequest;
      dispatch({ kind: "permission_request", req });
    });
    es.addEventListener("permission_resolved", () => {
      dispatch({ kind: "permission_resolved" });
    });
    es.addEventListener("ask_user_question", (e) => {
      const req = JSON.parse((e as MessageEvent).data) as AskUserQuestionRequest;
      dispatch({ kind: "ask_user_question", req });
    });
    es.addEventListener("ask_user_question_resolved", () => {
      dispatch({ kind: "ask_user_question_resolved" });
    });
    const onPlan = (e: Event) => {
      const plan = JSON.parse((e as MessageEvent).data) as PlanRecord;
      dispatch({ kind: "plan", plan });
    };
    es.addEventListener("plan_submitted", onPlan);
    es.addEventListener("plan_approved", onPlan);
    es.addEventListener("plan_failed", onPlan);
    es.addEventListener("context_usage", (e) => {
      const breakdown = JSON.parse(
        (e as MessageEvent).data,
      ) as ContextUsageBreakdown;
      dispatch({ kind: "context_usage", breakdown });
    });
    es.addEventListener("queue_edited", (e) => {
      const msg = JSON.parse((e as MessageEvent).data) as SDKMessage;
      dispatch({ kind: "queue_edited", msg });
    });
    es.addEventListener("queue_cancelled", (e) => {
      const { uuid } = JSON.parse((e as MessageEvent).data) as { uuid: string };
      dispatch({ kind: "queue_cancelled", uuid });
    });
    es.addEventListener("history_replayed", () => {
      dispatch({ kind: "hydrated" });
    });
    es.addEventListener("closed", () => {
      dispatch({ kind: "connection", state: "closed" });
      es.close();
    });

    // EventSource fires its own 'error' event on connection issues with
    // no .data; server-emitted error envelopes have a string .data. The
    // type discriminates the two without needing a separate listener.
    es.addEventListener("error", (e) => {
      const me = e as MessageEvent;
      if (typeof me.data === "string") {
        try {
          const { message } = JSON.parse(me.data) as { message: string };
          dispatch({ kind: "chat_error", message });
        } catch {
          // Malformed payload — drop.
        }
      }
    });

    return () => {
      es.close();
      sourceRef.current = null;
    };
  }, [sessionId]);

  const send = async (text: string) => {
    const res = await fetch(`/api/chat/${sessionId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `send failed: ${body}` });
    }
  };

  const decide = async (decision: PermissionDecision) => {
    const req = state.pendingPermission;
    if (!req) return;
    const res = await fetch(`/api/chat/${sessionId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission_id: req.id, decision }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `decide failed: ${body}` });
    }
  };

  const answer = async (answers: AskUserQuestionAnswers) => {
    const req = state.pendingQuestion;
    if (!req) return;
    const res = await fetch(`/api/chat/${sessionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: req.id, answers }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `answer failed: ${body}` });
    }
  };

  const cancelQuestion = async (message?: string) => {
    const req = state.pendingQuestion;
    if (!req) return;
    const res = await fetch(`/api/chat/${sessionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: req.id,
        cancel: true,
        message: message ?? "",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `cancel failed: ${body}` });
    }
  };

  const approvePlan = async (planId: string) => {
    const res = await fetch(`/api/chat/${sessionId}/plan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: planId }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `approve failed: ${body}` });
    }
  };

  const stop = async () => {
    await fetch(`/api/chat/${sessionId}`, { method: "DELETE" });
  };

  // editQueued + cancelQueued mutate a user message that's still
  // sitting in the SDK input queue. The server returns 409 if the SDK
  // already pulled it (in-flight) — we surface that as a chat_error so
  // the user sees feedback instead of a silent no-op.
  const editQueued = async (uuid: string, text: string) => {
    const res = await fetch(`/api/chat/${sessionId}/queue/${uuid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `edit failed: ${body}` });
    }
  };

  const cancelQueued = async (uuid: string) => {
    const res = await fetch(`/api/chat/${sessionId}/queue/${uuid}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.text();
      dispatch({ kind: "chat_error", message: `cancel failed: ${body}` });
    }
  };

  // Recompute subagent grouping when history changes. Cheap walk —
  // history is capped at 1000 messages and most chats stay under 200.
  // useMemo (not React Compiler — the input is a stable Map/Set so we
  // want explicit memo identity for downstream consumers).
  const derived = useMemo(() => deriveSubagents(state.history), [state.history]);

  // Notify the sidebar when this session's subagent grouping changes
  // so the tree under the row stays in sync without a manual reload.
  // Triggers on count + status fingerprint so completions also fire,
  // not just spawns.
  const fingerprint = useMemo(() => {
    return derived.list
      .map((s) => `${s.task_id}:${s.status}:${s.tool_calls}`)
      .join("|");
  }, [derived.list]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("cm:session-subagents", {
        detail: { sessionId },
      }),
    );
  }, [sessionId, fingerprint]);

  return {
    ...state,
    send,
    decide,
    answer,
    cancelQuestion,
    approvePlan,
    stop,
    editQueued,
    cancelQueued,
    subagents: derived.list,
    subagentsByTaskId: derived.byTaskId,
    subagentChildrenByTaskId: derived.childrenByTaskId,
    subagentResultTaskIds: derived.resultTaskIds,
  };
}
