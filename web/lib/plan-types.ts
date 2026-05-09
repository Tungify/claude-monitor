// Plan workflow wire types — shared between server (submit_plan MCP tool,
// approve route, plan persistence) and client (PlanCard component, chat
// reducer). Plans live on disk under
// ~/.claude/projects/<encoded-cwd>/plans/<plan-id>.json mirroring Claude
// CLI's session storage convention.

export interface Phase {
  slug: string;
  title: string;
  description: string;
  depends_on?: string[];
}

export interface WorktreeInfo {
  phase_slug: string;
  path: string;
  branch: string;
}

// PhaseSession links a phase to the chat session that's executing it.
// One session per phase, spawned by the approve route after worktrees
// are created. Persisted on the plan so the UI can rebuild the link
// after a reload (chat sessions live in-memory; plans live on disk).
export interface PhaseSession {
  phase_slug: string;
  session_id: string;
  config_dir: string;
  account_name?: string;
  spawned_at: string;
}

export type PlanStatus = "submitted" | "approved" | "failed";

export interface PlanRecord {
  id: string;
  session_id: string;
  cwd: string;
  title: string;
  phases: Phase[];
  status: PlanStatus;
  created_at: string;
  approved_at?: string;
  worktrees?: WorktreeInfo[];
  phase_sessions?: PhaseSession[];
  error?: string;
}
