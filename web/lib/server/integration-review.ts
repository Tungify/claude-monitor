import "server-only";

import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AsyncQueue } from "./async-queue";
import { findClaudeBinary } from "./claude-binary";
import { findPlanById, updatePlan } from "./plans";
import {
  createReviewMcpServer,
  REVIEW_MCP_SERVER_NAME,
  SUBMIT_REVIEW_FQN,
  type ReviewSubmission,
} from "./review-mcp";
import type { Phase, PlanRecord } from "@/lib/plan-types";

const exec = promisify(execFile);

// Track in-flight integration reviews by plan id. Re-clicking the
// button while one is running short-circuits to the existing record
// instead of spawning a second agent.
const IN_FLIGHT_KEY = Symbol.for("claude-monitor.web.integration-review-in-flight");
type InFlightGlobal = typeof globalThis & {
  [IN_FLIGHT_KEY]?: Map<string, AbortController>;
};
const ig = globalThis as InFlightGlobal;
const inFlight: Map<string, AbortController> = (ig[IN_FLIGHT_KEY] ??= new Map());

export function isIntegrationReviewInFlight(planId: string): boolean {
  return inFlight.has(planId);
}

// Plan-level diffs are bigger than per-phase diffs (sum of all phases)
// so give the agent a longer ceiling. Still bounded to keep a runaway
// reviewer from sticking around.
const INTEGRATION_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

// Same read-only Bash policy as the per-phase reviewer. The agent
// reads merged commits via `git log` / `git diff` — no mutations.
const GIT_READONLY_PREFIXES = [
  "git diff",
  "git log",
  "git show",
  "git status",
  "git rev-parse",
  "git rev-list",
  "git branch",
  "git ls-files",
  "git blame",
  "git cat-file",
];

function isReadonlyGit(cmd: string): boolean {
  const trimmed = cmd.trim();
  for (const prefix of GIT_READONLY_PREFIXES) {
    if (trimmed === prefix) return true;
    if (trimmed.startsWith(prefix + " ")) return true;
  }
  return false;
}

interface RunIntegrationReviewOpts {
  planId: string;
  // Repo path the integration branch was merged into. Same as
  // plan.cwd; passed explicitly so test callers can swap it.
  repoPath: string;
  // Picked by the route from one of the phase sessions. The
  // integration review just needs *some* OAuth account to run on; the
  // user's already paying for any of them.
  configDir: string;
  // Branch the merge folded phases into. The reviewer diffs against
  // it at run-time so the user's working tree position is irrelevant.
  integrationBranch: string;
  // Pre-merge sha captured by the merge run. The cumulative diff is
  // `<baseSha>..<integrationBranch>` (or HEAD of the branch when the
  // caller already has the headSha). Falls back to the branch name
  // for the prompt only — git can't diff against an undefined ref.
  baseSha: string;
  headSha?: string;
  // Plan metadata for the prompt — title + ordered phase list with
  // descriptions. Lets the reviewer anchor commentary against intent
  // rather than reasoning from the raw diff alone.
  planTitle: string;
  phases: Phase[];
  // Inherited from the owner session (or per-phase override). Optional.
  model?: string;
  effort?: EffortLevel;
}

