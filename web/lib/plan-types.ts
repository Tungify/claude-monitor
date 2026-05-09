// Plan workflow wire types — shared between server (submit_plan MCP tool,
// approve route, plan persistence) and client (PlanCard component, chat
// reducer). Plans live on disk under
// ~/.claude/projects/<encoded-cwd>/plans/<plan-id>.json mirroring Claude
// CLI's session storage convention.

import type { Effort, PermissionMode } from "./chat-types";

export interface Phase {
  slug: string;
  title: string;
  description: string;
  depends_on?: string[];
  // Per-phase agent runtime overrides. When unset, the approve route
  // inherits the owner session's value — i.e. "spawn the same way the
  // user is currently configured." Override exists so the user can run
  // a heavy-thinking phase on Opus while a boilerplate phase stays on
  // Haiku, or escalate effort just for one tricky slice.
  //   model     SDK model id ("claude-opus-4-7", "claude-sonnet-4-6", ...)
  //   effort    extended-thinking budget (low | medium | high | xhigh | max)
  //   tdd_mode  when true, kickoff prompt instructs the agent to write
  //             failing tests first, surface them, then implement until
  //             they pass — a lightweight TDD discipline driven entirely
  //             by the prompt (no scheduler change).
  model?: string;
  effort?: Effort;
  tdd_mode?: boolean;
  // Declarative file scope — list of globs the agent is expected to
  // stay within. Surfaced in the kickoff prompt so the model has
  // explicit boundaries, and checked post-commit (soft warning, not a
  // hard gate — sometimes touching a shared file is legitimate; the
  // user decides when reviewing). Symbol-level scope is deferred until
  // file-level proves insufficient.
  //   Glob syntax: `*` (no slash), `**` (any depth), `?` (single char).
  //   Examples: "web/lib/auth/**", "web/app/api/auth/route.ts",
  //             "**/*.test.ts".
  scope?: PhaseScope;
}

export interface PhaseScope {
  files?: string[];
}

// PhaseOverride is the wire shape for per-phase edits the user makes in
// PlanCard before clicking Approve. Only fields the user actually
// changed are present; the approve route merges them into the plan
// record on disk before spawning so the persisted plan reflects what
// actually ran.
export interface PhaseOverride {
  model?: string;
  effort?: Effort;
  tdd_mode?: boolean;
  scope?: PhaseScope;
}

export type PhaseOverrides = Record<string, PhaseOverride>;

export interface WorktreeInfo {
  phase_slug: string;
  path: string;
  branch: string;
}

// PhaseSession links a phase to the chat session that's executing it.
// One session per phase, spawned by the approve route after worktrees
// are created. Persisted on the plan so the UI can rebuild the link
// after a reload (chat sessions live in-memory; plans live on disk).
//
// Commit fields are populated when the user marks the phase complete
// via POST /api/plans/<id>/phases/<slug>/complete:
//   clean      → worktree had no uncommitted changes; we did nothing
//   committed  → ran `git add -A && git commit`; commit_sha is the new HEAD
//   failed     → tried to commit but git errored; commit_error has stderr
// Once any of these is set the row freezes its commit badge and won't
// re-attempt without explicit user action.
export type PhaseCommitStatus = "clean" | "committed" | "failed";

export interface PhaseSession {
  phase_slug: string;
  session_id: string;
  config_dir: string;
  account_name?: string;
  spawned_at: string;
  commit_status?: PhaseCommitStatus;
  commit_sha?: string;
  committed_at?: string;
  commit_error?: string;
  // Files touched by the phase commit that fell outside `phase.scope.files`.
  // Populated by the /complete route's post-commit check. Soft warning
  // only — the commit still lands and merge isn't blocked, but the UI
  // surfaces them so the user can review intentional vs accidental
  // scope creep. Empty/omitted = no violations or no scope declared.
  scope_violations?: string[];
  // Sha against which scope_violations was computed (typically the
  // merge-base with the integration branch). Recorded so the user can
  // independently re-run the diff if needed.
  scope_check_base?: string;
  // Per-phase code review (POST /api/plans/<id>/phases/<slug>/review).
  // A separate Claude session reads `<base>..HEAD` in the phase worktree
  // and reports findings via the submit_review MCP tool. Soft signal:
  // findings never block merge — the user reviews them and decides.
  //   running    → background agent in flight; UI polls until terminal
  //   complete   → submit_review fired; findings populated
  //   failed     → agent finished without calling submit_review (or the
  //                spawn itself errored). review_error has detail.
  review_status?: PhaseReviewStatus;
  review_started_at?: string;
  review_completed_at?: string;
  review_summary?: string;
  review_findings?: ReviewFinding[];
  review_error?: string;
  // Sha against which the review was run — typically HEAD at submit
  // time, but recorded so the user can replay the same diff later.
  review_base?: string;
}

export type PhaseReviewStatus = "running" | "complete" | "failed";

export type ReviewSeverity = "info" | "warning" | "error";

