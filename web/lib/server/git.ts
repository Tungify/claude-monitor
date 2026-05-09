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