// runIntegrationReview spawns a one-shot SDK query in plan.cwd, asks
// the agent to review the cumulative diff between the pre-merge sha
// and the integration branch HEAD, and persists findings onto
// plan.integration_review_*. Fire-and-forget from the route — the
// PhaseBoard polls /api/plans/<id> while integration_review_status ===
// "running".
//
// Failure modes mirror runPhaseReview:
//   spawn throws            → integration_review_status: "failed", error captured
//   timeout                 → SDK aborted, status: "failed"
//   iterator drains without
//     submit_review          → status: "failed", "agent did not submit"
//   submit_review fires     → status: "complete", findings persisted
export async function runIntegrationReview(
  opts: RunIntegrationReviewOpts,
): Promise<void> {
  if (inFlight.has(opts.planId)) return;
  const abortController = new AbortController();
  inFlight.set(opts.planId, abortController);

  let submitted: ReviewSubmission | null = null;
  let errorMessage: string | undefined;
  const startedAt = new Date().toISOString();

  try {
    const kickoff = buildIntegrationPrompt({
      planTitle: opts.planTitle,
      phases: opts.phases,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      integrationBranch: opts.integrationBranch,
    });
    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const userMsg: SDKUserMessage = {
      type: "user",
      uuid: randomUUID() as SDKUserMessage["uuid"],
      session_id: randomUUID() as SDKUserMessage["session_id"],
      message: { role: "user", content: kickoff },
      parent_tool_use_id: null,
    };
    inputQueue.push(userMsg);
    inputQueue.end();

    const reviewMcp = createReviewMcpServer({
      onReviewSubmitted: (submission) => {
        if (submitted) return;
        submitted = submission;
        void persistComplete({
          planId: opts.planId,
          submission,
          startedAt,
          baseSha: opts.baseSha,
          headSha: opts.headSha,
          integrationBranch: opts.integrationBranch,
        });
      },
    });

    const claudeBin = findClaudeBinary();

    const canUseTool: CanUseTool = (toolName, input) => {
      if (toolName === SUBMIT_REVIEW_FQN) {
        return Promise.resolve<PermissionResult>({
          behavior: "allow",
          updatedInput: input,
        });
      }
      if (
        toolName === "Read" ||
        toolName === "Glob" ||
        toolName === "Grep"
      ) {
        return Promise.resolve<PermissionResult>({
          behavior: "allow",
          updatedInput: input,
        });
      }
      if (toolName === "Bash") {
        const cmd = (input as { command?: string }).command;
        if (typeof cmd === "string" && isReadonlyGit(cmd)) {
          return Promise.resolve<PermissionResult>({
            behavior: "allow",
            updatedInput: input,
          });
        }
        return Promise.resolve<PermissionResult>({
          behavior: "deny",
          message:
            "integration review may only run read-only git subcommands.",
        });
      }
      return Promise.resolve<PermissionResult>({
        behavior: "deny",
        message: `tool '${toolName}' is not available during integration review`,
      });
    };

    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, INTEGRATION_REVIEW_TIMEOUT_MS);

    let q: ReturnType<typeof query>;
    try {
      q = query({
        prompt: inputQueue,
        options: {
          cwd: opts.repoPath,
          env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
          ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
          permissionMode: "default",
          canUseTool,
          mcpServers: { [REVIEW_MCP_SERVER_NAME]: reviewMcp },
          abortController,
          sessionId: randomUUID(),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }

    try {
      for await (const _ of q) {
        void _;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!submitted) {
      const aborted = abortController.signal.aborted;
      errorMessage = aborted
        ? "integration review timed out before the agent submitted findings"
        : "agent finished its turn without calling submit_review";
    }
  } catch (err) {
    errorMessage =
      err instanceof Error ? err.message : String(err ?? "unknown error");
  } finally {
    inFlight.delete(opts.planId);
  }

  if (!submitted && errorMessage) {
    await persistFailed({
      planId: opts.planId,
      error: errorMessage,
      startedAt,
      baseSha: opts.baseSha,
      headSha: opts.headSha,
      integrationBranch: opts.integrationBranch,
    });
  }
}

// resolveIntegrationHead grabs the integration branch tip at the
// moment the route runs so the prompt + record name a concrete sha
// instead of a moving branch ref. Best-effort — a missing branch
// returns undefined and the prompt falls back to the branch name.
export async function resolveIntegrationHead(
  repoPath: string,
  integrationBranch: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", [
      "-C",
      repoPath,
      "rev-parse",
      `refs/heads/${integrationBranch}`,
    ]);
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

interface PersistRunningOpts {
  planId: string;
  startedAt: string;
  baseSha: string;
  headSha?: string;
  integrationBranch: string;
}

// persistRunning writes "running" to disk before the (long) agent
// spawn so the route can return an updated PlanRecord with the badge
// already flipped. Stale fields from a previous run are wiped so the
// UI doesn't blend old findings with the new one.
export async function persistRunning(
  opts: PersistRunningOpts,
): Promise<PlanRecord | null> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return null;
  return updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    p.integration_review_status = "running";
    p.integration_review_started_at = opts.startedAt;
    p.integration_review_base = opts.baseSha;
    p.integration_review_head = opts.headSha;
    p.integration_review_branch = opts.integrationBranch;
    delete p.integration_review_completed_at;
    delete p.integration_review_summary;
    delete p.integration_review_findings;
    delete p.integration_review_error;
  });
}

interface PersistCompleteOpts {
  planId: string;
  submission: ReviewSubmission;
  startedAt: string;
  baseSha: string;
  headSha?: string;
  integrationBranch: string;
}

async function persistComplete(opts: PersistCompleteOpts): Promise<void> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return;
  await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    p.integration_review_status = "complete";
    p.integration_review_started_at = opts.startedAt;
    p.integration_review_completed_at = new Date().toISOString();
    p.integration_review_summary = opts.submission.summary;
    p.integration_review_findings = opts.submission.findings;
    p.integration_review_base = opts.baseSha;
    p.integration_review_head = opts.headSha;
    p.integration_review_branch = opts.integrationBranch;
    delete p.integration_review_error;
  });
}

