import { NextResponse } from "next/server";
import { createWorktrees, type WorktreePhasePayload } from "@/lib/daemon";
import { readPlan, writePlan } from "@/lib/server/plans";
import {
  emitPlanEvent,
  getLatestPlan,
  getSession,
  setLatestPlan,
} from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  plan_id: string;
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
  const phases: WorktreePhasePayload[] = plan.phases.map((p) => ({
    slug: p.slug,
    branch: branchFor(plan.id, p.slug),
  }));

  try {
    const { worktrees } = await createWorktrees({
      plan_id: plan.id,
      repo_path: plan.cwd,
      phases,
    });
    plan.status = "approved";
    plan.approved_at = new Date().toISOString();
    plan.worktrees = worktrees;
    delete plan.error;
    await writePlan(plan);
    setLatestPlan(sessionId, plan);
    emitPlanEvent(sessionId, "plan_approved", plan);
    return NextResponse.json(plan);
  } catch (err) {
    plan.status = "failed";
    plan.error = err instanceof Error ? err.message : String(err);
    await writePlan(plan);
    setLatestPlan(sessionId, plan);
    emitPlanEvent(sessionId, "plan_failed", plan);
    return NextResponse.json(
      { error: plan.error, plan },
      { status: 502 },
    );
  }
}
