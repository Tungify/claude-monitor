import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Result discriminated union — callers either persist {status:"clean"} as a
// "phase ran but didn't change anything" marker, {status:"committed", sha}
// to badge the row with the new HEAD, or {status:"failed", error} to
// surface why git refused.
export type AutoCommitResult =
  | { status: "clean" }
  | { status: "committed"; sha: string }
  | { status: "failed"; error: string };

interface AutoCommitOpts {
  worktreePath: string;
  phaseSlug: string;
  // Author message override. Default: `phase: <slug> (auto)`. Kept short
  // so PRs that bundle the phase commit don't drown the rest of the log.
  message?: string;
}

// Use execFile (NOT exec/shell) so the worktree path can't be
// interpreted as anything other than a -C argument. The `git -C <path>`
// form means we never `cd` and never inherit shell expansion semantics.
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", ["-C", cwd, ...args], {
    // Plenty of headroom for `git status --porcelain` on a phase-sized
    // diff; commit / rev-parse output is small.
    maxBuffer: 16 * 1024 * 1024,
  });
}

// autoCommitWorktree is the safety-net the kickoff prompt's "git add +
// commit when done" agreement leans on: if the model forgot, we run it
// when the user clicks "complete". Idempotent: a clean tree returns
// {status:"clean"} instead of synthesizing an empty commit.
export async function autoCommitWorktree(
  opts: AutoCommitOpts,
): Promise<AutoCommitResult> {
  const { worktreePath, phaseSlug } = opts;
  const message = opts.message ?? `phase: ${phaseSlug} (auto)`;

  // Sanity-check the path is actually a git working tree before we
  // mutate it. Catches a stale plan record pointing at a worktree that
  // was removed out-of-band — without this we'd run `git add -A` from
  // an unrelated cwd ancestor and possibly stage things we shouldn't.
  try {
    await git(worktreePath, ["rev-parse", "--git-dir"]);
  } catch (err) {
    return {
      status: "failed",
      error: `not a git working tree at ${worktreePath}: ${formatErr(err)}`,
    };
  }

  let porcelain: string;
  try {
    const { stdout } = await git(worktreePath, ["status", "--porcelain"]);
    porcelain = stdout;
  } catch (err) {
    return { status: "failed", error: `git status: ${formatErr(err)}` };
  }
  if (porcelain.trim().length === 0) {
    return { status: "clean" };
  }

  try {
    await git(worktreePath, ["add", "-A"]);
  } catch (err) {
    return { status: "failed", error: `git add: ${formatErr(err)}` };
  }

  try {
    await git(worktreePath, ["commit", "-m", message]);
  } catch (err) {
    return { status: "failed", error: `git commit: ${formatErr(err)}` };
  }

  try {
    const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
    return { status: "committed", sha: stdout.trim() };
  } catch (err) {
    // Commit succeeded but rev-parse failed — odd. Report committed
    // without an sha rather than failed, because the actual commit
    // landed and we don't want the UI to suggest otherwise.
    return { status: "committed", sha: `unknown (${formatErr(err)})` };
  }
}

export interface PhaseScopeCheck {
  base: string;
  violations: string[];
}

interface PhaseScopeOpts {
  worktreePath: string;
  baseBranch: string;
  scopeFiles: string[];
}

// globToRegex compiles the small subset of glob syntax we expose to
// users (file scope declarations). Supports:
//   `**/` — zero or more directory components
//   `**`  — any chars including slashes (trailing only)
//   `*`   — any chars except slash
//   `?`   — single non-slash char
// All other chars match literally with regex metachars escaped. We
// intentionally do NOT pull in picomatch/minimatch — the surface area
// here is small, and a transitively-installed dep is fragile to depend
// on directly.
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        // **/  — match zero-or-more directory components, trailing slash
        // is optional so `**/foo` matches `foo` at root too.
        re += "(?:.*/)?";
        i += 2;
      } else {
        // ** without a trailing slash — bag of any chars including /
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (globToRegex(g).test(path)) return true;
  }
  return false;
}