interface PersistFailedOpts {
  planId: string;
  error: string;
  startedAt: string;
  baseSha: string;
  headSha?: string;
  integrationBranch: string;
}

async function persistFailed(opts: PersistFailedOpts): Promise<void> {
  const plan = await findPlanById(opts.planId);
  if (!plan) return;
  await updatePlan(plan.cwd, plan.id, (p: PlanRecord) => {
    p.integration_review_status = "failed";
    p.integration_review_started_at = opts.startedAt;
    p.integration_review_completed_at = new Date().toISOString();
    p.integration_review_error = opts.error;
    p.integration_review_base = opts.baseSha;
    p.integration_review_head = opts.headSha;
    p.integration_review_branch = opts.integrationBranch;
  });
}

interface BuildIntegrationPromptOpts {
  planTitle: string;
  phases: Phase[];
  baseSha: string;
  headSha?: string;
  integrationBranch: string;
}

// The plan-level prompt differs from the phase-level one in two ways:
//   1. Diff range is explicit refs (no working-tree HEAD assumption)
//      because the user's checkout may not be on the integration
//      branch when this runs.
//   2. The reviewer is asked to focus on cross-phase coherence — API
//      mismatches, redundant implementations, integration-only test
//      gaps — not just per-hunk correctness which the per-phase
//      reviewer already covered.
function buildIntegrationPrompt(opts: BuildIntegrationPromptOpts): string {
  const headRef = opts.headSha ?? opts.integrationBranch;
  const lines: string[] = [];
  lines.push(
    `You are reviewing the integrated state of a multi-phase plan after every phase has been merged into \`${opts.integrationBranch}\`.`,
  );
  lines.push(``);
  lines.push(`## Plan`);
  lines.push(`- title: ${opts.planTitle}`);
  lines.push(`- integration branch: ${opts.integrationBranch}`);
  lines.push(`- diff range: \`${opts.baseSha}..${headRef}\``);
  lines.push(``);
  lines.push(`## Phases (in order)`);
  for (const phase of opts.phases) {
    lines.push(`- **${phase.slug}** — ${phase.title}`);
    lines.push(`    ${phase.description.replace(/\n+/g, " ").slice(0, 240)}`);
  }
  lines.push(``);
  lines.push(`## Your job`);
  lines.push(
    `Per-phase reviewers have already inspected each phase in isolation. **Your job is integration-level review** — finding issues that only show up when phases are combined.`,
  );
  lines.push(``);
  lines.push(`Look for:`);
  lines.push(
    `- Cross-phase API/contract mismatches (phase A's signature ≠ phase B's caller)`,
  );
  lines.push(
    `- Redundant or conflicting implementations across phases (two phases solving the same thing differently)`,
  );
  lines.push(
    `- Integration-only test gaps (each phase has unit tests, but the cross-phase happy path is untested)`,
  );
  lines.push(
    `- Incorrect assumptions about ordering when phases run in parallel (state shared via files/env/db)`,
  );
  lines.push(
    `- Build/typecheck breakages that only surface after merge (imports across phase boundaries)`,
  );
  lines.push(
    `- Migration/schema changes that depend on phase order (one phase adds a column another phase reads)`,
  );
  lines.push(``);
  lines.push(`## Steps`);
  lines.push(
    `1. \`git log --first-parent ${opts.baseSha}..${headRef}\` — see the merge commits, one per phase.`,
  );
  lines.push(
    `2. \`git diff --stat ${opts.baseSha}..${headRef}\` — file-level overview of the cumulative change.`,
  );
  lines.push(
    `3. \`git diff ${opts.baseSha}..${headRef}\` (or scoped per file when large) — inspect the actual changes.`,
  );
  lines.push(
    `4. \`Read\` files for surrounding context. Pay attention to imports/exports/types that thread between phases.`,
  );
  lines.push(
    `5. Call \`submit_review\` exactly once with a 1-3 sentence \`summary\` and a list of \`findings\`. If the integration looks coherent, pass an empty findings array and say so.`,
  );
  lines.push(``);
  lines.push(`## Severity`);
  lines.push(`- \`error\` — broken integration: type errors, missing wiring, contract mismatches that fail at runtime`);
  lines.push(`- \`warning\` — correctness or maintainability concern that spans phases`);
  lines.push(`- \`info\` — nit or aside the user should know about`);
  lines.push(``);
  lines.push(`## Constraints`);
  lines.push(
    `- Do **not** modify files. \`Edit\`, \`Write\`, and \`NotebookEdit\` are unavailable.`,
  );
  lines.push(`- Bash is restricted to read-only git subcommands.`);
  lines.push(
    `- Do not re-litigate per-phase findings already covered. Focus on what only emerges from combining phases.`,
  );
  return lines.join("\n");
}
