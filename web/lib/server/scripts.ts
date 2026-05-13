import "server-only";

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";

// One inventory entry — either a package.json script or a Makefile
// target. Kept lean so the GET /list payload is easy to render.
export interface ScriptInfo {
  kind: "npm" | "make";
  name: string;
  // For npm scripts this is the literal command string from
  // package.json so the popover can show what's about to run; Makefile
  // targets don't carry a useful one-liner so we leave it undefined.
  command?: string;
}

export interface ScriptListResult {
  // Detected package manager — drives which CLI we exec for npm
  // scripts. Falls back to npm when no lockfile is present so the
  // popover never lies; npm is universally available.
  packageManager: "pnpm" | "yarn" | "bun" | "npm";
  scripts: ScriptInfo[];
}

interface OutputChunk {
  // ISO timestamp. Useful when the client reconnects mid-stream and
  // wants to sort the buffered backlog.
  ts: string;
  stream: "stdout" | "stderr";
  data: string;
}

type RunListener = (
  ev:
    | { type: "chunk"; data: OutputChunk }
    | { type: "exit"; data: { code: number | null; signal: string | null; durationMs: number } },
) => void;

interface RunHandle {
  id: string;
  cwd: string;
  kind: "npm" | "make";
  name: string;
  packageManager: ScriptListResult["packageManager"];
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  // Append-only buffer for replay on a late SSE subscribe. Bounded
  // by BOTH a chunk count cap and a total-byte cap; older chunks fall
  // off the front when either limit is hit. The client sees a
  // "(truncated)" hint so it knows the tail is the only authoritative
  // slice.
  output: OutputChunk[];
  outputBytes: number;
  truncated: boolean;
  process: ChildProcessByStdio<Writable, Readable, Readable> | null;
  listeners: Set<RunListener>;
}

const RUNS: Map<string, RunHandle> = new Map();
const OUTPUT_BUFFER_CAP = 2000;
// Hard byte cap for the replay buffer. A verbose `pnpm install` can
// stream tens of MB; without a byte limit the chunk-count cap alone
// lets a single run pin a multi-hundred-MB working set until eviction.
// 1 MiB is plenty for "what failed at the bottom" tail viewing.
const OUTPUT_BUFFER_BYTES = 1024 * 1024;
// Drop finished runs from the in-memory map after this long so the
// process doesn't leak buffers indefinitely. Keep long enough that a
// brief refresh reconnects to the same run id and still gets the
// completed status + final tail.
const FINISHED_RUN_TTL_MS = 10 * 60 * 1000;

// ---- Discovery ----

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(
  cwd: string,
): Promise<ScriptListResult["packageManager"]> {
  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

async function readPackageScripts(cwd: string): Promise<ScriptInfo[]> {
  const p = path.join(cwd, "package.json");
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return [];
  }
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  return Object.entries(scripts).map(([name, command]) => ({
    kind: "npm" as const,
    name,
    command,
  }));
}

// Matches lines that look like `target:` or `target: deps...`. We skip
// special targets (.PHONY etc.), variable assignments (=, +=, ?=, :=),
// and pattern rules (`%.o:`). This is a heuristic — Makefiles can be
// arbitrarily nasty — but it gets the common case right.
const MAKE_TARGET_RE = /^([a-zA-Z_][a-zA-Z0-9_.\-]*)\s*:(?!=)/;

async function readMakefileTargets(cwd: string): Promise<ScriptInfo[]> {
  const candidates = ["Makefile", "makefile", "GNUmakefile"];
  let body: string | null = null;
  for (const name of candidates) {
    try {
      body = await readFile(path.join(cwd, name), "utf8");
      break;
    } catch {
      // try next candidate
    }
  }
  if (!body) return [];
  const seen = new Set<string>();
  const out: ScriptInfo[] = [];
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("\t") || line.startsWith(" ")) continue;
    const m = MAKE_TARGET_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith(".")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ kind: "make", name });
  }
  return out;
}

export async function listScripts(cwd: string): Promise<ScriptListResult> {
  const [packageManager, npm, make] = await Promise.all([
    detectPackageManager(cwd),
    readPackageScripts(cwd),
    readMakefileTargets(cwd),
  ]);
  return { packageManager, scripts: [...npm, ...make] };
}

// ---- Running ----

function cmdForRun(
  kind: "npm" | "make",
  name: string,
  pm: ScriptListResult["packageManager"],
): { cmd: string; args: string[] } {
  if (kind === "make") return { cmd: "make", args: [name] };
  if (pm === "pnpm") return { cmd: "pnpm", args: ["run", name] };
  if (pm === "yarn") return { cmd: "yarn", args: ["run", name] };
  if (pm === "bun") return { cmd: "bun", args: ["run", name] };
  return { cmd: "npm", args: ["run", name] };
}

