import { NextResponse } from "next/server";
import {
  assignPhaseAccounts,
  createWorktrees,
  type PhaseAssignment,
  type WorktreePhasePayload,
} from "@/lib/daemon";
import { readPlan, writePlan } from "@/lib/server/plans";
import {
  createSession,
  emitPlanEvent,
  getLatestPlan,
  getSession,
  sendMessage,
  setLatestPlan,
} from "@/lib/server/sessions";
import type { Phase, PhaseSession, PlanRecord } from "@/lib/plan-types";

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

// Build the kickoff prompt the phase agent receives as its first user
// turn. Conveys: which phase it owns, sibling phases (context-only,
// must not touch), branch + worktree, and explicit instructions to
// commit when done. Sibling list lets the agent reason about boundaries
// without any inter-phase coordination — each phase relies on the plan
// brief to stay in lane, not on reading siblings' WIP code.
function buildPhasePrompt(
  plan: PlanRecord,
  phase: Phase,
  worktreePath: string,
  branch: string,
): string {
  const siblings = plan.phases.filter((p) => p.slug !== phase.slug);
  const siblingLines =
    siblings.length === 0
      ? "_(none — this is the only phase)_"
      : siblings
          .map((p) => `- \`${p.slug}\` — ${p.title}`)
          .join("\n");

  return [
    `# Phase: ${phase.title}`,
    "",
    `You are the agent assigned to execute phase **${phase.slug}** of plan _"${plan.title}"_.`,
    "",
    "## Your brief",
    phase.description,
    "",
    "## Working environment",
    `- Worktree: \`${worktreePath}\``,
    `- Branch: \`${branch}\``,
    "- This worktree is your isolated copy of the repository. Other phases run in their own worktrees in parallel.",
    "",
    "## Sibling phases (context only — DO NOT modify their files)",
    siblingLines,
    "",
    "## Working agreement",
    "- Stay within the scope of your phase brief. If you hit work that belongs to a sibling, stop and surface it instead of silently expanding scope.",
    "- Run the project's tests/typecheck before declaring done.",
    "- When finished, `git add` your changes and create a commit on this branch with a clear message.",
    "- If you get blocked or need a decision, use the AskUserQuestion tool — do not guess.",
    "",
    "Begin.",
  ].join("\n");
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

  const phaseSessions: PhaseSession[] = [];
  const phaseBySlug = new Map(plan.phases.map((p) => [p.slug, p]));
  for (let i = 0; i < worktreesCreated.length; i++) {
    const wt = worktreesCreated[i];
    const phase = phaseBySlug.get(wt.phase_slug);
    if (!phase) continue; // shouldn't happen — daemon echoes back what we sent
    const assigned = assignments?.[i];
    const configDir = assigned?.config_dir ?? session.configDir;
    const accountName = assigned?.account_name ?? session.accountName;
    try {
      const summary = createSession({
        cwd: wt.path,
        configDir,
        accountName,
        model: session.model,
        effort: session.effort,
        permissionMode: session.permissionMode,
        planId: plan.id,
        phaseSlug: phase.slug,
      });
      sendMessage(summary.id, buildPhasePrompt(plan, phase, wt.path, wt.branch));
      phaseSessions.push({
        phase_slug: phase.slug,
        session_id: summary.id,
        config_dir: configDir,
        account_name: accountName,
        spawned_at: new Date().toISOString(),
      });
    } catch (err) {
      // One phase failing to spawn shouldn't void the whole approve —
      // record the missing slot and let the user retry that phase
      // manually. Worktree exists either way.
      console.error(`failed to spawn phase session for ${phase.slug}:`, err);
    }
  }

  plan.status = "approved";
  plan.approved_at = new Date().toISOString();
  plan.worktrees = worktreesCreated;
  plan.phase_sessions = phaseSessions;
  delete plan.error;
  await writePlan(plan);
  setLatestPlan(sessionId, plan);
  emitPlanEvent(sessionId, "plan_approved", plan);
  return NextResponse.json(plan);
}
