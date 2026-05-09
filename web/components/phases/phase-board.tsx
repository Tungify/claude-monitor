"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, GitCommit, Loader2, RotateCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase, PhaseSession, PlanRecord } from "@/lib/plan-types";
import type { SessionStatus, SessionSummary } from "@/lib/chat-types";
import { Badge } from "@/components/ui/badge";

type Column = "todo" | "running" | "awaiting" | "done";

interface PhaseRow {
  phase: Phase;
  link?: PhaseSession;
  session?: SessionSummary;
}

const COLUMNS: { id: Column; label: string; tint: string }[] = [
  { id: "todo", label: "To start", tint: "border-muted-foreground/30" },
  { id: "running", label: "Running", tint: "border-amber-500/60" },
  { id: "awaiting", label: "Awaiting input", tint: "border-blue-500/60" },
  { id: "done", label: "Done / closed", tint: "border-emerald-500/60" },
];

function bucketFor(status: SessionStatus | undefined): Column {
  if (!status) return "todo";
  if (status === "starting") return "todo";
  if (status === "thinking") return "running";
  if (status === "awaiting_permission") return "awaiting";
  return "done"; // idle | closed | errored — colored at row level
}

export function PhaseBoard({ plan: initialPlan }: { plan: PlanRecord }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // The page-level server component hydrates `initialPlan` once; the
  // commit/complete action mutates `phase_sessions[].commit_*` on the
  // server and returns the updated record. Mirror it locally so the
  // badge updates without a route nav. Plan id/cwd/phases are
  // immutable post-approval, so we only need to track the slice that
  // can change.
  const [phaseSessions, setPhaseSessions] = useState<PhaseSession[]>(
    initialPlan.phase_sessions ?? [],
  );
  const [pendingCompleteSlug, setPendingCompleteSlug] = useState<string | null>(
    null,
  );
  const initialPlanId = initialPlan.id;

  // Poll /api/chat for live status. 1500ms is fast enough that a
  // running phase flips columns within a couple of frames after its
  // SDK message lands, slow enough that we don't drown the API.
  // Pause when the tab isn't visible to avoid background churn.
  const refetch = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/chat", { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions: SessionSummary[] };
      setSessions(data.sessions);
    } catch {
      // Aborted or transient — wait for the next tick.
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") {
          void (async () => {
            await refetch();
          })();
        }
      }, 1500);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void (async () => {
          await refetch();
        })();
        start();
      } else {
        stop();
      }
    };
    void (async () => {
      await refetch(ctrl.signal);
    })();
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      ctrl.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refetch]);

  const phaseRows = useMemo<PhaseRow[]>(() => {
    const sessionByPhaseSlug = new Map<string, SessionSummary>();
    for (const s of sessions) {
      if (s.plan_id === initialPlanId && s.phase_slug) {
        sessionByPhaseSlug.set(s.phase_slug, s);
      }
    }
    const linkByPhase = new Map<string, PhaseSession>(
      phaseSessions.map((p) => [p.phase_slug, p]),
    );
    return initialPlan.phases.map((phase) => ({
      phase,
      link: linkByPhase.get(phase.slug),
      session: sessionByPhaseSlug.get(phase.slug),
    }));
  }, [phaseSessions, initialPlan.phases, sessions, initialPlanId]);

  // Fire the commit action and merge the server's updated PhaseSession
  // back into local state. We don't refetch the whole plan — the route
  // already returns the canonical phase_session, and replacing in place
  // keeps the row's transition animations smooth.
  const handleComplete = useCallback(
    async (slug: string) => {
      setPendingCompleteSlug(slug);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/complete`,
          { method: "POST" },
        );
        if (!res.ok) {
          const detail = await res.text();
          console.error(
            `[phase-board] complete ${slug} failed:`,
            res.status,
            detail,
          );
          return;
        }
        const data = (await res.json()) as {
          plan: PlanRecord;
          phase_session?: PhaseSession;
        };
        setPhaseSessions(data.plan.phase_sessions ?? []);
      } catch (err) {
        console.error(`[phase-board] complete ${slug} threw:`, err);
      } finally {
        setPendingCompleteSlug(null);
      }
    },
    [initialPlanId],
  );

  const buckets = useMemo(() => {
    const map: Record<Column, PhaseRow[]> = {
      todo: [],
      running: [],
      awaiting: [],
      done: [],
    };
    for (const row of phaseRows) {
      const col = row.session ? bucketFor(row.session.status) : "todo";
      map[col].push(row);
    }
    return map;
  }, [phaseRows]);

  const counters = useMemo(() => {
    const total = phaseRows.length;
    const running = buckets.running.length;
    const awaiting = buckets.awaiting.length;
    const done = phaseRows.filter(
      (r) => r.session?.status === "closed" || r.session?.status === "idle",
    ).length;
    const errored = phaseRows.filter(
      (r) => r.session?.status === "errored",
    ).length;
    return { total, running, awaiting, done, errored };
  }, [buckets, phaseRows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{initialPlan.title}</h1>
            <PlanStatusBadge status={initialPlan.status} />
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            plan {initialPlan.id.slice(0, 8)} · {initialPlan.phases.length} phase
            {initialPlan.phases.length === 1 ? "" : "s"} ·{" "}
            <span className="select-all">{initialPlan.cwd}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <Counter label="running" value={counters.running} tone="amber" />
          <Counter label="awaiting" value={counters.awaiting} tone="blue" />
          <Counter label="done" value={counters.done} tone="emerald" />
          {counters.errored > 0 && (
            <Counter label="errored" value={counters.errored} tone="rose" />
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto p-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => (
          <ColumnView
            key={col.id}
            label={col.label}
            tint={col.tint}
            rows={buckets[col.id]}
            onComplete={handleComplete}
            pendingCompleteSlug={pendingCompleteSlug}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnView({
  label,
  tint,
  rows,
  onComplete,
  pendingCompleteSlug,
}: {
  label: string;
  tint: string;
  rows: PhaseRow[];
  onComplete: (slug: string) => void;
  pendingCompleteSlug: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={cn(
          "mb-2 flex items-center gap-2 border-l-2 pl-2 text-xs font-medium uppercase tracking-wide text-muted-foreground",
          tint,
        )}
      >
        <span>{label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-foreground/70">
          {rows.length}
        </span>
      </div>
      <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-4">
        {rows.length === 0 ? (
          <li className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            empty
          </li>
        ) : (
          rows.map((row) => (
            <li key={row.phase.slug}>
              <PhaseRowCard
                row={row}
                onComplete={onComplete}
                pending={pendingCompleteSlug === row.phase.slug}
              />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function PhaseRowCard({
  row,
  onComplete,
  pending,
}: {
  row: PhaseRow;
  onComplete: (slug: string) => void;
  pending: boolean;
}) {
  const { phase, link, session } = row;
  const status = session?.status;
  // Show the commit affordance only once the agent has actually been
  // spawned (link exists) AND it isn't actively working: idle/closed/
  // errored mean the user can reasonably decide "this phase is done,
  // commit whatever's there." Hiding it during thinking/awaiting also
  // prevents racing the model's own commit attempt.
  const sessionIdleLike =
    !!session &&
    (session.status === "idle" ||
      session.status === "closed" ||
      session.status === "errored");
  const canComplete = !!link && sessionIdleLike && !link.commit_status;
  return (
    <div
      className={cn(
        "rounded-md border bg-background p-3 shadow-sm transition-colors",
        status === "errored" && "border-destructive/40",
        status === "thinking" && "border-amber-500/50",
        status === "awaiting_permission" && "border-blue-500/50",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{phase.title}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {phase.slug}
            </Badge>
          </div>
          {phase.depends_on && phase.depends_on.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {phase.depends_on.map((dep) => (
                <Badge key={dep} variant="secondary" className="font-mono text-[10px]">
                  ← {dep}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {status && <SessionStatusDot status={status} />}
      </div>

      <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
        {phase.description}
      </p>

      <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
        {link?.account_name && (
          <div>
            <span className="text-foreground/70">account:</span> {link.account_name}
          </div>
        )}
        {session && (
          <div>
            <span className="text-foreground/70">turns:</span>{" "}
            <span className="tabular-nums">{session.history_length}</span>
            {session.subagents && session.subagents.length > 0 && (
              <>
                <span className="mx-1">·</span>
                <span className="text-foreground/70">subagents:</span>{" "}
                <span className="tabular-nums">{session.subagents.length}</span>
              </>
            )}
          </div>
        )}
      </div>

      {link ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={`/chat/${link.session_id}`}
            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-[11px] hover:bg-muted"
          >
            <span className="font-mono">open agent</span>
            <ArrowRight className="size-3" aria-hidden />
          </Link>
          {canComplete && (
            <button
              type="button"
              onClick={() => onComplete(phase.slug)}
              disabled={pending}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20",
                "dark:text-emerald-300",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {pending ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <ShieldCheck className="size-3" aria-hidden />
              )}
              <span className="font-mono">commit & complete</span>
            </button>
          )}
          <CommitBadge link={link} onRetry={() => onComplete(phase.slug)} pending={pending} />
        </div>
      ) : (
        <div className="mt-3 inline-flex items-center gap-1 text-[11px] italic text-muted-foreground">
          no agent spawned
        </div>
      )}
    </div>
  );
}

// CommitBadge surfaces the result of the most recent /complete call.
// `clean` is intentionally low-key (the model already committed and the
// safety net was a no-op); `committed` shows the short sha; `failed`
// gives the user a one-click retry plus the captured stderr in a
// title attribute for hover-reveal.
function CommitBadge({
  link,
  onRetry,
  pending,
}: {
  link: PhaseSession;
  onRetry: () => void;
  pending: boolean;
}) {
  if (!link.commit_status) return null;
  if (link.commit_status === "clean") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3" aria-hidden />
        no changes
      </span>
    );
  }
  if (link.commit_status === "committed") {
    const short = link.commit_sha?.slice(0, 7) ?? "?";
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
        title={link.committed_at ? `committed ${link.committed_at}` : undefined}
      >
        <GitCommit className="size-3" aria-hidden />
        {short}
      </span>
    );
  }
  // failed
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={pending}
      title={link.commit_error}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <RotateCw className="size-3" aria-hidden />
      )}
      commit failed — retry
    </button>
  );
}

function SessionStatusDot({ status }: { status: SessionStatus }) {
  const color =
    status === "errored"
      ? "bg-destructive"
      : status === "thinking"
        ? "bg-amber-500 animate-pulse"
        : status === "awaiting_permission"
          ? "bg-blue-500"
          : status === "closed"
            ? "bg-muted-foreground/40"
            : status === "idle"
              ? "bg-emerald-500"
              : "bg-muted-foreground/60";
  return (
    <span
      title={status.replace("_", " ")}
      className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full", color)}
    />
  );
}

function PlanStatusBadge({ status }: { status: PlanRecord["status"] }) {
  if (status === "approved") return <Badge>approved</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">awaiting approval</Badge>;
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "amber" | "blue" | "emerald" | "rose";
}) {
  const dot =
    tone === "amber"
      ? "bg-amber-500"
      : tone === "blue"
        ? "bg-blue-500"
        : tone === "emerald"
          ? "bg-emerald-500"
          : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      <span className="tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

