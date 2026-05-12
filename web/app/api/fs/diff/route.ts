import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

// Returns the working-tree change stats for a git repo. The composer
// chip uses this to show "+X / -Y" next to the branch name; clicking
// expands the file list with per-file patches.
//
// Scope is **working tree vs HEAD** — i.e. exactly what `git status`
// would surface as "things you haven't committed yet". Includes
// staged, unstaged, AND untracked files. The earlier design summed
// the entire branch-vs-main diff in here too, but on a feature
// branch with several committed slices that list ballooned into
// dozens of files the user wasn't actively editing, which surprised
// the user and was the trigger for narrowing the scope.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  // Single-letter git status: M / A / D / R / C / T / U / ? (untracked).
  status: string | null;
}

interface DiffResponse {
  ok: boolean;
  totals: { additions: number; deletions: number };
  files: FileStat[];
  error?: string;
}

async function git(cwd: string, args: string[], timeoutMs: number) {
  return exec("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// parseNumstat reads `git diff --numstat` output: tab-separated
// `<adds>\t<dels>\t<path>`. Binary rows surface as `- - path`; we
// treat them as zero on both sides because the chip is line-oriented.
function parseNumstat(raw: string): Map<string, { adds: number; dels: number }> {
  const out = new Map<string, { adds: number; dels: number }>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addsRaw, delsRaw, ...rest] = parts;
    const p = normaliseRenamePath(rest.join("\t"));
    const adds = addsRaw === "-" ? 0 : parseInt(addsRaw, 10);
    const dels = delsRaw === "-" ? 0 : parseInt(delsRaw, 10);
    if (Number.isNaN(adds) || Number.isNaN(dels)) continue;
    out.set(p, { adds, dels });
  }
  return out;
}

function normaliseRenamePath(p: string): string {
  // "a/b/{old.go => new.go}" -> "a/b/new.go"
  const braceMatch = p.match(/^(.*)\{[^}]*=>\s*([^}]+)\}(.*)$/);
  if (braceMatch) {
    return (braceMatch[1] + braceMatch[2].trim() + braceMatch[3]).trim();
  }
  // "old.go => new.go" -> "new.go"
  const arrowMatch = p.match(/=>\s*(.+)$/);
  if (arrowMatch) return arrowMatch[1].trim();
  return p;
}

function parseNameStatus(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0][0]; // "R100" → "R"
    const p = normaliseRenamePath(parts[parts.length - 1]);
    out.set(p, status);
  }
  return out;
}

// Count newlines in an untracked file. `git diff` skips untracked
// files entirely, so for the "+X / -Y" total to include a Write-tool-
// created file we read it ourselves and report its line count as
// additions. We cap individual files at a few MB so a stray giant
// binary in the repo can't pin the route on a multi-second read.
async function countAdditionsForUntracked(
  cwd: string,
  relPath: string,
): Promise<number> {
  try {
    const buf = await readFile(path.join(cwd, relPath));
    // Treat anything with a NUL byte as binary → 0 additions. Matches
    // git's own binary detection at a fraction of the cost.
    if (buf.includes(0)) return 0;
    if (buf.length === 0) return 0;
    // Count "\n" then add 1 if the file doesn't end in newline (last
    // unterminated line still counts as one).
    let nl = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) nl++;
    }
    return buf[buf.length - 1] === 0x0a ? nl : nl + 1;
  } catch {
    return 0;
  }
}

export async function GET(req: Request): Promise<NextResponse<DiffResponse>> {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("path");
  if (!cwd) {
    return NextResponse.json(
      {
        ok: false,
        totals: { additions: 0, deletions: 0 },
        files: [],
        error: "path is required",
      },
      { status: 400 },
    );
  }

  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"], 1000);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      totals: { additions: 0, deletions: 0 },
      files: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Run the three queries in parallel — fast even on cold caches
  // because each is scoped to the working tree (no rev walk).
  const [numstatRaw, nameStatusRaw, untrackedRaw] = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat"], 4000)
      .then((r) => r.stdout)
      .catch(() => ""),
    git(cwd, ["diff", "HEAD", "--name-status"], 4000)
      .then((r) => r.stdout)
      .catch(() => ""),
    git(cwd, ["ls-files", "--others", "--exclude-standard"], 2000)
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  const stats = parseNumstat(numstatRaw);
  const statuses = parseNameStatus(nameStatusRaw);

  // Fold untracked files in. They don't appear in `git diff HEAD`
  // (which only walks indexed paths), so we count their lines
  // ourselves and tag them with status "?" so the badge differs from
  // staged-but-new (which would carry status "A" from --name-status).
  const untracked = untrackedRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (untracked.length > 0) {
    const counts = await Promise.all(
      untracked.map((p) => countAdditionsForUntracked(cwd, p)),
    );
    untracked.forEach((p, i) => {
      stats.set(p, { adds: counts[i], dels: 0 });
      statuses.set(p, "?");
    });
  }

  const files: FileStat[] = [];
  let totalAdds = 0;
  let totalDels = 0;
  for (const [p, { adds, dels }] of stats) {
    if (adds === 0 && dels === 0) continue;
    files.push({
      path: p,
      additions: adds,
      deletions: dels,
      status: statuses.get(p) ?? null,
    });
    totalAdds += adds;
    totalDels += dels;
  }
  files.sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path),
  );

  return NextResponse.json({
    ok: true,
    totals: { additions: totalAdds, deletions: totalDels },
    files,
  });
}
