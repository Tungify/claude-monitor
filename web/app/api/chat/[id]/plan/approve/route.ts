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
import type {
  Phase,
  PhaseOverrides,
  PhaseScope,
  PhaseSession,
  PlanRecord,
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

// Build the kickoff prompt the phase agent receives as its first user
// turn. Conveys: which phase it owns, sibling phases (context-only,
// must not touch), branch + worktree, and explicit instructions to
// commit when done. Sibling list lets the agent reason about boundaries
// without any inter-phase coordination — each phase relies on the plan
// brief to stay in lane, not on reading siblings' WIP code.
//
// TDD addendum (`phase.tdd_mode === true`) appends a step-1/2/3
// discipline to the working agreement: tests first, surface for review,
// implement until green. Light-touch — no scheduler change, just a
// stronger prompt the model commits to.
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

  const tddSection = phase.tdd_mode
    ? [
        "",
        "## TDD discipline (required for this phase)",
        "1. Write failing tests for the behavior described in your brief. Cover happy path + the edge cases you would actually exercise.",
        "2. Run the tests and confirm they fail for the right reason. Then **stop** — surface the test list and ask the user to confirm coverage before implementing.",
        "3. Only after step 2 is acknowledged: implement until the tests pass. Don't refactor until they're green.",
        "Skipping step 2 defeats the point — surface even if you think coverage is obvious.",
      ].join("\n")
    : "";

  const scopeSection =
    phase.scope?.files && phase.scope.files.length > 0
      ? [
          "",
          "## File scope (stay within these globs)",
          ...phase.scope.files.map((g) => `- \`${g}\``),
          "If you genuinely need to touch a file outside this list, **stop** and use AskUserQuestion to surface why before editing it. The post-commit check flags out-of-scope files as a warning so the user notices either way.",
        ].join("\n")
      : "";

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
    "## Coordinating with sibling phases",
    "- Sibling phases run in parallel — they cannot read your worktree. Use the `mcp__phase_notes__list_phase_notes` tool to read what they have already broadcast, and `mcp__phase_notes__submit_phase_note` to broadcast back when YOU change something they may rely on (API rename, schema/contract change, library swap, gotcha you discovered). Keep notes terse — 1-3 sentences. Do not narrate progress; broadcast only when a sibling could break or duplicate work without the heads-up.",
    "- Read notes once at the start, and again before you commit if your phase touched any shared interfaces.",
    scopeSection,
    tddSection,
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
        // Per-phase override falls back to the owner session's model/
        // effort. Owner session already has these set from the
        // composer toolbar — defaulting there preserves prior behavior
        // ("phases inherit from the user's current chat config").
        model: phase.model ?? session.model,
        effort: phase.effort ?? session.effort,
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
