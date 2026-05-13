"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Octagon,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type { BackgroundTask, BackgroundTaskStatus } from "@/lib/chat-types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { renderAnsi } from "@/lib/ansi";
import { cn } from "@/lib/utils";

function statusIcon(s: BackgroundTaskStatus) {
  if (s === "running" || s === "pending") {
    return <Loader2 className="size-3 animate-spin" aria-hidden />;
  }
  if (s === "completed") {
    return <CheckCircle2 className="size-3" aria-hidden />;
  }
  if (s === "killed") {
    return <Octagon className="size-3" aria-hidden />;
  }
  return <CircleAlert className="size-3" aria-hidden />;
}

function statusColor(s: BackgroundTaskStatus): string {
  if (s === "running" || s === "pending")
    return "text-blue-600 dark:text-blue-400";
  if (s === "completed") return "text-emerald-600 dark:text-emerald-400";
  if (s === "killed") return "text-zinc-500";
  return "text-destructive";
}

// Drop noisy prefixes the model sometimes prepends and surface just
// the underlying command. Falls back to description / id so the row
// always has a label.
function shortLabel(task: BackgroundTask): string {
  const p = task.prompt?.trim();
  if (p) {
    const firstLine = p.split("\n", 1)[0]?.trim();
    if (firstLine) return firstLine;
  }
  return task.description || task.task_id.slice(0, 8);
}

function elapsedLabel(task: BackgroundTask, now: number): string {
  const start = Date.parse(task.started_at);
  const end = task.ended_at ? Date.parse(task.ended_at) : now;
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

interface TaskDetailProps {
  task: BackgroundTask;
  sessionId: string;
  onStop: (taskId: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  onBack: () => void;
}

// Detail pane: shown when the user picks one task from the list.
// Polls the output endpoint while the task is running and offers
// kill/dismiss based on status.
function TaskDetail({
  task,
  sessionId,
  onStop,
  onDismiss,
  onBack,
}: TaskDetailProps) {
  const [output, setOutput] = useState("");
  const [outputTruncated, setOutputTruncated] = useState(false);
  const [busy, setBusy] = useState<"stopping" | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const running = task.status === "running" || task.status === "pending";

  const fetchOutput = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/chat/${sessionId}/bg-tasks/${task.task_id}/output`,
          { signal },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          output: string;
          truncated: boolean;
        };
        setOutput(body.output ?? "");
        setOutputTruncated(Boolean(body.truncated));
      } catch {
        // Aborts or transient errors are fine — keep prior output.
      }
    },
    [sessionId, task.task_id],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchOutput(ctrl.signal);
    if (!running) {
      return () => {
        ctrl.abort();
      };
    }
    const tick = setInterval(() => void fetchOutput(ctrl.signal), 1500);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      ctrl.abort();
      clearInterval(tick);
      clearInterval(clock);
    };
  }, [fetchOutput, running]);

  // Auto-scroll only when the user is already near the bottom so we
  // don't yank them away while they're reading older output.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Parse ANSI SGR escapes into styled spans so colorized output
  // (npm/pnpm/cargo/tsc/etc.) doesn't show up as a wall of greyish
  // text or, worse, raw `\x1b[31m` sequences. Memoised on the raw
  // string — the parse only re-runs when new bytes have actually
  // arrived, not on every 1Hz elapsed-clock tick.
  const rendered = useMemo(() => renderAnsi(output), [output]);

  const handleStop = async () => {
    setBusy("stopping");
    try {
      await onStop(task.task_id);
    } finally {
      setBusy(null);
    }
  };

  const label = shortLabel(task);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to list"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
            statusColor(task.status),
          )}
        >
          {task.status}
        </span>
      </div>
      <pre
        ref={preRef}
        className="max-h-72 min-h-[8rem] overflow-auto whitespace-pre-wrap break-words bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-100"
      >
        {outputTruncated && (
          <div className="mb-1 text-[10px] italic text-zinc-400">
            [earlier output trimmed — showing tail]
          </div>
        )}
        {output ? (
          rendered
        ) : (
          <span className="text-zinc-400">No output yet from this shell.</span>
        )}
      </pre>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {running ? elapsedLabel(task, now) : task.status}
          {" · "}
          {task.task_id.slice(0, 12)}
        </span>
        <div className="flex items-center gap-1.5">
          {running ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={busy === "stopping"}
              className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-[11px] hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              <Square className="size-3" />
              {busy === "stopping" ? "Stopping…" : "Kill"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onDismiss(task.task_id);
                onBack();
              }}
              className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-[11px] hover:bg-muted"
            >
              <Trash2 className="size-3" />
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TaskListProps {
  tasks: BackgroundTask[];
  onSelect: (taskId: string) => void;
}

function TaskList({ tasks, onSelect }: TaskListProps) {
  const [now, setNow] = useState(() => Date.now());
  // Cheap 1s clock just to keep elapsed labels live without dragging
  // the popover content tree through a global timer.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <ul className="max-h-72 overflow-y-auto">
      {tasks.map((task) => {
        const running =
          task.status === "running" || task.status === "pending";
        return (
          <li key={task.task_id}>
            <button
              type="button"
              onClick={() => onSelect(task.task_id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/60"
            >
              <span className={statusColor(task.status)}>
                {statusIcon(task.status)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {shortLabel(task)}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {running ? elapsedLabel(task, now) : task.status}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface BackgroundDockProps {
  sessionId: string;
  tasks: BackgroundTask[];
  onStop: (taskId: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  className?: string;
}

// Compact "(N) shell" chip with a popover that drills into per-task
// detail (output + kill). The chip is always single-element so it
// fits beside the Scripts button in the composer chip row without
// pushing layout around when task count changes.
export function BackgroundDock({
  sessionId,
  tasks,
  onStop,
  onDismiss,
  className,
}: BackgroundDockProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Newest first — typically the bg shell the user is actively
  // waiting on.
  const ordered = [...tasks].sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  // Reset detail view when the popover closes so reopening lands on
  // the list. Also clear when the selected task is dismissed.
  const selected = selectedId
    ? ordered.find((t) => t.task_id === selectedId)
    : null;
  useEffect(() => {
    if (!open) setSelectedId(null);
  }, [open]);
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  if (tasks.length === 0) return null;

  const runningCount = tasks.filter(
    (t) => t.status === "running" || t.status === "pending",
  ).length;
  const anyRunning = runningCount > 0;
  // Trigger label: "(N) shell" per the user's spec. We use the running
  // count specifically — finished tasks linger as history but the
  // primary signal is "how many shells are alive right now". When
  // every shell has finished we fall back to total so the chip
  // doesn't claim "(0) shell".
  const triggerCount = anyRunning ? runningCount : tasks.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Background shells"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
              anyRunning
                ? "border-blue-500/40 bg-blue-500/[0.08] text-blue-700 hover:bg-blue-500/[0.14] dark:text-blue-300"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
              className,
            )}
          />
        }
      >
        {anyRunning ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <Terminal className="size-3" aria-hidden />
        )}
        <span className="font-mono tabular-nums">({triggerCount})</span>
        <span>shell</span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[28rem] max-w-[90vw] p-0"
      >
        {selected ? (
          <TaskDetail
            task={selected}
            sessionId={sessionId}
            onStop={onStop}
            onDismiss={onDismiss}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <TaskList tasks={ordered} onSelect={setSelectedId} />
        )}
      </PopoverContent>
    </Popover>
  );
}
