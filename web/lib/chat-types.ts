// Wire types shared between server (chat API routes + session manager) and
// client (chat UI). The actual SDKMessage shape is forwarded as-is from
// @anthropic-ai/claude-agent-sdk — that's a type-only import, no bundle cost.

import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PlanRecord } from "./plan-types";

// Mirror of EffortLevel from the SDK so client code (which can't import the
// SDK runtime) can use the same union.
export type Effort = EffortLevel;

// PermissionMode mirrors the SDK PermissionMode union but is duplicated
// here so client modules (which can only import types from the SDK)
// have a runtime-safe value. Keep in sync with the SDK upstream.
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

export type SessionStatus =
  | "starting"
  | "idle"
  | "thinking"
  | "awaiting_permission"
  | "errored"
  | "closed"
  // Loaded from disk after a server restart. Metadata + history are
  // hydrated, but the underlying SDK Query is not running. The session
  // is materialised lazily on first interaction (sendMessage / SSE
  // subscribe / updateSessionOptions) via SDK `resume` and flips back
  // to "starting"/"idle" once the binary is alive again.
  | "interrupted";

export interface SessionSummary {
  id: string;
  cwd: string;
  config_dir: string;
  account_name?: string;
  status: SessionStatus;
  created_at: string;
  history_length: number;
  // Snippet of the first user text message, or undefined if the session
  // hasn't received user input yet. Sidebar shows this so rows are
  // scannable without opening each chat.
  title?: string;
  // Selected at session creation; UI surfaces them in the composer.
  model?: string;
  effort?: Effort;
  // Active permission mode. Drives auto-allow behavior server-side
  // and the mode chip in the composer toolbar client-side.
  permission_mode?: PermissionMode;
  // Most recent token usage from a `result` SDK message. Drives the
  // context-window % indicator. input_tokens already accounts for the
  // running history the SDK ships each turn.
  usage?: SessionUsage;
  // Authoritative context-window breakdown from the SDK control
  // channel (Query.getContextUsage). Refreshed at end of each turn.
  // When present, the UI prefers this over deriving from `usage`.
  context_usage?: ContextUsageBreakdown;
  // Top-level Task subagents the model has spawned in this session.
  // Server derives from history so the sidebar can show a tree without
  // each client re-walking transcripts. Empty/omitted when none yet.
  subagents?: SubagentSummary[];
  // Set when this session was spawned as a phase executor by the plan
  // approve route. Sidebar groups sessions sharing the same plan_id
  // under a "Plan" header so phase fanout is visible at a glance.
  plan_id?: string;
  phase_slug?: string;
}

