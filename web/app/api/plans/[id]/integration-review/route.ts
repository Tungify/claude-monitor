import { NextResponse } from "next/server";
import { findPlanById } from "@/lib/server/plans";
import {
  isIntegrationReviewInFlight,
  persistRunning,
  resolveIntegrationHead,
  runIntegrationReview,
} from "@/lib/server/integration-review";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// POST /api/plans/<plan-id>/integration-review
//
// Spawns a one-shot Claude session in plan.cwd that diffs the
// integration branch against the pre-merge sha and reports findings.
// Background job — same shape as per-phase review: marks running,
// returns the updated plan, lets the agent finish asynchronously.
//
// Gating:
//   - plan.status === "approved"
//   - plan.merge_status === "merged" (everything successfully landed;
//     a partial/failed merge means the diff range is meaningless)
//   - plan.merge_base_sha and merge_branch must be present so the
//     reviewer has a concrete diff range
//   - plan has at least one phase_session so we can pick a config_dir
//   - no integration review currently in flight for this plan
export async function POST(_req: Request, { params }: Ctx) {
  const { id: planId } = await params;
  if (!planId) {
    return NextResponse.json({ error: "plan id is required" }, { status: 400 });
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
  if (plan.merge_status !== "merged") {
    return NextResponse.json(
      {
        error:
          "integration review requires a fully-merged plan — run plan merge first",
      },
      { status: 409 },
    );
  }
  if (!plan.merge_branch) {
    return NextResponse.json(
      { error: "plan has no merge_branch recorded" },
      { status: 409 },
    );
  }
  if (!plan.merge_base_sha) {
    // Plans merged before merge_base_sha was added won't have it.
    // Surface a clear error rather than silently letting the reviewer
    // diff an undefined range.
    return NextResponse.json(
      {
        error:
          "plan has no merge_base_sha — re-run /merge to capture the diff range, then retry",
      },
      { status: 409 },
    );
  }

  // Pick any one of the phase sessions for the OAuth config_dir. They
  // all map to accounts the user has authorized; the reviewer just
  // needs *some* identity to talk to the API. Falls through to 409 if
  // for some reason there's no phase_sessions on the plan (shouldn't
  // happen post-approve but we guard anyway).
  const phaseSession = plan.phase_sessions?.[0];
  if (!phaseSession) {
    return NextResponse.json(
      { error: "plan has no phase_sessions to source a config_dir from" },
      { status: 409 },
    );
  }

  if (isIntegrationReviewInFlight(planId)) {
    return NextResponse.json({ plan, already_running: true }, { status: 202 });
  }

  const startedAt = new Date().toISOString();
  // Resolve the integration branch HEAD now so the prompt + record
  // pin a concrete sha. If resolution fails we fall back to the
  // recorded merge_head_sha — they should match anyway since /merge
  // wrote it on the same checkout.
  const headSha =
    (await resolveIntegrationHead(plan.cwd, plan.merge_branch)) ??
    plan.merge_head_sha;

  const updated = await persistRunning({
    planId,
    startedAt,
    baseSha: plan.merge_base_sha,
    headSha,
    integrationBranch: plan.merge_branch,
  });
  if (!updated) {
    return NextResponse.json(
      { error: "plan disappeared between read and persist" },
      { status: 500 },
    );
  }

  // Inherit model/effort from any phase that pinned them; otherwise
  // the SDK falls back to the user's default. We sample the first
  // phase that has them set so the user's per-phase override carries
  // through to the integration pass.
  const inheritedModel = plan.phases.find((p) => p.model)?.model;
  const inheritedEffort = plan.phases.find((p) => p.effort)?.effort;

  void runIntegrationReview({
    planId,
    repoPath: plan.cwd,
    configDir: phaseSession.config_dir,
    integrationBranch: plan.merge_branch,
    baseSha: plan.merge_base_sha,
    headSha,
    planTitle: plan.title,
    phases: plan.phases,
    model: inheritedModel,
    effort: inheritedEffort as EffortLevel | undefined,
  }).catch((err) => {
    console.error(
      `[integration-review] runIntegrationReview ${planId} crashed outside guarded path:`,
      err,
    );
  });

  return NextResponse.json({ plan: updated }, { status: 202 });
}
