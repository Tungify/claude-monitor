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
  error?: string;
}