// checkPhaseScope diffs HEAD against the merge-base with `baseBranch`
// (caller supplies — typically the integration target, defaults to
// "main"). Files touched by the phase but not matching any glob in
// `scopeFiles` are returned as `violations`. Soft check: callers
// surface as a warning, never block.
export async function checkPhaseScope(
  opts: PhaseScopeOpts,
): Promise<PhaseScopeCheck> {
  const { worktreePath, baseBranch, scopeFiles } = opts;
  const mb = await git(worktreePath, ["merge-base", "HEAD", baseBranch]);
  const base = mb.stdout.trim();
  if (base.length === 0) {
    // No merge-base = unrelated histories. Skip check rather than
    // claiming everything is in violation.
    return { base, violations: [] };
  }
  const diff = await git(worktreePath, [
    "diff",
    "--name-only",
    `${base}..HEAD`,
  ]);
  const touched = diff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const violations = touched.filter((p) => !matchesAnyGlob(p, scopeFiles));
  return { base, violations };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    // Promisified execFile attaches stderr to the error object; surface
    // it instead of the generic "Command failed" wrapper.
    const stderr = (err as Error & { stderr?: string }).stderr;
    if (stderr && stderr.trim().length > 0) return stderr.trim();
    return err.message;
  }
  return String(err);
}

export interface MergePhaseInput {
  phase_slug: string;
  branch: string;
}

export interface MergePhaseResult {
  phase_slug: string;
  branch: string;
  status: "merged" | "skipped" | "failed";
  sha?: string;
  error?: string;
}

// MergeBranchesResult differentiates a top-level abort (couldn't even
// start — dirty tree, missing integration branch) from a per-phase
// failure mid-loop. On per-phase failure we stop merging further phases
// (the integration branch state is now indeterminate and the user
// should resolve before retrying), but earlier successful merges stay
// in place.
export interface MergeBranchesResult {
  status: "ok" | "failed";
  integration_branch: string;
  results: MergePhaseResult[];
  // base_sha = HEAD of integrationBranch *before* this run started any
  // merges. Captured so callers (the integration-review agent) can
  // diff the cumulative contribution `base_sha..head_sha` even when
  // intermediate commits exist between phase merges (e.g. from a
  // previous partial run + retry).
  base_sha?: string;
  head_sha?: string;
  error?: string;
}

interface MergeBranchesOpts {
  repoPath: string;
  integrationBranch: string;
  phases: MergePhaseInput[];
  message?: (phase: MergePhaseInput) => string;
}

