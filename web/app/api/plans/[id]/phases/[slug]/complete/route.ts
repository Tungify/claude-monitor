import { NextResponse } from "next/server";
import { autoCommitWorktree, checkPhaseScope } from "@/lib/server/git";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import { spawnReadyPending } from "@/lib/server/plan-scheduler";
import type { PhaseSession, PlanRecord } from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; slug: string }>;
}

// POST /api/plans/<plan-id>/phases/<phase-slug>/complete
//
// Marks a phase as user-complete: runs `git add -A && git commit` in
// the phase's worktree and pins the result onto the plan's
// PhaseSession entry so PhaseBoard can badge the row. Idempotent on a
// clean tree (no empty commits). Does NOT close the chat session — the
// user may want to reopen the agent for a follow-up; stopping is a
// separate UI affordance.
export async function POST(_req: Request, { params }: Ctx) {
  const { id: planId, slug } = await params;
  if (!planId || !slug) {
    return NextResponse.json(
      { error: "plan id and phase slug are required" },
      { status: 400 },
    );
  }

  const plan = await findPlanById(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }
  if (plan.status !== "approved") {
    return NextResponse.json(
      { error: "plan is not approved yet" },
      { status: 409 },
    );
  }

  const link = plan.phase_sessions?.find((p) => p.phase_slug === slug);
  if (!link) {
    return NextResponse.json(
      { error: `no phase session found for slug ${slug}` },
      { status: 404 },
    );
  }
  // Worktree path is recovered from plan.worktrees by slug. Daemon
  // owns the path layout (`~/claude-worktrees/<plan-id>/<slug>`); we
  // just trust what was persisted on approve. Path traversal is
  // already gated by the daemon's slug regex.
  const worktree = plan.worktrees?.find((w) => w.phase_slug === slug);
  if (!worktree) {
    return NextResponse.json(
      { error: `no worktree found for slug ${slug}` },
      { status: 404 },
    );
  }

  const result = await autoCommitWorktree({
    worktreePath: worktree.path,
    phaseSlug: slug,
  });

  // Best-effort scope check after the safety-net commit. Runs only
  // when the phase declared scope.files and the commit didn't fail
  // (clean trees still get checked — earlier commits by the model
  // would still be visible against the merge-base). Failures here are
  // non-fatal: log + skip persistence so the user gets a faster reply
  // and isn't blocked by a transient git error.
  const phaseDef = plan.phases.find((p) => p.slug === slug);
  let scopeViolations: string[] | undefined;
  let scopeBase: string | undefined;
  if (
    result.status !== "failed" &&
    phaseDef?.scope?.files &&
    phaseDef.scope.files.length > 0
  ) {
    const baseBranch = plan.merge_branch ?? "main";
    try {
      const check = await checkPhaseScope({
        worktreePath: worktree.path,
        baseBranch,
        scopeFiles: phaseDef.scope.files,
      });
      scopeViolations = check.violations;
      scopeBase = check.base;
    } catch (err) {
      console.warn(
        `[phase-complete] scope check failed for ${slug}:`,
        err,
      );
    }
  }

  const committedAt = new Date().toISOString();
  // newlySpawned is set inside the mutator below so the response can
  // include it. Declared outside because updatePlan's callback is
  // synchronous and we want to surface this hint to the UI.
  let newlySpawned: string[] = [];
  const updated = await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    if (!p.phase_sessions) return;
    const idx = p.phase_sessions.findIndex(
      (entry: PhaseSession) => entry.phase_slug === slug,
    );
    if (idx < 0) return;
    const next: PhaseSession = { ...p.phase_sessions[idx] };
    next.committed_at = committedAt;
    if (result.status === "clean") {
      next.commit_status = "clean";
      delete next.commit_sha;
      delete next.commit_error;
    } else if (result.status === "committed") {
      next.commit_status = "committed";
      next.commit_sha = result.sha;
      delete next.commit_error;
    } else {
      next.commit_status = "failed";
      next.commit_error = result.error;
      delete next.commit_sha;
    }
    if (scopeViolations !== undefined) {
      // Always replace — empty array means "we checked and found
      // nothing", which is meaningfully different from "we never
      // checked" (undefined). UI uses the distinction to render
      // the green "in scope" affordance vs no badge at all.
      next.scope_violations = scopeViolations;
      next.scope_check_base = scopeBase;
    }
    p.phase_sessions[idx] = next;
    // Now that this phase has a terminal commit_status, dependents
    // may be ready. spawnReadyPending mutates p in place: pending →
    // phase_sessions for each newly-released slug. A failed commit
    // does NOT release dependents (depsBlocking only counts
    // clean/committed as satisfied).
    if (result.status !== "failed") {
      newlySpawned = spawnReadyPending(p);
    }
  });

  return NextResponse.json({
    plan: updated,
    phase_session: updated.phase_sessions?.find((p) => p.phase_slug === slug),
    spawned_dependents: newlySpawned,
  });
}
