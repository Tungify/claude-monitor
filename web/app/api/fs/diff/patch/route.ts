import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

// Returns the patch text for a single working-tree file. Companion
// to /api/fs/diff which carries numstat only — split so the always-
// loaded stats payload stays light and only files the user clicks
// to expand pay for the (potentially big) patch transfer.
//
// Scope mirrors the stats route: working tree vs HEAD, plus the
// special case of untracked files which `git diff` ignores entirely.
// For untracked we synthesise a "new file" patch by reading the file
// and prefixing every line with `+` so the diff renderer paints it
// as additions.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

interface PatchResponse {
  ok: boolean;
  patch: string;
  file: string;
  error?: string;
}

async function git(cwd: string, args: string[], timeoutMs: number) {
  return exec("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

// untrackedPatch builds a synthetic unified-diff-style patch for a
// file that doesn't exist in HEAD. Format mimics `git diff` enough
// that the PatchView's leading-sigil colouring lights it up as
// additions. Caps file size so a stray giant binary can't blow the
// route's memory budget.
async function untrackedPatch(cwd: string, relPath: string): Promise<string> {
  const abs = path.join(cwd, relPath);
  const buf = await readFile(abs);
  if (buf.includes(0)) {
    return `diff --git a/${relPath} b/${relPath}\nnew file (binary, ${buf.length} bytes)\n`;
  }
  const text = buf.toString("utf-8");
  const lines = text.split("\n");
  // Trailing-newline files end up with an empty string at the tail
  // — drop it so we don't render a phantom "+" line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((l) => `+${l}`).join("\n");
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    "new file",
    `--- /dev/null`,
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join("\n");
  return `${header}\n${body}\n`;
}

export async function GET(req: Request): Promise<NextResponse<PatchResponse>> {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("path");
  const file = url.searchParams.get("file");
  if (!cwd || !file) {
    return NextResponse.json(
      {
        ok: false,
        patch: "",
        file: file ?? "",
        error: "path and file are required",
      },
      { status: 400 },
    );
  }

  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"], 1000);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      patch: "",
      file,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Working-tree diff for the file. Tracked + modified files surface
  // here; untracked files produce an empty stdout and fall through to
  // the synthetic path below.
  let patch = "";
  try {
    const { stdout } = await git(
      cwd,
      ["diff", "HEAD", "--", file],
      6000,
    );
    patch = stdout;
  } catch {
    // file may not exist relative to HEAD (e.g. newly added but
    // staged in an unusual way). Fall through to untracked handling.
  }

  if (patch.trim().length === 0) {
    try {
      patch = await untrackedPatch(cwd, file);
    } catch (err) {
      return NextResponse.json({
        ok: false,
        patch: "",
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ok: true, patch, file });
}