// ReviewFinding is the shape submit_review writes per issue. Keep it
// flat — a single finding may or may not be tied to a specific
// file/line. `category` is free-form (security, perf, style,
// correctness, …) so the agent can group thematically without us
// pinning a fixed taxonomy.
export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  category?: string;
}

export type PlanStatus = "submitted" | "approved" | "failed";

// PlanMergeStatus tracks the outcome of POST /api/plans/<id>/merge,
// which folds every wo/<plan>/<slug> phase branch into an integration
// branch (default main) on plan.cwd. Per-phase outcomes live on
// `merge_results` so the UI can show granularity (e.g. "3 merged, 1
// skipped, 1 failed"). Set on the plan in addition to PlanStatus —
// merge runs after `status === "approved"`, never replaces it.
//   pending  → at least one merge run was attempted but had failures;
//              the user can edit + retry without re-approving the plan
//   merged   → all phases reachable from integration HEAD
//   failed   → top-level abort (dirty tree, missing branch, etc.) with
//              no per-phase progress
export type PlanMergeStatus = "pending" | "merged" | "failed";

export interface PhaseMergeResult {
  phase_slug: string;
  branch: string;
  status: "merged" | "skipped" | "failed";
  sha?: string;
  error?: string;
}

// PlanIntegrationReviewStatus parallels PhaseReviewStatus but applies
// to the plan-level review run on the integration branch after every
// phase has merged. The reviewer reads the cumulative diff
// `<merge_base_sha>..<merge_head_sha>` so it can spot cross-phase
// issues a per-phase reviewer can't see (mismatched APIs across
// phases, redundant implementations, integration-only test gaps, ...).
export type PlanIntegrationReviewStatus = "running" | "complete" | "failed";

// PhasePending is a phase that has been approved (worktree exists,
// account is reserved) but not yet spawned because at least one of its
// `depends_on` phases hasn't reached commit_status ∈ {clean, committed}
// yet. The complete route releases pending phases as their deps clear:
// each successful commit triggers a re-evaluation that promotes any
// newly-eligible PhasePending into a real PhaseSession.
//
// Spawn defaults are SNAPSHOTTED at approve time so the cascade in the
// complete route doesn't depend on the owner session still being
// alive — by the time a deep-graph phase's deps clear, the user may
// have closed and re-opened the orchestrator.
export interface PhasePending {
  phase_slug: string;
  config_dir: string;
  account_name?: string;
  worktree_path: string;
  worktree_branch: string;
  // Owner-session fallbacks frozen at approve time. The actual spawn
  // still merges in per-phase overrides from `plan.phases[i].model` /
  // `.effort` first; these only fill gaps.
  owner_permission_mode: PermissionMode;
  owner_model?: string;
  owner_effort?: Effort;
}

// PhaseNote is a broadcast a phase can post to siblings via the
// submit_phase_note MCP tool. Use case: phase A renames a public API,
// changes a schema, swaps a library — notify siblings who might rely
// on the old shape so they can adapt without integration-time churn.
// Notes are append-only (no edit/delete from the agent side); list
// order is newest-first when surfaced.
export interface PhaseNote {
  id: string;
  phase_slug: string;
  body: string;
  tags?: string[];
  created_at: string;
}

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
  // Inter-phase broadcast log. Phases write via submit_phase_note and
  // read via list_phase_notes (both exposed by the phase_notes MCP
  // server, registered on each phase session). Persisted on the plan
  // so the UI can show them and so notes survive a session restart.
  notes?: PhaseNote[];
  // Phases approved-but-not-yet-spawned because their depends_on graph
  // is still settling. Each successful /complete checks this list and
  // promotes any phase whose deps are now in {clean, committed} into
  // a real PhaseSession.
  pending_phases?: PhasePending[];
  error?: string;
  merge_status?: PlanMergeStatus;
  merge_branch?: string;
  merge_results?: PhaseMergeResult[];
  // HEAD of the integration branch BEFORE the merge run started —
  // recorded by the /merge route so an integration review can diff
  // `merge_base_sha..merge_head_sha` to see exactly what the merge
  // contributed. Distinct from per-phase merge-base because phases
  // can have diverged from integration via several intermediate
  // commits and still be valid integration material.
  merge_base_sha?: string;
  merge_head_sha?: string;
  merged_at?: string;
  merge_error?: string;
  // Plan-level integration review (POST /api/plans/<id>/integration-review).
  // Spawned after a successful merge; reads the cumulative diff and
  // reports findings via submit_review. Soft signal — never blocks
  // anything; user reads + decides whether to follow up.
  integration_review_status?: PlanIntegrationReviewStatus;
  integration_review_started_at?: string;
  integration_review_completed_at?: string;
  integration_review_summary?: string;
  integration_review_findings?: ReviewFinding[];
  integration_review_error?: string;
  integration_review_base?: string;
  integration_review_head?: string;
  integration_review_branch?: string;
}
