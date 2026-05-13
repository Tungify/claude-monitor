"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Loader2,
  Play,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { renderAnsi } from "@/lib/ansi";
import { cn } from "@/lib/utils";

interface ScriptInfo {
  kind: "npm" | "make";
  name: string;
  command?: string;
}

interface ScriptListResult {
  packageManager: "pnpm" | "yarn" | "bun" | "npm";
  scripts: ScriptInfo[];
}

interface OutputChunk {
  ts: string;
  stream: "stdout" | "stderr";
  data: string;
}

interface RunSnapshot {
  id: string;
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

interface ActiveRun {
  id: string;
  kind: "npm" | "make";
  name: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
}

// Soft byte cap for the in-memory tail rendered in the popover. Even
// though the server already trims its replay buffer, we receive every
// live chunk over SSE — for a long-running verbose script the React
// state would otherwise grow without bound and re-render the whole
// <pre> on each tick.
const CLIENT_OUTPUT_BYTES = 256 * 1024;

// Format an elapsed millisecond count as "1.4s" / "12s" / "2m 14s".
// Keeps the chip compact while still readable at every scale.
function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

// ScriptRunner renders a chip on the composer's top row that lets the
// user discover (package.json scripts + Makefile targets in the chat's
// cwd) and run them without leaving the chat. While a script is in
// flight it streams stdout/stderr into the popover and reports the
// "running" state back via `onRunningChange` so the parent composer
// can paint a subtle activity sweep across the row.
export function ScriptRunner({
  cwd,
  onRunningChange,
  className,
}: {
  cwd: string;
  onRunningChange?: (running: boolean) => void;
  className?: string;
}) {
  const [list, setList] = useState<ScriptListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Lazy initializer keeps useState pure — Date.now() is read once on
  // mount, then advanced by the 1Hz ticker effect below.
  const [now1Hz, setNow1Hz] = useState(() => Date.now());
  const esRef = useRef<EventSource | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const isRunning = run !== null && run.endedAt === null;
  const justFinished = run !== null && run.endedAt !== null;

  // Refetch the inventory each time the popover opens — package.json
  // and Makefile change frequently while the user is iterating, and
  // the cost (one fs read) is negligible compared to surfacing a stale
  // list.
  const loadScripts = useCallback(async () => {
    if (!cwd) return;
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(
        `/api/scripts/list?cwd=${encodeURIComponent(cwd)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ScriptListResult;
      setList(data);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    // One-shot fetch on cwd change. loadScripts sets state internally;
    // the cascading-render warning doesn't apply because it fires once
    // per cwd rather than in a loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadScripts();
  }, [loadScripts]);

  useEffect(() => {
    if (!open) return;
    // Refetch on popover open so an edited package.json shows up
    // without a full page reload. Same "fires once per user action"
    // shape as the mount fetch above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadScripts();
  }, [open, loadScripts]);

  // 1Hz tick drives the elapsed chip while a script is alive. Killed
  // the moment the run ends so we don't wake idle composers.
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow1Hz(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  useEffect(() => {
    onRunningChange?.(isRunning);
  }, [isRunning, onRunningChange]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // Auto-scroll the output panel to the tail as new chunks land — but
  // only if the user hasn't scrolled up themselves. Tracked via
  // `outputPinnedRef` so we don't fight the user's reading.
  const outputPinnedRef = useRef(true);
  useEffect(() => {
    const el = outputRef.current;
    if (!el || !outputPinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [run?.output]);

  // Just-finished runs linger for a beat so the user sees the
  // success/failure tick, then auto-dismiss back to the script list.
  // The popover is left alone (user might be reading output) — only
  // the chip itself collapses to its inert state.
  useEffect(() => {
    if (!justFinished) return;
    const t = setTimeout(() => setRun(null), 8000);
    return () => clearTimeout(t);
  }, [justFinished, run?.id]);

  const subscribeToRun = (runId: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/scripts/run/${runId}/stream`);
    esRef.current = es;
    es.addEventListener("snapshot", (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as RunSnapshot;
      const joined = snap.output.map((c) => c.data).join("");
      const trimmed =
        joined.length > CLIENT_OUTPUT_BYTES
          ? joined.slice(joined.length - CLIENT_OUTPUT_BYTES)
          : joined;
      setRun((prev) =>
        prev && prev.id === snap.id
          ? {
              ...prev,
              output: trimmed,
              endedAt: snap.endedAt,
              exitCode: snap.exitCode,
              signal: snap.signal,
              truncated:
                snap.truncated || trimmed.length < joined.length,
            }
          : prev,
      );
    });
    es.addEventListener("chunk", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as OutputChunk;
      setRun((prev) => {
        if (!prev || prev.id !== runId) return prev;
        // Mirror the server's byte cap on the client. The SSE pushes
        // every chunk it sees regardless of server-side trimming, so a
        // long-running verbose script can blow the React tree open
        // (each chunk re-renders the whole <pre>). Trim from the front
        // once we cross the cap and surface the truncation hint.
        const next = prev.output + data.data;
        if (next.length <= CLIENT_OUTPUT_BYTES) {
          return { ...prev, output: next };
        }
        const trimmed = next.slice(next.length - CLIENT_OUTPUT_BYTES);
        return { ...prev, output: trimmed, truncated: true };
      });
    });
    es.addEventListener("exit", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        code: number | null;
        signal: string | null;
        durationMs: number;
      };
      setRun((prev) =>
        prev && prev.id === runId
          ? {
              ...prev,
              endedAt: prev.startedAt + data.durationMs,
              exitCode: data.code,
              signal: data.signal,
            }
          : prev,
      );
      es.close();
    });
    es.onerror = () => {
      // The server closes the stream after exit; that fires onerror as
      // a side-effect. Only surface as an error if we never received an
      // exit event.
      setRun((prev) =>
        prev && prev.id === runId && prev.endedAt === null
          ? { ...prev, endedAt: Date.now(), exitCode: null }
          : prev,
      );
    };
  };

  const startScript = async (s: ScriptInfo) => {
    if (isRunning) return;
    setStartError(null);
    try {
      const res = await fetch("/api/scripts/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, kind: s.kind, name: s.name }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { runId: string };
      outputPinnedRef.current = true;
      setRun({
        id: data.runId,
        kind: s.kind,
        name: s.name,
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        signal: null,
        output: "",
        truncated: false,
      });
      subscribeToRun(data.runId);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async () => {
    if (!run || run.endedAt !== null) return;
    try {
      await fetch(`/api/scripts/run/${run.id}/cancel`, { method: "POST" });
    } catch {
      // exit event will still arrive once the kill lands
    }
  };

  // Forward a line of typed input to the child process's stdin.
  // We append "\n" here rather than asking callers to do it — every
  // call site is "user pressed Enter to send a line", and forgetting
  // the newline would leave the child blocked on its `read`.
  const sendInput = async (line: string) => {
    if (!run || run.endedAt !== null) return;
    try {
      await fetch(`/api/scripts/run/${run.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: line + "\n" }),
      });
    } catch {
      // Best-effort — if the request fails the user can retry by
      // typing again. We don't surface this as an error because the
      // most common cause is the child exiting between keystrokes,
      // which already shows up as the "done" state.
    }
  };

  const dismissRun = () => {
    setRun(null);
    setStartError(null);
  };

  const grouped = useMemo(() => {
    const npm: ScriptInfo[] = [];
    const make: ScriptInfo[] = [];
    for (const s of list?.scripts ?? []) {
      (s.kind === "make" ? make : npm).push(s);
    }
    return { npm, make };
  }, [list]);

  const elapsedMs = run ? (run.endedAt ?? now1Hz) - run.startedAt : 0;

  // Chip label adapts to state: inert "Scripts" button when idle,
  // spinner + script name + elapsed while running, or a final
  // ✓/✗ + duration once finished (before auto-dismiss).
  const renderChip = () => {
    if (isRunning && run) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin text-emerald-500" />
          <span className="truncate font-mono">{run.name}</span>
          <span className="tabular-nums text-muted-foreground">
            {fmtElapsed(elapsedMs)}
          </span>
        </span>
      );
    }
    if (justFinished && run) {
      const ok = run.exitCode === 0;
      return (
        <span className="inline-flex items-center gap-1.5">
          {ok ? (
            <Check className="size-3.5 text-emerald-500" />
          ) : (
            <X className="size-3.5 text-destructive" />
          )}
          <span className="truncate font-mono">{run.name}</span>
          <span className="tabular-nums text-muted-foreground">
            {fmtElapsed(elapsedMs)}
          </span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        <Terminal className="size-3.5" />
        <span>Scripts</span>
        <ChevronDown className="size-3 opacity-60" />
      </span>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={
              isRunning
                ? `Script ${run?.name} running`
                : "Open project scripts"
            }
            className={cn(
              "inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted",
              isRunning && "border-emerald-500/40 bg-emerald-500/[0.06]",
              justFinished &&
                run?.exitCode === 0 &&
                "border-emerald-500/40 bg-emerald-500/[0.06]",
              justFinished &&
                run?.exitCode !== 0 &&
                "border-destructive/40 bg-destructive/[0.06]",
              className,
            )}
          />
        }
      >
        {renderChip()}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
      >
        {run ? (
          <RunView
            run={run}
            elapsedMs={elapsedMs}
            onCancel={cancel}
            onDismiss={dismissRun}
            onInput={sendInput}
            outputRef={outputRef}
            onScroll={(pinned) => {
              outputPinnedRef.current = pinned;
            }}
          />
        ) : (
          <ListView
            list={list}
            loading={listLoading}
            error={listError ?? startError}
            onPick={(s) => void startScript(s)}
            onRefresh={() => void loadScripts()}
            grouped={grouped}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ListView({
  list,
  loading,
  error,
  onPick,
  onRefresh,
  grouped,
}: {
  list: ScriptListResult | null;
  loading: boolean;
  error: string | null;
  onPick: (s: ScriptInfo) => void;
  onRefresh: () => void;
  grouped: { npm: ScriptInfo[]; make: ScriptInfo[] };
}) {
  const empty =
    !loading && !error && grouped.npm.length === 0 && grouped.make.length === 0;

  return (
    <div className="flex max-h-[26rem] flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-medium">Project scripts</div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {list?.packageManager && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
              {list.packageManager}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="hover:text-foreground"
          >
            refresh
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </div>
        )}
        {error && (
          <div className="rounded bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}
        {empty && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No <span className="font-mono">package.json</span> scripts or
            Makefile targets found in this folder.
          </div>
        )}
        {grouped.npm.length > 0 && (
          <ScriptGroup
            title="package.json"
            items={grouped.npm}
            onPick={onPick}
          />
        )}
        {grouped.make.length > 0 && (
          <ScriptGroup title="Makefile" items={grouped.make} onPick={onPick} />
        )}
      </div>
    </div>
  );
}

function ScriptGroup({
  title,
  items,
  onPick,
}: {
  title: string;
  items: ScriptInfo[];
  onPick: (s: ScriptInfo) => void;
}) {
  return (
    <div className="px-1 pb-1">
      <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-0.5">
        {items.map((s) => (
          <li key={`${s.kind}-${s.name}`}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <Play className="mt-0.5 size-3 shrink-0 text-emerald-500 opacity-70 group-hover:opacity-100" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{s.name}</div>
                {s.command && (
                  <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {s.command}
                  </div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunView({
  run,
  elapsedMs,
  onCancel,
  onDismiss,
  onInput,
  outputRef,
  onScroll,
}: {
  run: ActiveRun;
  elapsedMs: number;
  onCancel: () => void;
  onDismiss: () => void;
  onInput: (line: string) => void | Promise<void>;
  outputRef: React.RefObject<HTMLDivElement | null>;
  onScroll: (pinned: boolean) => void;
}) {
  const finished = run.endedAt !== null;
  const ok = run.exitCode === 0;
  const status = !finished
    ? "running"
    : ok
      ? "done"
      : `failed (${run.exitCode ?? run.signal ?? "?"})`;
  const [stdinDraft, setStdinDraft] = useState("");

  const submitStdin = () => {
    void onInput(stdinDraft);
    setStdinDraft("");
  };

  const onStdinKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitStdin();
    }
  };

  // ANSI rendering is intentionally memoised on the raw string so the
  // expensive parse only runs when new bytes have actually arrived,
  // not on every parent re-render (1Hz elapsed tick, scroll changes,
  // etc.).
  const rendered = useMemo(() => renderAnsi(run.output), [run.output]);

  return (
    <div className="flex max-h-[28rem] flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {!finished ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" />
          ) : ok ? (
            <Check className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <X className="size-3.5 shrink-0 text-destructive" />
          )}
          <span className="truncate font-mono text-xs">{run.name}</span>
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
            {fmtElapsed(elapsedMs)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!finished ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] hover:bg-destructive/10 hover:text-destructive"
            >
              <Square className="size-2.5 fill-current" />
              stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] hover:bg-muted"
            >
              dismiss
            </button>
          )}
        </div>
      </div>
      <div
        ref={outputRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Pin to bottom when the user is within ~24px of it; reading
          // up scrolls them out of auto-follow mode.
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          onScroll(pinned);
        }}
        className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-zinc-950 p-2 font-mono text-[10.5px] leading-relaxed text-zinc-100"
      >
        {run.truncated && (
          <div className="mb-1 text-[10px] italic text-zinc-400">
            (older output trimmed)
          </div>
        )}
        {run.output ? (
          rendered
        ) : (
          <span className="text-zinc-400">
            {finished ? "(no output)" : "Waiting for output…"}
          </span>
        )}
      </div>
      {/* stdin row — only while the script is still alive. The child
          isn't on a TTY so prompts won't always look "real", but
          anything reading stdin via the normal `read`/`process.stdin`
          path will receive each line on Enter. */}
      {!finished && (
        <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
          <span className="font-mono text-[10.5px] text-muted-foreground select-none">
            $
          </span>
          <input
            type="text"
            value={stdinDraft}
            onChange={(e) => setStdinDraft(e.target.value)}
            onKeyDown={onStdinKey}
            placeholder="Type to send to stdin, press Enter"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={submitStdin}
            aria-label="Send line to stdin"
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CornerDownLeft className="size-3" />
            send
          </button>
        </div>
      )}
      <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        {status}
      </div>
    </div>
  );
}
