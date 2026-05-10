import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// File-history powers the /rewind slash command. The Claude Code CLI
// snapshots files BEFORE each Edit/Write tool call so the user can later
// restore both the conversation and the on-disk state to a prior moment.
// We mirror the behavior here at session granularity:
//
//   ~/.claude-monitor/file-history/<sessionId>/
//     index.json     — append-only list of FileSnapshot
//     files/         — per-version backups, content-hashed names
//
// One FileSnapshot covers one tool call. Each tracked file gets one
// `BackupRef` (path + content hash + size) so we can dedupe across
// snapshots: if a file is unchanged between two consecutive Edit calls
// the second snapshot points at the same backup file as the first.
//
// Snapshots are tagged with `parentMessageId` (the most recent user
// message at capture time) so /rewind can group "everything that
// happened in response to user message X" and restore the pre-state
// of that group.

export interface BackupRef {
  // Absolute path of the original file on disk. We resolve relative
  // paths against the session cwd before recording.
  path: string;
  // Content-addressed name inside the per-session files/ dir. Same
  // content → same backup name → backup file is reused (one fs.write
  // per unique content per session). Includes a `.bin` suffix only
  // for clarity in directory listings.
  backupName: string;
  // Bytes, matching the original at snapshot time. Used by the picker
  // to show "restored 3 files (12 KB total)" without having to stat
  // each backup. Optional only because non-existent originals (a Write
  // creating a new file) record a sentinel entry with size=0.
  size: number;
  // True when the file did NOT exist at snapshot time. Restoring such
  // an entry deletes the path (the rewind brings the tree back to its
  // pre-existence state). Distinct from "empty file" (size=0, exists).
  absent?: boolean;
}

export interface FileSnapshot {
  id: string;
  // The most recent user message at capture time. Multiple snapshots
  // share the same parentMessageId when one user turn drives several
  // tool calls; /rewind groups by this so the picker doesn't surface
  // every micro-edit as its own restore point.
  parentMessageId?: string;
  // The tool call that triggered this snapshot. Surfaces in the
  // picker as a hint ("Edit: src/foo.ts") so the user understands
  // what was about to change.
  toolName: string;
  toolUseId?: string;
  // ISO-8601. The picker sorts ascending so the user reads the
  // timeline top-to-bottom.
  timestamp: string;
  files: BackupRef[];
}

interface IndexFile {
  version: 1;
  snapshots: FileSnapshot[];
}

const ROOT = path.join(os.homedir(), ".claude-monitor", "file-history");

function sessionDir(sessionId: string): string {
  return path.join(ROOT, sessionId);
}

function filesDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), "files");
}

function indexPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "index.json");
}

async function readIndex(sessionId: string): Promise<IndexFile> {
  try {
    const text = await fs.readFile(indexPath(sessionId), "utf-8");
    const parsed = JSON.parse(text) as Partial<IndexFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.snapshots)) {
      return { version: 1, snapshots: [] };
    }
    return { version: 1, snapshots: parsed.snapshots };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, snapshots: [] };
    }
    console.warn("[file-history] read index failed:", err);
    return { version: 1, snapshots: [] };
  }
}