// mergePhaseBranches checks out integrationBranch in the main repo and
// runs `git merge --no-ff` for each phase branch in order. --no-ff
// preserves a discrete merge commit per phase so the user can
// `git revert -m 1 <sha>` to roll a single phase back without touching
// siblings. Idempotent: a branch already reachable from HEAD is reported
// as "skipped" rather than re-merged.
//
// Pre-flight refuses to run if the working tree is dirty — we don't
// want to risk shuffling the user's WIP when checking out the
// integration branch. Original HEAD is restored after the run (success
// or failure) so the user lands back where they started.
export async function mergePhaseBranches(
  opts: MergeBranchesOpts,
): Promise<MergeBranchesResult> {
  const { repoPath, integrationBranch, phases } = opts;
  const message =
    opts.message ?? ((p) => `Merge phase ${p.phase_slug} into ${integrationBranch}`);

  try {
    await git(repoPath, ["rev-parse", "--git-dir"]);
  } catch (err) {
    return {
      status: "failed",
      integration_branch: integrationBranch,
      results: [],
      error: `not a git working tree at ${repoPath}: ${formatErr(err)}`,
    };
  }

  let originalRef: string | null = null;
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const ref = stdout.trim();
    // Detached HEAD reports as "HEAD"; carry the sha instead so we can
    // still restore the user's vantage point.
    if (ref === "HEAD") {
      const head = await git(repoPath, ["rev-parse", "HEAD"]);
      originalRef = head.stdout.trim();
    } else {
      originalRef = ref;
    }
  } catch (err) {
    return {
      status: "failed",
      integration_branch: integrationBranch,
      results: [],
      error: `read HEAD: ${formatErr(err)}`,
    };
  }

  try {
    const { stdout } = await git(repoPath, ["status", "--porcelain"]);
    if (stdout.trim().length > 0) {
      return {
        status: "failed",
        integration_branch: integrationBranch,
        results: [],
        error:
          "working tree is dirty — commit or stash changes before merging phases",
      };
    }
  } catch (err) {
    return {
      status: "failed",
      integration_branch: integrationBranch,
      results: [],
      error: `git status: ${formatErr(err)}`,
    };
  }

  try {
    await git(repoPath, ["rev-parse", "--verify", `refs/heads/${integrationBranch}`]);
  } catch (err) {
    return {
      status: "failed",
      integration_branch: integrationBranch,
      results: [],
      error: `integration branch '${integrationBranch}' not found: ${formatErr(err)}`,
    };
  }

  try {
    await git(repoPath, ["checkout", integrationBranch]);
  } catch (err) {
    return {
      status: "failed",
      integration_branch: integrationBranch,
      results: [],
      error: `checkout ${integrationBranch}: ${formatErr(err)}`,
    };
  }

  // Snapshot HEAD of the integration branch *before* any merges run so
  // an integration-review agent can diff `base_sha..head_sha` later.
  // Best-effort: a missing base_sha just means review falls back to
  // diffing against branch refs at run time.
  let baseSha: string | undefined;
  try {
    const { stdout } = await git(repoPath, ["rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  } catch {
    // ignore — non-fatal
  }

  const results: MergePhaseResult[] = [];
  let topLevelError: string | undefined;
  let stoppedEarly = false;

  for (const phase of phases) {
    if (stoppedEarly) break;

    try {
      await git(repoPath, ["rev-parse", "--verify", `refs/heads/${phase.branch}`]);
    } catch (err) {
      results.push({
        phase_slug: phase.phase_slug,
        branch: phase.branch,
        status: "failed",
        error: `branch '${phase.branch}' not found: ${formatErr(err)}`,
      });
      stoppedEarly = true;
      break;
    }

    // is-ancestor exits 0 when branch is already reachable from HEAD —
    // i.e. the merge would be a no-op. Mark it skipped so the UI can
    // show "already merged" instead of re-running.
    let alreadyMerged = false;
    try {
      await git(repoPath, ["merge-base", "--is-ancestor", phase.branch, "HEAD"]);
      alreadyMerged = true;
    } catch {
      alreadyMerged = false;
    }

    if (alreadyMerged) {
      results.push({
        phase_slug: phase.phase_slug,
        branch: phase.branch,
        status: "skipped",
      });
      continue;
    }

    try {
      await git(repoPath, [
        "merge",
        "--no-ff",
        "-m",
        message(phase),
        phase.branch,
      ]);
      const head = await git(repoPath, ["rev-parse", "HEAD"]);
      results.push({
        phase_slug: phase.phase_slug,
        branch: phase.branch,
        status: "merged",
        sha: head.stdout.trim(),
      });
    } catch (err) {
      // Conflict (or any merge failure) — abort the in-flight merge so
      // the index/working-tree are clean before we hand control back.
      // Earlier merges in this run stay; the user has to resolve this
      // phase before retrying.
      try {
        await git(repoPath, ["merge", "--abort"]);
      } catch {
        // If --abort itself fails the repo is in a weird state but
        // nothing we can do here; surface the original merge error.
      }
      results.push({
        phase_slug: phase.phase_slug,
        branch: phase.branch,
        status: "failed",
        error: formatErr(err),
      });
      stoppedEarly = true;
    }
  }

  let headSha: string | undefined;
  try {
    const head = await git(repoPath, ["rev-parse", "HEAD"]);
    headSha = head.stdout.trim();
  } catch {
    // best-effort
  }

  // Restore the user's original ref. Best-effort — if it fails we don't
  // want to flip the entire merge to failed (the merges themselves
  // landed) but we do want to surface it.
  if (originalRef && originalRef !== integrationBranch) {
    try {
      await git(repoPath, ["checkout", originalRef]);
    } catch (err) {
      topLevelError = `merges applied; failed to restore original ref '${originalRef}': ${formatErr(err)}`;
    }
  }

  const anyFailure = results.some((r) => r.status === "failed");
  return {
    status: anyFailure ? "failed" : "ok",
    integration_branch: integrationBranch,
    results,
    base_sha: baseSha,
    head_sha: headSha,
    error: topLevelError,
  };
}