// SubagentSummary describes one Task tool_use spawn. The Task tool's
// children — assistant turns the subagent makes, tool_use blocks it
// calls, etc. — all carry parent_tool_use_id === task_id, so the UI
// uses task_id to filter the main timeline and group children under
// the inline SubagentCard.
export interface SubagentSummary {
  // Stable identifier — the parent Task block's tool_use id. Children
  // reference it via SDKMessage.parent_tool_use_id.
  task_id: string;
  // Captured from the Task tool input. subagent_type names the agent
  // archetype (e.g. "general-purpose", "Explore"); description is the
  // human-readable summary the model wrote when dispatching.
  subagent_type?: string;
  description?: string;
  // active until the parent timeline receives a tool_result block for
  // task_id; flips to done/errored based on tool_result.is_error.
  status: "active" | "done" | "errored";
  // Number of tool_use blocks the subagent has emitted so far. Drives
  // the "n tools" chip on the card. Counts nested calls too — including
  // any sub-subagents the subagent itself dispatched.
  tool_calls: number;
  // First non-empty line of the tool_result content, capped to ~200
  // chars. The sidebar shows this as a one-line preview; the full
  // result is in the children timeline.
  result_text?: string;
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// ContextUsageBreakdown mirrors the SDK control-protocol response for
// `get_context_usage` (Query.getContextUsage()). It's the same data
// the CLI's `/context` slash command renders, so surfacing it 1:1 in
// the web orchestrator avoids the per-turn `usage` math entirely and
// guarantees the meter agrees with the CLI.
export interface ContextUsageCategory {
  name: string;
  tokens: number;
  color: string;
  is_deferred?: boolean;
}

export interface ContextUsageBreakdown {
  categories: ContextUsageCategory[];
  total_tokens: number;
  max_tokens: number;
  percentage: number;
  model: string;
  // Optional detail blocks. Not every category is broken out (the CLI
  // shows them in expandable sections); we forward what's there for
  // future expansion / debugging without forcing the UI to render all.
  memory_files?: { path: string; type: string; tokens: number }[];
  mcp_tools?: {
    name: string;
    server_name: string;
    tokens: number;
    is_loaded?: boolean;
  }[];
  system_tools?: { name: string; tokens: number }[];
  deferred_builtin_tools?: {
    name: string;
    tokens: number;
    is_loaded: boolean;
  }[];
  system_prompt_sections?: { name: string; tokens: number }[];
}

// PermissionSuggestion mirrors the SDK's PermissionUpdate union — kept
// opaque on the wire so we can forward whatever the SDK shipped
// (addRules / setMode / addDirectories / etc.) back as
// `updatedPermissions` when the user clicks "Always allow". The shape
// is owned by the SDK; the UI only checks length and forwards the
// array.
export type PermissionSuggestion = Record<string, unknown>;

export interface PermissionRequest {
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  // SDK-suggested permission updates (e.g. "always allow Bash with this
  // exact command for this session"). Present when the SDK has a
  // suggestion to offer; UI uses this to decide whether to render an
  // "Always allow" affordance. Empty/undefined → suppress that button.
  permission_suggestions?: PermissionSuggestion[];
}

// PermissionDecision is the body the UI POSTs back to resolve a request.
// Mirrors the SDK's PermissionResult union but with snake_case. When
// `always_allow` is set on the allow branch, the server attaches the
// pending request's stored `permission_suggestions` as
// `updatedPermissions` so the SDK won't ask again for matching tools.
export type PermissionDecision =
  | {
      behavior: "allow";
      updated_input?: Record<string, unknown>;
      always_allow?: boolean;
    }
  | { behavior: "deny"; message: string };

// AskUserQuestion is a built-in tool the agent calls to surface
// multiple-choice questions. The SDK reads `updatedInput.answers` from
// our canUseTool resolution and ships them back as the tool result, so
// no real tool execution happens — we just collect the answers and
// resolve via PermissionResult.
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionEntry {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionRequest {
  id: string;
  tool_use_id: string;
  questions: AskUserQuestionEntry[];
}

// AskUserQuestionAnswers maps each question's text to the selected
// option label(s). The SDK joins multi-select labels with commas, so
// we keep a single string per question rather than string[]. "" means
// the user skipped that question.
export type AskUserQuestionAnswers = Record<string, string>;

// ChatEvent is the discriminated union streamed over SSE on
// /api/chat/[id]/events.
export type ChatEvent =
  | { type: "message"; data: SDKMessage }
  | { type: "status"; data: { status: SessionStatus } }
  | { type: "permission_request"; data: PermissionRequest }
  | { type: "permission_resolved"; data: { id: string } }
  | { type: "ask_user_question"; data: AskUserQuestionRequest }
  | { type: "ask_user_question_resolved"; data: { id: string } }
  | { type: "plan_submitted"; data: PlanRecord }
  | { type: "plan_approved"; data: PlanRecord }
  | { type: "plan_failed"; data: PlanRecord }
  | { type: "context_usage"; data: ContextUsageBreakdown }
  // queue_edited carries the FULL replaced SDKMessage so the client
  // reducer can swap by uuid. Fired when the user rewrites a queued
  // user message via PATCH /api/chat/<id>/queue/<uuid>.
  | { type: "queue_edited"; data: SDKMessage }
  | { type: "queue_cancelled"; data: { uuid: string } }
  // Sentinel emitted by the SSE route AFTER it finishes replaying
  // history. The client uses this to know when items.length is final
  // (no more historical messages will arrive in this burst), so the
  // chat panel can mount Virtuoso with the correct
  // `initialTopMostItemIndex` baked in. Eliminates the heuristic
  // 150ms idle-window approach which fails on bursty SSE delivery.
  | { type: "history_replayed"; data: Record<string, never> }
  | { type: "error"; data: { message: string } }
  | { type: "closed"; data: Record<string, never> };

// Snapshot returned to a freshly connected SSE client (or via GET
// /api/chat/[id]) so reload doesn't lose conversation context.
export interface SessionSnapshot {
  summary: SessionSummary;
  history: SDKMessage[];
  pending_permission?: PermissionRequest;
  pending_question?: AskUserQuestionRequest;
  latest_plan?: PlanRecord;
}

export type SubagentNavTarget = {
  session_id: string;
  task_id: string;
};

export interface CreateSessionRequest {
  cwd: string;
  config_dir: string;
  account_name?: string;
  model?: string;
  effort?: Effort;
  // Active permission mode. Drives auto-allow behavior server-side
  // and the mode chip in the composer toolbar client-side.
  permission_mode?: PermissionMode;
  // Set by the plan approve route when spawning a phase executor.
  // Sidebar uses these to group phase sessions under their owning plan.
  plan_id?: string;
  phase_slug?: string;
}

// Inline image attachment for the input route. Source is a data URL the
// client built from a paste/drop; server splits out the base64 + media
// type and pushes a Claude image content block to the SDK queue.
export interface AttachmentImage {
  type: "image";
  data_url: string;
  filename?: string;
}

// Text file attachment — content was already read on the client. Server
// inlines as a fenced code block so the model sees it in the user turn.
export interface AttachmentText {
  type: "text_file";
  filename: string;
  content: string;
  language?: string;
}

export type Attachment = AttachmentImage | AttachmentText;

export interface SendInputRequest {
  text: string;
  attachments?: Attachment[];
  // Optional client-generated id used to dedupe accidental double-
  // submits (smashing Enter, browser auto-retry on network blip).
  // Server tracks recent ids in a short TTL cache and drops repeats.
  client_request_id?: string;
}

// StreamingBlock mirrors a single Anthropic content block while it's still
// streaming. Indexed at the call site by content_block_index so the live
// preview can render text, thinking, and tool_use blocks in the same
// chronological order they'll appear in the finalized assistant message.
export type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; partial_json: string };
