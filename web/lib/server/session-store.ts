import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SDKMessage, EffortLevel } from "@anthropic-ai/claude-agent-sdk";

import type {
  ContextUsageBreakdown,
  PermissionMode,
  RateLimitInfo,
  SessionProvider,
  SessionUsage,
} from "@/lib/chat-types";
import type { PlanRecord } from "@/lib/plan-types";

// On-disk shape. Excludes everything tied to the live process —
// EventEmitter, AsyncQueue, AbortController, Query, pendingPermission /
// pendingQuestion (those carry resolve callbacks that can't survive a
// restart anyway). Status is intentionally NOT persisted: a crash mid
// "thinking" must come back as "interrupted", never as the stale state.
export interface StoredSession {
  // Schema version. Bump and add a migration if any field changes shape.
  version: 1;
  id: string;
  cwd: string;
  config_dir: string;
  account_name?: string;
  // ISO-8601. Date object can't survive JSON.
  created_at: string;
  model?: string;
  effort?: EffortLevel;
  // Persisted so a daemon restart resumes the session against the
  // same provider. Omitted entries default to "anthropic" on load.
  provider?: SessionProvider;
  permission_mode: PermissionMode;
  // Capped per HISTORY_CAP in sessions.ts; safe to dump verbatim.
  history: SDKMessage[];
  latest_usage?: SessionUsage;
  latest_context_usage?: ContextUsageBreakdown;
  latest_plan?: PlanRecord;
  // Phase-executor metadata. Set when this session was spawned by the
  // plan approve route to run a single phase. Persisted so the link
  // survives a daemon restart — phase boards rebuild from
  // PlanRecord.phase_sessions[], but the session row's grouping in the
  // sidebar still reads these fields directly.
  plan_id?: string;
  phase_slug?: string;
  // Most recent rate_limit_event observed on the session. Carried so
  // a session that hit a 5-hour cap right before a restart still shows
  // the badge / countdown after the daemon comes back.
  rate_limit?: RateLimitInfo;
  rate_limit_observed_at?: string;
}

// One JSON file per session keeps writes scoped (a 5MB conversation
// growing 1KB at a time doesn't rewrite every other session) and
// makes manual inspection trivial. Atomic writes via tmp+rename so a
// process crash mid-write can't leave a half-flushed file.
const STORAGE_DIR = path.join(os.homedir(), ".claude-monitor", "sessions");

function fileFor(id: string): string {
  return path.join(STORAGE_DIR, `${id}.json`);
}

function tmpFor(id: string): string {
  // Hidden + .tmp so a leftover from a crashed write is obvious and
  // never picked up by loadAll() (loadAll skips dotfiles).
  return path.join(STORAGE_DIR, `.${id}.json.tmp`);
}

// Loads every persisted session at process start. Bad files (corrupt
// JSON, old/unknown version, missing required fields) are skipped with
// a warning so one bad entry doesn't block the rest.
export async function loadAllStoredSessions(): Promise<StoredSession[]> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  let entries: string[];
  try {
    entries = await fs.readdir(STORAGE_DIR);
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for (const entry of entries) {
    // Skip dotfiles (.tmp leftovers, .DS_Store, ...) and non-json.
    if (entry.startsWith(".") || !entry.endsWith(".json")) continue;
    const full = path.join(STORAGE_DIR, entry);
    try {
      const text = await fs.readFile(full, "utf-8");
      const parsed = JSON.parse(text) as Partial<StoredSession>;
      if (
        parsed.version !== 1 ||
        typeof parsed.id !== "string" ||
        typeof parsed.cwd !== "string" ||
        typeof parsed.config_dir !== "string" ||
        typeof parsed.created_at !== "string" ||
        !Array.isArray(parsed.history)
      ) {
        console.warn(`[session-store] skipping ${entry}: shape invalid`);
        continue;
      }
      out.push(parsed as StoredSession);
    } catch (err) {
      console.warn(`[session-store] failed to load ${entry}:`, err);
    }
  }
  return out;
}

// Atomic write: tmp file + rename. fs.rename is atomic on POSIX (and
// effectively atomic on Windows for same-volume moves), so a reader
// will see either the old file or the new file, never a torn write.
export async function persistStoredSession(s: StoredSession): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const tmp = tmpFor(s.id);
  const final = fileFor(s.id);
  // Pretty-print at 0 indentation: the file isn't meant to be edited by
  // hand, and indentation balloons large transcripts 3-4x for nothing.
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, final);
}

// Removes a session's file. Idempotent — a missing file (already
// deleted, or the session was never persisted) is fine.
export async function deleteStoredSession(id: string): Promise<void> {
  try {
    await fs.unlink(fileFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