function pushChunk(run: RunHandle, stream: "stdout" | "stderr", raw: string) {
  if (!raw) return;
  const chunk: OutputChunk = {
    ts: new Date().toISOString(),
    stream,
    data: raw,
  };
  run.output.push(chunk);
  run.outputBytes += raw.length;
  // Trim from the front whenever either bound trips. Loop because a
  // single huge chunk could put us multiple chunks over the byte cap.
  while (
    run.output.length > OUTPUT_BUFFER_CAP ||
    run.outputBytes > OUTPUT_BUFFER_BYTES
  ) {
    const dropped = run.output.shift();
    if (!dropped) break;
    run.outputBytes -= dropped.data.length;
    run.truncated = true;
  }
  for (const l of run.listeners) {
    try {
      l({ type: "chunk", data: chunk });
    } catch {
      // listener cleanup is handled by subscribe()'s unsubscribe path
    }
  }
}

export async function startRun(
  cwd: string,
  kind: "npm" | "make",
  name: string,
): Promise<{ runId: string }> {
  const pm = await detectPackageManager(cwd);
  const { cmd, args } = cmdForRun(kind, name, pm);
  const id = randomUUID();
  // detached: true puts the child in its own process group so we can
  // SIGTERM the whole tree on cancel (npm scripts routinely fork a
  // second process via sh -c). We don't unref — we want to keep the
  // Node process alive while a run is in flight.
  //
  // stdin is piped (not "ignore") so the popover can forward typed
  // input from the user — necessary whenever a script prompts for
  // y/n confirmation, a password, a choice, etc. We're not allocating
  // a pty, so tools that gate features on `isTTY` won't behave
  // exactly like a terminal, but anything that reads stdin via the
  // ordinary `read`/`process.stdin` path works fine.
  //
  // FORCE_COLOR=1 keeps colorized output enabled even though stdout
  // isn't a TTY — the client side parses ANSI SGR codes into styled
  // spans so logs read like they do in a terminal.
  const proc = spawn(cmd, args, {
    cwd,
    detached: true,
    env: { ...process.env, FORCE_COLOR: "1", CI: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const run: RunHandle = {
    id,
    cwd,
    kind,
    name,
    packageManager: pm,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    output: [],
    outputBytes: 0,
    truncated: false,
    process: proc,
    listeners: new Set(),
  };
  RUNS.set(id, run);

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (data: string) => pushChunk(run, "stdout", data));
  proc.stderr.on("data", (data: string) => pushChunk(run, "stderr", data));

  const finish = (code: number | null, signal: string | null) => {
    if (run.endedAt !== null) return;
    run.endedAt = Date.now();
    run.exitCode = code;
    run.signal = signal;
    run.process = null;
    const durationMs = run.endedAt - run.startedAt;
    for (const l of run.listeners) {
      try {
        l({ type: "exit", data: { code, signal, durationMs } });
      } catch {
        // listener cleanup handled elsewhere
      }
    }
    // Schedule eviction so the buffer doesn't sit around forever.
    setTimeout(() => {
      RUNS.delete(id);
    }, FINISHED_RUN_TTL_MS).unref();
  };

  proc.on("exit", (code, signal) => finish(code, signal));
  proc.on("error", (err) => {
    pushChunk(run, "stderr", `\n[spawn error] ${err.message}\n`);
    finish(null, null);
  });

  return { runId: id };
}

export function getRun(runId: string): RunHandle | undefined {
  return RUNS.get(runId);
}

export interface RunSnapshot {
  id: string;
  cwd: string;
  kind: "npm" | "make";
  name: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  output: OutputChunk[];
  running: boolean;
}

export function snapshotRun(runId: string): RunSnapshot | undefined {
  const r = RUNS.get(runId);
  if (!r) return undefined;
  return {
    id: r.id,
    cwd: r.cwd,
    kind: r.kind,
    name: r.name,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
    signal: r.signal,
    truncated: r.truncated,
    output: r.output.slice(),
    running: r.endedAt === null,
  };
}

export function subscribeRun(runId: string, cb: RunListener): () => void {
  const r = RUNS.get(runId);
  if (!r) return () => {};
  r.listeners.add(cb);
  return () => {
    r.listeners.delete(cb);
  };
}

// Forward a chunk of typed input to the child's stdin. We surface the
// echo back into the output buffer (tagged as stdout) so the popover
// shows what was sent — the child isn't running on a TTY so it won't
// echo typed input on its own, and seeing the prompt followed by a
// blank gap is confusing. Returns false when the run is gone, has
// already exited, or stdin is no longer writable.
export function writeInput(runId: string, data: string): boolean {
  const r = RUNS.get(runId);
  if (!r) return false;
  if (r.endedAt !== null) return false;
  const proc = r.process;
  if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
  try {
    proc.stdin.write(data);
    pushChunk(r, "stdout", data);
    return true;
  } catch {
    return false;
  }
}

export function cancelRun(runId: string): boolean {
  const r = RUNS.get(runId);
  if (!r) return false;
  if (r.endedAt !== null) return false;
  const proc = r.process;
  if (!proc || proc.pid === undefined) return false;
  try {
    // Negative pid targets the whole process group we created with
    // detached: true above. Falls through to a direct pid kill if the
    // group call rejects (some platforms / edge cases).
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
    // Escalate to SIGKILL if the child is still alive a moment later.
    setTimeout(() => {
      if (r.endedAt !== null) return;
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // give up — process likely already dead
        }
      }
    }, 3000).unref();
    return true;
  } catch {
    return false;
  }
}
