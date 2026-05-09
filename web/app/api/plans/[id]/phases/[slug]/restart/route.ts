import { NextResponse } from "next/server";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import { spawnPhaseSession } from "@/lib/server/plan-scheduler";
import {
  snapshotSession,
  stopSession,
} from "@/lib/server/sessions";
import type { PhaseSession, PlanRecord } from "@/lib/plan-types";
import type { Effort, PermissionMode } from "@/lib/chat-types";

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

  // Recover the previous run's runtime config so the restart matches
  // what the user was running before. snapshotSession serves both live
  // and interrupted-on-disk sessions, so this works even after a daemon
  // restart wiped the in-memory ChatSession. permissionMode is the only
  // field with no good fallback if the snapshot is gone — default to
  // "default" rather than picking something the user didn't approve.
  const snap = snapshotSession(link.session_id);
  const prevModel = snap?.summary.model;
  const prevEffort = snap?.summary.effort as Effort | undefined;
  const prevPermissionMode =
    (snap?.summary.permission_mode as PermissionMode | undefined) ?? "default";

  // Stop FIRST so the new createSession can't collide with the old one
  // on cwd-scoped resources (the SDK keys some control-channel state by
  // cwd). Failures here aren't fatal — best-effort cleanup. If the old
  // session was already gone (e.g. interrupted from disk hydration),
  // stopSession just removes the shadow entry.
  try {
    await stopSession(link.session_id);
  } catch (err) {
    console.warn(
      `[phase-restart] stopSession ${link.session_id} failed (continuing):`,
      err,
    );
  }

  let fresh: PhaseSession;
  try {
    fresh = spawnPhaseSession({
      plan,
      phase,
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
      configDir: link.config_dir,
      accountName: link.account_name,
      permissionMode: prevPermissionMode,
      model: prevModel,
      effort: prevEffort,
    });
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

  const updated = await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    if (!p.phase_sessions) return;
    const idx = p.phase_sessions.findIndex((entry) => entry.phase_slug === slug);
    if (idx < 0) {
      // Shouldn't happen — we read the same plan a moment ago — but a
      // concurrent /complete that cleared the entry would land here.
      // Append rather than drop the new session on the floor.
      p.phase_sessions.push(fresh);
      return;
    }
    // Replace wholesale: a restart discards every per-attempt artifact
    // (commit, scope check, review). spawned_at on `fresh` is the new
    // session's birth time. Account / config_dir come from `fresh`
    // too — they match what the old link had since we re-used them.
    p.phase_sessions[idx] = fresh;
  });

  return NextResponse.json({
    plan: updated,
    phase_session: updated.phase_sessions?.find((p) => p.phase_slug === slug),
  });
}