async function writeIndex(sessionId: string, idx: IndexFile): Promise<void> {
  await fs.mkdir(sessionDir(sessionId), { recursive: true });
  const tmp = `${indexPath(sessionId)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2));
  await fs.rename(tmp, indexPath(sessionId));
}

// Snapshot cap matches the leaked CLI: keep the last 100 entries so
// long-running sessions don't blow out disk. We trim from the head and
// also delete any backup files that no other snapshot still points at.
const MAX_SNAPSHOTS = 100;

async function trimOldSnapshots(
  sessionId: string,
  idx: IndexFile,
): Promise<IndexFile> {
  if (idx.snapshots.length <= MAX_SNAPSHOTS) return idx;
  const drop = idx.snapshots.slice(0, idx.snapshots.length - MAX_SNAPSHOTS);
  const keep = idx.snapshots.slice(idx.snapshots.length - MAX_SNAPSHOTS);
  // Compute the set of backup names still referenced by surviving
  // snapshots; anything in `drop` that isn't referenced anymore can be
  // unlinked from disk to reclaim space.
  const live = new Set<string>();
  for (const s of keep) {
    for (const f of s.files) live.add(f.backupName);
  }
  for (const s of drop) {
    for (const f of s.files) {
      if (live.has(f.backupName)) continue;
      try {
        await fs.unlink(path.join(filesDir(sessionId), f.backupName));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            `[file-history] unlink ${f.backupName} failed:`,
            err,
          );
        }
      }
    }
  }
  return { version: 1, snapshots: keep };
}

// hashContent returns a deterministic backup file name from the file
// content. SHA-1 is fine here — we're not gating on collisions, just
// using the hash to dedupe identical bodies across snapshots.
function hashContent(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

async function readOriginal(
  filePath: string,
): Promise<{ buf: Buffer; absent: false } | { absent: true }> {
  try {
    const buf = await fs.readFile(filePath);
    return { buf, absent: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { absent: true };
    }
    throw err;
  }
}

async function copyBackup(
  sessionId: string,
  buf: Buffer,
  hash: string,
): Promise<string> {
  await fs.mkdir(filesDir(sessionId), { recursive: true });
  const name = `${hash}.bin`;
  const dest = path.join(filesDir(sessionId), name);
  // Skip if a previous snapshot already wrote this exact content —
  // backup files are content-addressed, so identical bodies share one
  // file. We verify size as a cheap sanity check.
  try {
    const stat = await fs.stat(dest);
    if (stat.size === buf.length) return name;
  } catch {
    // not present — fall through to write
  }
  await fs.writeFile(dest, buf);
  return name;
}

// Records pre-tool state for `paths`. Each path is read from disk; an
// absent file (Write creating a new file) records a sentinel entry so
// restore can delete the path on rewind. The session cwd is resolved
// against by callers — we expect absolute paths here.
//
// Returns the FileSnapshot that was appended. Callers can ignore the
// return when they only need the side effect.
export async function trackEdit(input: {
  sessionId: string;
  parentMessageId?: string;
  toolName: string;
  toolUseId?: string;
  paths: string[];
}): Promise<FileSnapshot | undefined> {
  const { sessionId, parentMessageId, toolName, toolUseId } = input;
  // Dedupe within a single tool call (e.g. MultiEdit can list the
  // same file twice). Order is preserved so the picker shows the
  // intended file the model targeted first.
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const p of input.paths) {
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  if (paths.length === 0) return undefined;

  const refs: BackupRef[] = [];
  for (const p of paths) {
    try {
      const r = await readOriginal(p);
      if (r.absent) {
        // Sentinel for files that don't exist yet — restoring this
        // entry deletes the file. We still write an entry (no backup)
        // so the snapshot enumerates every path the tool touched.
        refs.push({
          path: p,
          backupName: "",
          size: 0,
          absent: true,
        });
        continue;
      }
      const hash = hashContent(r.buf);
      const name = await copyBackup(sessionId, r.buf, hash);
      refs.push({ path: p, backupName: name, size: r.buf.length });
    } catch (err) {
      console.warn(`[file-history] snapshot ${p} failed:`, err);
      // Skip this path; the snapshot still records the others. Better
      // partial coverage than crashing the canUseTool gate.
    }
  }
  if (refs.length === 0) return undefined;

  const snap: FileSnapshot = {
    id: randomUUID(),
    parentMessageId,
    toolName,
    toolUseId,
    timestamp: new Date().toISOString(),
    files: refs,
  };

  let idx = await readIndex(sessionId);
  idx.snapshots.push(snap);
  idx = await trimOldSnapshots(sessionId, idx);
  await writeIndex(sessionId, idx);
  return snap;
}

export async function listSnapshots(
  sessionId: string,
): Promise<FileSnapshot[]> {
  const idx = await readIndex(sessionId);
  return idx.snapshots;
}

// Restores the on-disk state to BEFORE snapshot `snapshotId`. For each
// unique file path that appears in any snapshot at-or-after the chosen
// one, we write back the content captured by the earliest such
// snapshot — that's the file's pre-edit state at the chosen point.
//
// Files marked `absent` are unlinked (deleted) since they didn't exist
// at the rewind point.
//
// Returns a list of restore actions for the response payload so the UI
// can show "restored 3 files, deleted 1 newly-created file".
export interface RestoreFileAction {
  path: string;
  action: "wrote" | "deleted" | "skipped";
  reason?: string;
  size?: number;
}

export async function restoreCode(
  sessionId: string,
  snapshotId: string,
): Promise<RestoreFileAction[]> {
  const idx = await readIndex(sessionId);
  const start = idx.snapshots.findIndex((s) => s.id === snapshotId);
  if (start < 0) {
    throw new Error(`snapshot ${snapshotId} not found`);
  }
  const window = idx.snapshots.slice(start);
  // First-write wins per path: we want the EARLIEST captured pre-state
  // in the window, because that's what the file looked like before the
  // first tool ran at-or-after the rewind point.
  const seen = new Set<string>();
  const actions: RestoreFileAction[] = [];
  for (const snap of window) {
    for (const ref of snap.files) {
      if (seen.has(ref.path)) continue;
      seen.add(ref.path);
      try {
        if (ref.absent) {
          await fs.rm(ref.path, { force: true });
          actions.push({ path: ref.path, action: "deleted" });
          continue;
        }
        const src = path.join(filesDir(sessionId), ref.backupName);
        const buf = await fs.readFile(src);
        await fs.mkdir(path.dirname(ref.path), { recursive: true });
        await fs.writeFile(ref.path, buf);
        actions.push({
          path: ref.path,
          action: "wrote",
          size: buf.length,
        });
      } catch (err) {
        actions.push({
          path: ref.path,
          action: "skipped",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return actions;
}

// purgeSession wipes the whole history dir for this session. Called
// on session stop / clear so we don't leak backups for chats the user
// won't restore.
export async function purgeSession(sessionId: string): Promise<void> {
  try {
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
  } catch (err) {
    console.warn("[file-history] purge failed:", err);
  }
}

// Helpers for callers to extract target paths out of arbitrary tool
// inputs. Each Claude built-in tool that mutates files has a known
// shape; we centralise them here so the canUseTool hook isn't shot
// through with `if (toolName === "Edit") { ... }` cascades.
//
// Returns absolute paths (resolved against `cwd`) — the canUseTool
// callback knows the session cwd and passes it in.
export function pathsForTool(
  toolName: string,
  input: unknown,
  cwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== "string" || raw.length === 0) return;
    out.push(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
  };
  switch (toolName) {
    case "Edit":
    case "Write":
      push(o.file_path);
      break;
    case "MultiEdit":
      // Older shape: top-level file_path + edits[]; newer SDK ships
      // edits: [{ file_path, ... }]. Cover both.
      push(o.file_path);
      if (Array.isArray(o.edits)) {
        for (const e of o.edits) {
          if (e && typeof e === "object") {
            push((e as Record<string, unknown>).file_path);
          }
        }
      }
      break;
    case "NotebookEdit":
      push(o.notebook_path);
      break;
    default:
      // Bash with `>` / `>>` redirect could be tracked too but the
      // parsing is heuristic and would surprise users when it misses;
      // skip for now and revisit if /rewind feels incomplete in
      // practice.
      break;
  }
  return out;
}
