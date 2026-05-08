// Wire types shared between server (chat API routes + session manager) and
// client (chat UI). The actual SDKMessage shape is forwarded as-is from
// @anthropic-ai/claude-agent-sdk — that's a type-only import, no bundle cost.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PlanRecord } from "./plan-types";

export type SessionStatus =
  | "starting"
  | "idle"
  | "thinking"
  | "awaiting_permission"
  | "errored"
  | "closed";

export interface SessionSummary {
  id: string;
  cwd: string;
  config_dir: string;
  account_name?: string;
  status: SessionStatus;
  created_at: string;
  history_length: number;
}

export interface PermissionRequest {
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
}

// PermissionDecision is the body the UI POSTs back to resolve a request.
// Mirrors the SDK's PermissionResult union but with snake_case.
export type PermissionDecision =
  | { behavior: "allow"; updated_input?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

// ChatEvent is the discriminated union streamed over SSE on
// /api/chat/[id]/events.
export type ChatEvent =
  | { type: "message"; data: SDKMessage }
  | { type: "status"; data: { status: SessionStatus } }
  | { type: "permission_request"; data: PermissionRequest }
  | { type: "permission_resolved"; data: { id: string } }
  | { type: "plan_submitted"; data: PlanRecord }
  | { type: "plan_approved"; data: PlanRecord }
  | { type: "plan_failed"; data: PlanRecord }
  | { type: "error"; data: { message: string } }
  | { type: "closed"; data: Record<string, never> };

// Snapshot returned to a freshly connected SSE client (or via GET
// /api/chat/[id]) so reload doesn't lose conversation context.
export interface SessionSnapshot {
  summary: SessionSummary;
  history: SDKMessage[];
  pending_permission?: PermissionRequest;
  latest_plan?: PlanRecord;
}

export interface CreateSessionRequest {
  cwd: string;
  config_dir: string;
  account_name?: string;
}
