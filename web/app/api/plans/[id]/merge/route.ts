import { NextResponse } from "next/server";
import { mergePhaseBranches } from "@/lib/server/git";
import { findPlanById, updatePlan } from "@/lib/server/plans";
import type {
  PhaseMergeResult,
  PhaseSession,
  PlanRecord,
} from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  integration_branch?: string;
}

// Branch refs — refs/heads/<name> — are validated by `git rev-parse
// --verify` in the helper, but we still gate the user-facing input
// here with the same character class git enforces (no spaces, control
// chars, or shell metacharacters). Keeps the route resistant to
// surprises before we hand off to git.
const BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

// POST /api/plans/<plan-id>/merge
//
// Merges every wo/<plan>/<slug> phase branch into an integration branch
// on plan.cwd (default "main"). Gating:
//   - plan.status must be "approved"
//   - every phase must have a non-failed commit_status (clean or
//     committed) — phases the user hasn't completed yet, or whose
//     auto-commit failed, are excluded so the user has a chance to
//     resolve them first.
// Persists merge_status/merge_results/merge_head_sha/merged_at on the
// plan and returns the updated record. Idempotent on a fully-merged
// plan: every phase reports "skipped" and merge_status flips to
// "merged".
export async function POST(req: Request, { params }: Ctx) {
  const { id: planId } = await params;
  if (!planId) {
    return NextResponse.json({ error: "plan id is required" }, { status: 400 });
  }

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as Body;
    }
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const integrationBranch = (body.integration_branch ?? "main").trim();
  if (!integrationBranch || !BRANCH_RE.test(integrationBranch)) {
    return NextResponse.json(
      { error: "integration_branch must match [a-zA-Z0-9._-/]+" },
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
  if (!plan.worktrees || plan.worktrees.length === 0) {
    return NextResponse.json(
      { error: "plan has no worktrees recorded" },
      { status: 409 },
    );
  }

  const sessionsBySlug = new Map<string, PhaseSession>(
    (plan.phase_sessions ?? []).map((p) => [p.phase_slug, p]),
  );
  // Only merge phases the user has explicitly closed out. "no
  // commit_status" means the user hasn't clicked complete yet; "failed"
  // means the auto-commit blew up and they should retry it before this
  // phase's WIP is merged. Either way → exclude. We surface the gate as
  // a 409 with the offending slugs so the UI can prompt the user.
  const ineligible: string[] = [];
  for (const phase of plan.phases) {
    const link = sessionsBySlug.get(phase.slug);
    const status = link?.commit_status;
    if (status !== "clean" && status !== "committed") {
      ineligible.push(phase.slug);
    }
  }
  if (ineligible.length > 0) {
    return NextResponse.json(
      {
        error: "not all phases are committed",
        ineligible,
      },
      { status: 409 },
    );
  }

  const phaseBranches = plan.worktrees.map((wt) => ({
    phase_slug: wt.phase_slug,
    branch: wt.branch,
  }));

  const result = await mergePhaseBranches({
    repoPath: plan.cwd,
    integrationBranch,
    phases: phaseBranches,
  });

  const mergedAt = new Date().toISOString();
  const updated = await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    p.merge_branch = integrationBranch;
    p.merge_results = result.results.map(
      (r): PhaseMergeResult => ({
        phase_slug: r.phase_slug,
        branch: r.branch,
        status: r.status,
        sha: r.sha,
        error: r.error,
      }),
    );
    p.merge_base_sha = result.base_sha;
    p.merge_head_sha = result.head_sha;
    p.merged_at = mergedAt;
    // Re-running merge invalidates any prior integration review — the
    // diff range is no longer the same. Clear stale fields so the UI
    // doesn't claim "clean review" for a brand-new merge.
    delete p.integration_review_status;
    delete p.integration_review_started_at;
    delete p.integration_review_completed_at;
    delete p.integration_review_summary;
    delete p.integration_review_findings;
    delete p.integration_review_error;
    delete p.integration_review_base;
    delete p.integration_review_head;
    delete p.integration_review_branch;
    if (result.error) {
      p.merge_error = result.error;
    } else {
      delete p.merge_error;
    }
    if (result.status === "ok" && result.results.length > 0) {
      p.merge_status = "merged";
    } else if (result.status === "failed" && result.results.length === 0) {
      p.merge_status = "failed";
    } else {
      // Mixed: some merges landed, others didn't. Use "pending" so the
      // UI shows partial progress and the user can retry to pick up
      // the rest.
      p.merge_status = "pending";
    }
  });

  return NextResponse.json({ plan: updated, merge: result });
}
