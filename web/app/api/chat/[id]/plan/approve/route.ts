import { NextResponse } from "next/server";
import {
  assignPhaseAccounts,
  createWorktrees,
  type PhaseAssignment,
  type WorktreePhasePayload,
} from "@/lib/daemon";
import { readPlan, writePlan } from "@/lib/server/plans";
import {
  emitPlanEvent,
  getLatestPlan,
  getSession,
  setLatestPlan,
} from "@/lib/server/sessions";
import { spawnReadyPending } from "@/lib/server/plan-scheduler";
import type {
  PhaseOverrides,
  PhasePending,
  PhaseScope,
} from "@/lib/plan-types";
import type { Effort } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  plan_id: string;
  // Per-phase edits made in PlanCard before approve. Merged into the
  // plan record on disk before spawning so the persisted plan reflects
  // what actually ran. Unknown slugs in the map are ignored (defensive
  // — UI shouldn't send them).
  phase_overrides?: PhaseOverrides;
}

const VALID_EFFORTS: ReadonlySet<Effort> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// Sanitize a single user-supplied override entry. Drops unknown effort
// values and empty strings so downstream code can rely on the shape.
// scope.files is normalized to a deduped non-empty trimmed string array
// so the kickoff prompt and post-commit check don't have to re-validate.
function sanitizeOverride(raw: unknown): {
  model?: string;
  effort?: Effort;
  tdd_mode?: boolean;
  scope?: PhaseScope;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: {
    model?: string;
    effort?: Effort;
    tdd_mode?: boolean;
    scope?: PhaseScope;
  } = {};
  if (typeof r.model === "string" && r.model.trim().length > 0) {
    out.model = r.model.trim();
  }
  if (typeof r.effort === "string" && VALID_EFFORTS.has(r.effort as Effort)) {
    out.effort = r.effort as Effort;
  }
  if (typeof r.tdd_mode === "boolean") {
    out.tdd_mode = r.tdd_mode;
  }
  if (r.scope && typeof r.scope === "object") {
    const rawScope = r.scope as Record<string, unknown>;
    if (Array.isArray(rawScope.files)) {
      const seen = new Set<string>();
      const files: string[] = [];
      for (const entry of rawScope.files) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        files.push(trimmed);
      }
      // Empty array vs undefined matters: empty means "user explicitly
      // cleared the scope" — propagate so the on-disk plan reflects it.
      out.scope = { files };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Branch convention: `wo/<plan-id-short>/<slug>`. Short prefix keeps
// branch names manageable (full UUID is verbose) while still avoiding
// collisions across plans within a single repo.
function branchFor(planId: string, slug: string): string {
  const short = planId.slice(0, 8);
  return `wo/${short}/${slug}`;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id: sessionId } = await params;
  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.plan_id) {
    return NextResponse.json({ error: "plan_id is required" }, { status: 400 });
  }

  const latest = getLatestPlan(sessionId);
  // Approve must target the plan currently surfaced in the panel. A
  // newer submit_plan call between submit and approve should invalidate
  // the older approval — otherwise the user would okay the wrong plan.
  if (!latest || latest.id !== body.plan_id) {
    return NextResponse.json(
      { error: "plan_id does not match the latest plan for this session" },
      { status: 409 },
    );
  }
  if (latest.status === "approved") {
    return NextResponse.json({ error: "plan already approved" }, { status: 409 });
  }

  const plan = await readPlan(latest.cwd, latest.id);

  // Apply per-phase overrides from PlanCard. We mutate plan.phases in
  // place before persisting so the on-disk plan reflects what actually
  // ran — matters for retro reads of the PhaseBoard and for the
  // upcoming integration agent which inspects phase metadata.
  if (body.phase_overrides) {
    for (const phase of plan.phases) {
      const raw = body.phase_overrides[phase.slug];
      const sanitized = sanitizeOverride(raw);
      if (!sanitized) continue;
      if (sanitized.model !== undefined) phase.model = sanitized.model;
      if (sanitized.effort !== undefined) phase.effort = sanitized.effort;
      if (sanitized.tdd_mode !== undefined) phase.tdd_mode = sanitized.tdd_mode;
      if (sanitized.scope !== undefined) {
        // Empty files array → drop the scope entirely so the kickoff
        // prompt and check both treat the phase as "no declared scope"
        // rather than "scope = nothing allowed".
        if (!sanitized.scope.files || sanitized.scope.files.length === 0) {
          delete phase.scope;
        } else {
          phase.scope = { ...phase.scope, files: sanitized.scope.files };
        }
      }
    }
  }

  const phases: WorktreePhasePayload[] = plan.phases.map((p) => ({
    slug: p.slug,
    branch: branchFor(plan.id, p.slug),
  }));

  let worktreesCreated;
  try {
    const result = await createWorktrees({
      plan_id: plan.id,
      repo_path: plan.cwd,
      phases,
    });
    worktreesCreated = result.worktrees;
  } catch (err) {
    plan.status = "failed";
    plan.error = err instanceof Error ? err.message : String(err);
    await writePlan(plan);
    setLatestPlan(sessionId, plan);
    emitPlanEvent(sessionId, "plan_failed", plan);
    return NextResponse.json({ error: plan.error, plan }, { status: 502 });
  }

  // Pick one OAuth account per phase, ranked by lowest 5h utilization,
  // so parallel phases don't pile onto the busiest account. Daemon
  // round-robins when phase count > eligible pool size. Failure here
  // is a soft fall-through to the owning session's account — better to
  // run all phases on one account than refuse to launch anything.
  let assignments: PhaseAssignment[] | null = null;
  try {
    const r = await assignPhaseAccounts({ count: worktreesCreated.length });
    if (r.assignments.length === worktreesCreated.length) {
      assignments = r.assignments;
    }
  } catch (err) {
    console.warn(
      "phase account assignment failed; falling back to owner session account:",
      err,
    );
  }

  // Build a PhasePending entry for every phase up-front, then let the
  // scheduler decide which ones can spawn now (deps already satisfied,
  // i.e. no deps) versus which stay pending. Owner session config is
  // SNAPSHOTTED here so a later /complete cascade — possibly fired
  // after the orchestrator was restarted — has everything it needs to
  // spawn dependents without rehydrating the owner session.
  const pending: PhasePending[] = [];
  const worktreeBySlug = new Map(
    worktreesCreated.map((w) => [w.phase_slug, w]),
  );
  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i];
    const wt = worktreeBySlug.get(phase.slug);
    if (!wt) continue; // shouldn't happen — daemon echoes back what we sent
    const assigned = assignments?.[i];
    const configDir = assigned?.config_dir ?? session.configDir;
    const accountName = assigned?.account_name ?? session.accountName;
    pending.push({
      phase_slug: phase.slug,
      config_dir: configDir,
      account_name: accountName,
      worktree_path: wt.path,
      worktree_branch: wt.branch,
      owner_permission_mode: session.permissionMode,
      owner_model: session.model,
      owner_effort: session.effort,
    });
  }

  plan.status = "approved";
  plan.approved_at = new Date().toISOString();
  plan.worktrees = worktreesCreated;
  plan.phase_sessions = [];
  plan.pending_phases = pending;
  delete plan.error;

  // First-wave spawn: every phase with no depends_on (or only deps
  // already in {clean,committed}, which can't happen at approve time
  // since nothing has been committed yet) goes live immediately.
  // Subsequent waves are released by /complete as parents commit.
  spawnReadyPending(plan);

  await writePlan(plan);
  setLatestPlan(sessionId, plan);
  emitPlanEvent(sessionId, "plan_approved", plan);
  return NextResponse.json(plan);
}
