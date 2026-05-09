import "server-only";

import type {
  Phase,
  PhasePending,
  PhaseSession,
  PlanRecord,
} from "@/lib/plan-types";
import { createSession, sendMessage } from "@/lib/server/sessions";

// depsBlocking returns the slugs of dependencies that have NOT yet
// reached commit_status ∈ {clean, committed}. Empty array means the
// phase is unblocked and can be spawned. Callers compare arr.length
// rather than recompute the rule.
//
// A failed commit does NOT count as satisfied — the user has to retry
// /complete (which re-runs auto-commit) before dependents are released.
// This is intentional: if a foundational phase failed, dependents that
// rely on its API contract would be building on sand.
export function depsBlocking(plan: PlanRecord, slug: string): string[] {
  const phase = plan.phases.find((p) => p.slug === slug);
  if (!phase) return [];
  const deps = phase.depends_on ?? [];
  if (deps.length === 0) return [];
  const sessionByPhase = new Map(
    (plan.phase_sessions ?? []).map((s) => [s.phase_slug, s]),
  );
  const blocking: string[] = [];
  for (const dep of deps) {
    const session = sessionByPhase.get(dep);
    const status = session?.commit_status;
    if (status !== "clean" && status !== "committed") {
      blocking.push(dep);
    }
  }
  return blocking;
}

// buildPhasePrompt is the kickoff prompt every spawned phase receives
// as its first user turn. Conveys: which phase it owns, sibling phases
// (context-only — must not touch), branch + worktree, working
// agreement, inter-phase notes protocol, scope section if declared,
// TDD section if enabled. Lifted out of approve/route.ts so the
// /complete cascade can spawn pending phases with the same prompt.
export function buildPhasePrompt(
  plan: PlanRecord,
  phase: Phase,
  worktreePath: string,
  branch: string,
): string {
  const siblings = plan.phases.filter((p) => p.slug !== phase.slug);
  const siblingLines =
    siblings.length === 0
      ? "_(none — this is the only phase)_"
      : siblings.map((p) => `- \`${p.slug}\` — ${p.title}`).join("\n");

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

// spawnPhaseFromPending materializes one pending phase into a live
// session: createSession with the snapshotted config, sendMessage with
// the kickoff prompt, return the PhaseSession the caller should append
// to plan.phase_sessions. Throws on createSession failure — caller
// catches and decides whether to leave it pending or hard-fail.
export function spawnPhaseFromPending(
  plan: PlanRecord,
  phase: Phase,
  pending: PhasePending,
): PhaseSession {
  const summary = createSession({
    cwd: pending.worktree_path,
    configDir: pending.config_dir,
    accountName: pending.account_name,
    // Per-phase overrides take precedence over the owner snapshot.
    // Same precedence as the original approve flow.
    model: phase.model ?? pending.owner_model,
    effort: phase.effort ?? pending.owner_effort,
    permissionMode: pending.owner_permission_mode,
    planId: plan.id,
    phaseSlug: phase.slug,
  });
  sendMessage(
    summary.id,
    buildPhasePrompt(plan, phase, pending.worktree_path, pending.worktree_branch),
  );
  return {
    phase_slug: phase.slug,
    session_id: summary.id,
    config_dir: pending.config_dir,
    account_name: pending.account_name,
    spawned_at: new Date().toISOString(),
  };
}

// spawnReadyPending walks plan.pending_phases, spawns each one whose
// dependencies have all reached commit_status ∈ {clean, committed},
// and mutates the plan in place: pending → phase_sessions. Returns the
// list of newly-spawned slugs so the caller can log/return them.
//
// Iterative: a single call may release a small wave (e.g. two phases
// both blocked only on the just-committed phase). Does NOT cascade
// across multiple commits — that comes from successive /complete
// invocations, each calling this helper.
export function spawnReadyPending(plan: PlanRecord): string[] {
  if (!plan.pending_phases || plan.pending_phases.length === 0) return [];
  const phaseBySlug = new Map(plan.phases.map((p) => [p.slug, p]));
  if (!plan.phase_sessions) plan.phase_sessions = [];

  const stillPending: PhasePending[] = [];
  const newlySpawned: string[] = [];
  // Single pass — depsBlocking is computed against plan.phase_sessions
  // which reflects only sessions present BEFORE this call. Newly
  // spawned phases this pass are fresh and have no commit_status yet,
  // so they can't unblock anything else within the same call. The next
  // /complete on one of them does the next wave.
  for (const pending of plan.pending_phases) {
    const phase = phaseBySlug.get(pending.phase_slug);
    if (!phase) {
      // Phase definition vanished (shouldn't happen — plan.phases is
      // immutable post-approve). Drop the orphan rather than wedge.
      console.warn(
        `[plan-scheduler] orphaned pending phase ${pending.phase_slug} on plan ${plan.id}; dropping`,
      );
      continue;
    }
    const blocking = depsBlocking(plan, pending.phase_slug);
    if (blocking.length > 0) {
      stillPending.push(pending);
      continue;
    }
    try {
      const link = spawnPhaseFromPending(plan, phase, pending);
      plan.phase_sessions.push(link);
      newlySpawned.push(pending.phase_slug);
    } catch (err) {
      // One bad spawn shouldn't trap others. Leave this phase pending
      // — user can retry by re-running /complete on its blocking dep
      // (which re-evaluates).
      console.error(
        `[plan-scheduler] failed to spawn pending phase ${pending.phase_slug}:`,
        err,
      );
      stillPending.push(pending);
    }
  }

  plan.pending_phases = stillPending;
  return newlySpawned;
}
