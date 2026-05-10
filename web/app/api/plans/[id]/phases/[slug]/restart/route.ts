import { NextResponse } from "next/server";
import { findPlanById } from "@/lib/server/plans";
import { restartPhaseSession } from "@/lib/server/plan-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; slug: string }>;
}

// POST /api/plans/<plan-id>/phases/<phase-slug>/restart
//
// Tears down the phase's current chat session and spawns a fresh one in
// the same worktree, with the same configDir/account, replaying the
// kickoff prompt. Lets the user recover from an errored or off-track
// phase without re-approving the whole plan.
//
// Refuses to restart a phase that's already committed (clean or
// committed) — any work the previous attempt produced lives in the
// worktree, and a restart would orphan it from the dependents that
// already used the commit as their unblock signal. The user can revert
// the commit manually and retry if they really want a do-over.
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

  const phase = plan.phases.find((p) => p.slug === slug);
  if (!phase) {
    return NextResponse.json(
      { error: `phase '${slug}' not found in plan` },
      { status: 404 },
    );
  }
  const link = plan.phase_sessions?.find((p) => p.phase_slug === slug);
  if (!link) {
    return NextResponse.json(
      { error: `no phase session found for slug '${slug}'` },
      { status: 404 },
    );
  }
  if (link.commit_status === "clean" || link.commit_status === "committed") {
    return NextResponse.json(
      {
        error:
          "phase is already committed — restart would orphan dependents that have already advanced past it. Revert the commit manually if you really want a do-over.",
      },
      { status: 409 },
    );
  }
  const worktree = plan.worktrees?.find((w) => w.phase_slug === slug);
  if (!worktree) {
    return NextResponse.json(
      { error: `no worktree found for slug '${slug}'` },
      { status: 404 },
    );
  }

  try {
    const { plan: updated, link: fresh } = await restartPhaseSession({
      plan,
      phase,
      link,
      worktree,
    });
    return NextResponse.json({ plan: updated, phase_session: fresh });
  } catch (err) {
    return NextResponse.json(
      {
        error: `failed to spawn replacement session: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 },
    );
  }
}
