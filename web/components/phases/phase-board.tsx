"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommit,
  GitMerge,
  KanbanSquare,
  Loader2,
  Megaphone,
  MessageSquareText,
  Network,
  RotateCw,
  ScanLine,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  Phase,
  PhaseMergeResult,
  PhaseNote,
  PhaseSession,
  PlanIntegrationReviewStatus,
  PlanMergeStatus,
  PlanRecord,
  ReviewFinding,
  ReviewSeverity,
} from "@/lib/plan-types";
import type { RateLimitInfo, SessionStatus, SessionSummary } from "@/lib/chat-types";
import { Badge } from "@/components/ui/badge";
import { DagView } from "./dag-view";

type Column = "todo" | "running" | "awaiting" | "done";
type BoardView = "kanban" | "dag";

// LocalStorage key for the per-plan view preference. Per-plan rather
// than global because plans differ — a 3-phase plan with no deps
// reads fine in kanban; a 12-phase plan with a layered DAG is the
// reason the dag view exists in the first place.
function viewStorageKey(planId: string): string {
  return `cm:phase-board:view:${planId}`;
}

// Same-tab notifier for the view-preference store. The browser only
// fires `storage` events on OTHER tabs by default; to make
// useSyncExternalStore re-read in the current tab after we write, we
// pump a dispatcher of our own that subscribers attach to.
const VIEW_PREF_EVENT = "cm:phase-board:view-changed";
const viewPrefBus =
  typeof window !== "undefined" ? new EventTarget() : undefined;

function readBoardView(planId: string): BoardView {
  try {
    const v = window.localStorage.getItem(viewStorageKey(planId));
    if (v === "dag" || v === "kanban") return v;
  } catch {
    // private mode / quota — ignore
  }
  return "kanban";
}

function writeBoardView(planId: string, view: BoardView): void {
  try {
    window.localStorage.setItem(viewStorageKey(planId), view);
  } catch {
    // ignore — preference just won't persist
  }
  viewPrefBus?.dispatchEvent(new CustomEvent(VIEW_PREF_EVENT));
}

function subscribeBoardView(notify: () => void): () => void {
  if (typeof window === "undefined" || !viewPrefBus) return () => {};
  const onCustom = () => notify();
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith("cm:phase-board:view:")) notify();
  };
  viewPrefBus.addEventListener(VIEW_PREF_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    viewPrefBus.removeEventListener(VIEW_PREF_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

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
  if (status === "awaiting_permission" || status === "rate_limited") {
    // rate_limited groups under "awaiting" so the user notices at a
    // glance that this phase is paused (even though the SDK is auto-
    // retrying internally — the user-facing fact is "no progress").
    return "awaiting";
  }
  return "done"; // idle | closed | errored | interrupted — colored at row level
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
  // Per-row pending state for the review kickoff click. Distinct from
  // pendingCompleteSlug because the buttons sit on the same row and we
  // don't want a spinner on one to imply both are in flight.
  const [pendingReviewSlug, setPendingReviewSlug] = useState<string | null>(
    null,
  );
  // Mirror the plan's merge fields locally so the panel updates without
  // a route nav after POST /merge returns. Default the input to the
  // last-used integration branch (or "main" on first run).
  const [mergeStatus, setMergeStatus] = useState<PlanMergeStatus | undefined>(
    initialPlan.merge_status,
  );
  const [mergeResults, setMergeResults] = useState<PhaseMergeResult[]>(
    initialPlan.merge_results ?? [],
  );
  const [mergeHeadSha, setMergeHeadSha] = useState<string | undefined>(
    initialPlan.merge_head_sha,
  );
  const [mergedAt, setMergedAt] = useState<string | undefined>(
    initialPlan.merged_at,
  );
  const [mergeError, setMergeError] = useState<string | undefined>(
    initialPlan.merge_error,
  );
  const [mergeBranch, setMergeBranch] = useState<string>(
    initialPlan.merge_branch ?? "main",
  );
  const [merging, setMerging] = useState(false);
  // Mirror plan.integration_review_* locally so the panel updates
  // without a route nav after POST /integration-review returns. The
  // poll below replaces phaseSessions AND splices these in too.
  const [integrationReview, setIntegrationReview] = useState<
    IntegrationReviewSnapshot
  >(snapshotIntegrationReview(initialPlan));
  const [integrationReviewPending, setIntegrationReviewPending] =
    useState(false);
  // Default-open the integration review panel when fresh findings or
  // an error land. Otherwise collapsed so the user can scan the plan
  // strip without a wall of text.
  const [integrationReviewOpen, setIntegrationReviewOpen] = useState<boolean>(
    () =>
      initialPlan.integration_review_status === "complete" &&
      ((initialPlan.integration_review_findings?.length ?? 0) > 0 ||
        !!initialPlan.integration_review_summary),
  );
  // Phase notes — sibling broadcasts written via the phase_notes MCP
  // tool. Append-only on the agent side; the plan-record poll below
  // refreshes the local mirror as new notes land. Default panel state
  // is open when the plan ships with notes already (resumed view).
  const [phaseNotes, setPhaseNotes] = useState<PhaseNote[]>(
    initialPlan.notes ?? [],
  );
  const [notesOpen, setNotesOpen] = useState<boolean>(
    (initialPlan.notes?.length ?? 0) > 0,
  );
  // View toggle: kanban (default — same swimlanes as before) or dag
  // (depends_on rendered as a left-to-right node graph). Preference
  // is remembered per-plan in localStorage so a user who reasons in
  // graph form for one plan doesn't have to re-toggle every visit.
  //
  // Backed by useSyncExternalStore against localStorage so the view is
  // hydration-safe (server snapshot returns "kanban", client snapshot
  // reads the saved value) and stays in sync across tabs.
  const initialPlanId = initialPlan.id;
  const view = useSyncExternalStore<BoardView>(
    subscribeBoardView,
    () => readBoardView(initialPlanId),
    () => "kanban",
  );
  const handleSetView = useCallback(
    (next: BoardView) => writeBoardView(initialPlanId, next),
    [initialPlanId],
  );

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

  // Refetch the canonical plan record. Used when a review is in flight
  // — the agent persists findings to disk asynchronously, so the only
  // way the UI sees them land is by re-reading. Cheaper than threading
  // an SSE channel for what is effectively a single-bit transition.
  const refetchPlan = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}`,
          { signal },
        );
        if (!res.ok) return;
        const next = (await res.json()) as PlanRecord;
        setPhaseSessions(next.phase_sessions ?? []);
        // Splice integration review fields too — they share the
        // poll's lifecycle (background agent writes to disk, UI reads
        // back).
        setIntegrationReview(snapshotIntegrationReview(next));
        // Notes also land async (any phase agent can append at any
        // time). Mirror them so the panel updates without a route nav.
        setPhaseNotes(next.notes ?? []);
      } catch {
        // ignore; tick again
      }
    },
    [initialPlanId],
  );

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

  // Plan-record poll. Gated on either an in-flight review OR any
  // phase still actively executing — phase agents can append notes at
  // any time during their run via the phase_notes MCP tool, and the
  // only way the UI sees them land is by re-reading plan.json. Stops
  // once every phase has settled (idle/closed/errored) AND no review
  // is running, so an inert PhaseBoard doesn't pay the cost.
  const anyReviewRunning = useMemo(
    () =>
      phaseSessions.some((p) => p.review_status === "running") ||
      integrationReview.status === "running",
    [phaseSessions, integrationReview.status],
  );
  const anyPhaseActive = useMemo(() => {
    for (const s of sessions) {
      if (s.plan_id !== initialPlanId || !s.phase_slug) continue;
      const st = s.status;
      if (
        st === "starting" ||
        st === "thinking" ||
        st === "awaiting_permission" ||
        st === "rate_limited"
      ) {
        return true;
      }
    }
    return false;
  }, [sessions, initialPlanId]);
  const planPollActive = anyReviewRunning || anyPhaseActive;
  useEffect(() => {
    if (!planPollActive) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void (async () => {
          await refetchPlan();
        })();
      }
    };
    const start = () => {
      if (timer) return;
      timer = setInterval(tick, 3000);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
        start();
      } else {
        stop();
      }
    };
    void (async () => {
      await refetchPlan(ctrl.signal);
    })();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      ctrl.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [planPollActive, refetchPlan]);

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

  // Kick a per-phase code review. Server runs the agent in the
  // background and writes findings to disk; the plan-record poll above
  // surfaces them as they land. POST returns 202 with the running
  // record so the badge flips immediately.
  const handleReview = useCallback(
    async (slug: string) => {
      setPendingReviewSlug(slug);
      try {
        const res = await fetch(
          `/api/plans/${encodeURIComponent(initialPlanId)}/phases/${encodeURIComponent(slug)}/review`,
          { method: "POST" },
        );
        if (!res.ok && res.status !== 202) {
          const detail = await res.text();
          console.error(
            `[phase-board] review ${slug} failed:`,
            res.status,
            detail,
          );
          return;
        }
        const data = (await res.json()) as { plan: PlanRecord };
        setPhaseSessions(data.plan.phase_sessions ?? []);
      } catch (err) {
        console.error(`[phase-board] review ${slug} threw:`, err);
      } finally {
        setPendingReviewSlug(null);
      }
    },
    [initialPlanId],
  );

  // Plan-level merge — kicks the integration branch checkout +
  // `git merge --no-ff` per phase branch. Server returns the canonical
  // updated plan; we splice the merge fields into local state without
  // touching phaseSessions (the route doesn't mutate them).
  const handleMerge = useCallback(async () => {
    setMerging(true);
    setMergeError(undefined);
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(initialPlanId)}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ integration_branch: mergeBranch }),
        },
      );
      if (!res.ok) {
        let detail = await res.text();
        try {
          // Server returns {error, ineligible?} for gating failures.
          const parsed = JSON.parse(detail) as {
            error?: string;
            ineligible?: string[];
          };
          if (parsed.error) {
            detail = parsed.ineligible?.length
              ? `${parsed.error}: ${parsed.ineligible.join(", ")}`
              : parsed.error;
          }
        } catch {
          // not json — surface raw body
        }
        setMergeError(detail);
        return;
      }
      const data = (await res.json()) as { plan: PlanRecord };
      setMergeStatus(data.plan.merge_status);
      setMergeResults(data.plan.merge_results ?? []);
      setMergeHeadSha(data.plan.merge_head_sha);
      setMergedAt(data.plan.merged_at);
      setMergeError(data.plan.merge_error);
      if (data.plan.merge_branch) setMergeBranch(data.plan.merge_branch);
      // Server clears integration review on re-merge — mirror that
      // here so the panel doesn't keep showing stale findings against
      // the old diff range.
      setIntegrationReview(snapshotIntegrationReview(data.plan));
      setIntegrationReviewOpen(false);
    } catch (err) {
      console.error(`[phase-board] merge threw:`, err);
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  }, [initialPlanId, mergeBranch]);

  // Plan-level integration review. Like /complete and /review, the
  // server runs the agent in the background and persists findings to
  // disk; the plan-record poll surfaces them as they land. POST
  // returns 202 with the running record so the badge flips
  // immediately. We open the findings panel by default for fresh
  // results so the user doesn't miss them — they can collapse it
  // again with the chevron.
  const handleIntegrationReview = useCallback(async () => {
    setIntegrationReviewPending(true);
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(initialPlanId)}/integration-review`,
        { method: "POST" },
      );
      if (!res.ok && res.status !== 202) {
        const detail = await res.text();
        console.error(
          `[phase-board] integration-review failed:`,
          res.status,
          detail,
        );
        return;
      }
      const data = (await res.json()) as { plan: PlanRecord };
      setIntegrationReview(snapshotIntegrationReview(data.plan));
      setIntegrationReviewOpen(true);
    } catch (err) {
      console.error(`[phase-board] integration-review threw:`, err);
    } finally {
      setIntegrationReviewPending(false);
    }
  }, [initialPlanId]);

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

  // Merge gate — all phases must have a non-failed commit_status. We
  // mirror the server's check so the button can disable itself with a
  // clear hint instead of letting the user click into a 409. Counts
  // power the inline summary too.
  const mergeGate = useMemo(() => {
    const linkBySlug = new Map<string, PhaseSession>(
      phaseSessions.map((p) => [p.phase_slug, p]),
    );
    let ready = 0;
    const pending: string[] = [];
    for (const phase of initialPlan.phases) {
      const link = linkBySlug.get(phase.slug);
      const status = link?.commit_status;
      if (status === "clean" || status === "committed") {
        ready++;
      } else {
        pending.push(phase.slug);
      }
    }
    return {
      ready,
      total: initialPlan.phases.length,
      pending,
      eligible: pending.length === 0 && initialPlan.phases.length > 0,
    };
  }, [phaseSessions, initialPlan.phases]);

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
    const rateLimited = phaseRows.filter(
      (r) => r.session?.status === "rate_limited",
    ).length;
    return { total, running, awaiting, done, errored, rateLimited };
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
          <ViewToggle value={view} onChange={handleSetView} />
          <Counter label="running" value={counters.running} tone="amber" />
          <Counter label="awaiting" value={counters.awaiting} tone="blue" />
          <Counter label="done" value={counters.done} tone="emerald" />
          {counters.rateLimited > 0 && (
            <Counter
              label="rate-limited"
              value={counters.rateLimited}
              tone="rose"
            />
          )}
          {counters.errored > 0 && (
            <Counter label="errored" value={counters.errored} tone="rose" />
          )}
          {phaseNotes.length > 0 && (
            <Counter label="notes" value={phaseNotes.length} tone="violet" />
          )}
        </div>
      </header>

      <MergePanel
        gate={mergeGate}
        status={mergeStatus}
        results={mergeResults}
        headSha={mergeHeadSha}
        mergedAt={mergedAt}
        error={mergeError}
        branch={mergeBranch}
        onBranchChange={setMergeBranch}
        onMerge={handleMerge}
        merging={merging}
        integrationReview={integrationReview}
        integrationReviewOpen={integrationReviewOpen}
        onToggleIntegrationReview={() =>
          setIntegrationReviewOpen((v) => !v)
        }
        onIntegrationReview={handleIntegrationReview}
        integrationReviewPending={integrationReviewPending}
      />

      <NotesPanel
        notes={phaseNotes}
        open={notesOpen}
        onToggle={() => setNotesOpen((v) => !v)}
      />

      {view === "kanban" ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto p-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <ColumnView
              key={col.id}
              label={col.label}
              tint={col.tint}
              rows={buckets[col.id]}
              onComplete={handleComplete}
              pendingCompleteSlug={pendingCompleteSlug}
              onReview={handleReview}
              pendingReviewSlug={pendingReviewSlug}
            />
          ))}
        </div>
      ) : (
        <DagView rows={phaseRows} />
      )}
    </div>
  );
}

function ColumnView({
  label,
  tint,
  rows,
  onComplete,
  pendingCompleteSlug,
  onReview,
  pendingReviewSlug,
}: {
  label: string;
  tint: string;
  rows: PhaseRow[];
  onComplete: (slug: string) => void;
  pendingCompleteSlug: string | null;
  onReview: (slug: string) => void;
  pendingReviewSlug: string | null;
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
                onReview={onReview}
                reviewPending={pendingReviewSlug === row.phase.slug}
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
  onReview,
  reviewPending,
}: {
  row: PhaseRow;
  onComplete: (slug: string) => void;
  pending: boolean;
  onReview: (slug: string) => void;
  reviewPending: boolean;
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
  // Review eligibility: phase must be committed (clean or committed
  // status) and not currently under review. We allow re-running a
  // failed review, and re-running a complete one ("re-review") so the
  // user can iterate after pushing follow-up commits.
  const reviewState = link?.review_status;
  const canReview =
    !!link &&
    (link.commit_status === "clean" || link.commit_status === "committed") &&
    reviewState !== "running";
  // Local expand toggle for the findings panel. Default: open when a
  // fresh review with findings has just landed; collapse otherwise so
  // long phase lists stay compact. The user can flip it manually via
  // the chevron on ReviewBadge.
  const [reviewOpen, setReviewOpen] = useState<boolean>(
    reviewState === "complete" && (link?.review_findings?.length ?? 0) > 0,
  );
  return (
    <div
      className={cn(
        "rounded-md border bg-background p-3 shadow-sm transition-colors",
        status === "errored" && "border-destructive/40",
        status === "thinking" && "border-amber-500/50",
        status === "awaiting_permission" && "border-blue-500/50",
        status === "rate_limited" && "border-rose-500/50",
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

      {session?.rate_limit && (
        <RateLimitBadge
          info={session.rate_limit}
          observedAt={session.rate_limit_observed_at}
          active={session.status === "rate_limited"}
        />
      )}

      {link ? (
        <>
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
            <ScopeBadge link={link} />
            {canReview && (
              <button
                type="button"
                onClick={() => onReview(phase.slug)}
                disabled={reviewPending}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
                  "border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20",
                  "dark:text-violet-300",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
                title={
                  reviewState === "complete"
                    ? "Run review again — useful after follow-up commits"
                    : reviewState === "failed"
                      ? "Retry review"
                      : "Spawn a read-only agent that reviews this phase's diff"
                }
              >
                {reviewPending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <MessageSquareText className="size-3" aria-hidden />
                )}
                <span className="font-mono">
                  {reviewState === "complete"
                    ? "re-review"
                    : reviewState === "failed"
                      ? "retry review"
                      : "review"}
                </span>
              </button>
            )}
            <ReviewBadge
              link={link}
              open={reviewOpen}
              onToggle={() => setReviewOpen((v) => !v)}
            />
          </div>
          {reviewOpen &&
            (link.review_findings || link.review_summary || link.review_error) && (
              <ReviewPanel link={link} />
            )}
        </>
      ) : (
        <div className="mt-3 inline-flex items-center gap-1 text-[11px] italic text-muted-foreground">
          no agent spawned
        </div>
      )}
    </div>
  );
}

// RateLimitBadge renders the most recent rate_limit_event as a top-line
// notice on the row: rose-tinted while the SDK is still backing off
// (`active` mirrors the server's "rate_limited" status), muted gray
// once the reset has passed and a successful retry has flipped status
// back to thinking/idle. Tick state recomputes the countdown once per
// second only while it actually matters; we don't repaint after the
// limit clears.
function RateLimitBadge({
  info,
  observedAt,
  active,
}: {
  info: RateLimitInfo;
  observedAt?: string;
  active: boolean;
}) {
  // Hooks must run unconditionally — `info.status === "allowed"` short-
  // circuit lives below, after useState/useEffect so a status flip
  // doesn't change the call ordering.
  const resetMs = info.resetsAt ? info.resetsAt * 1000 : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!resetMs || !active) return;
    if (resetMs <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resetMs, active]);
  // Only render for non-"allowed" states. allowed_warning is a
  // courtesy heads-up worth showing; rejected is the actual block.
  // We render lapsed badges too so the user sees that the wait already
  // happened (helpful when reading a transcript hours later).
  if (info.status === "allowed") return null;
  const remainingMs = resetMs ? Math.max(0, resetMs - now) : null;
  const countdown =
    remainingMs !== null && remainingMs > 0 ? formatDuration(remainingMs) : null;
  const tone =
    active && info.status === "rejected"
      ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      : info.status === "allowed_warning"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-muted bg-muted/40 text-muted-foreground";
  const label =
    info.status === "rejected"
      ? active
        ? "rate limited"
        : "rate limit lapsed"
      : "rate limit warning";
  const tier =
    info.rate_limit_type === "five_hour"
      ? "5h"
      : info.rate_limit_type === "seven_day"
        ? "7d"
        : info.rate_limit_type === "seven_day_opus"
          ? "7d opus"
          : info.rate_limit_type === "seven_day_sonnet"
            ? "7d sonnet"
            : info.rate_limit_type === "overage"
              ? "overage"
              : null;
  const utilPct =
    typeof info.utilization === "number"
      ? Math.round(info.utilization * 100)
      : null;
  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]",
        tone,
      )}
      title={observedAt ? `observed ${observedAt}` : undefined}
    >
      <Clock className="size-3" aria-hidden />
      <span>{label}</span>
      {tier && <span className="opacity-70">· {tier}</span>}
      {utilPct !== null && <span className="opacity-70">· {utilPct}%</span>}
      {countdown && (
        <span className="font-semibold">· resets in {countdown}</span>
      )}
    </div>
  );
}

// formatDuration renders ms remaining as the most legible compact form:
// "12s", "4m 30s", "1h 12m". Keeps the badge narrow.
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
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

// ScopeBadge surfaces the post-commit scope check from /complete:
//   undefined          → no check ran (phase didn't declare scope, or
//                        check errored). Render nothing — silent.
//   []                 → checked, no violations. Show subtle green
//                        "in scope" affordance.
//   [...paths]         → out-of-scope files. Amber chip with count;
//                        hover lists the paths so the user can decide
//                        whether the creep is intentional.
function ScopeBadge({ link }: { link: PhaseSession }) {
  if (link.scope_violations === undefined) return null;
  if (link.scope_violations.length === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        title={
          link.scope_check_base
            ? `scope clean vs ${link.scope_check_base.slice(0, 7)}`
            : undefined
        }
      >
        <ScanLine className="size-3" aria-hidden />
        in scope
      </span>
    );
  }
  const list = link.scope_violations;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      title={list.join("\n")}
    >
      <AlertTriangle className="size-3" aria-hidden />
      {list.length} out of scope
    </span>
  );
}

// ReviewBadge encodes the four review states the row can be in:
//   undefined (no review run)        → render nothing
//   "running"                        → spinner + "reviewing…"
//   "complete" with 0 findings       → emerald "✓ clean review"
//   "complete" with N findings       → severity-colored chip with
//                                       "<errors>e · <warnings>w · <info>i"
//   "failed"                         → rose "review failed" with title
// Click toggles the parent row's expanded findings panel.
function ReviewBadge({
  link,
  open,
  onToggle,
}: {
  link: PhaseSession;
  open: boolean;
  onToggle: () => void;
}) {
  const status = link.review_status;
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        )}
        title={
          link.review_started_at
            ? `started ${link.review_started_at}`
            : undefined
        }
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        reviewing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={link.review_error}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
      >
        <AlertTriangle className="size-3" aria-hidden />
        review failed
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // complete
  const findings = link.review_findings ?? [];
  const counts = countBySeverity(findings);
  const totalIssues = counts.error + counts.warning + counts.info;
  if (totalIssues === 0) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={link.review_summary}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <ShieldCheck className="size-3" aria-hidden />
        clean review
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // Pick the worst-severity color so the badge reflects the headline at a glance.
  const tone =
    counts.error > 0
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : counts.warning > 0
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={link.review_summary}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px]",
        tone,
      )}
    >
      <MessageSquareText className="size-3" aria-hidden />
      <span>
        {counts.error > 0 && <span>{counts.error}e</span>}
        {counts.warning > 0 && (
          <span>
            {counts.error > 0 ? " · " : ""}
            {counts.warning}w
          </span>
        )}
        {counts.info > 0 && (
          <span>
            {counts.error > 0 || counts.warning > 0 ? " · " : ""}
            {counts.info}i
          </span>
        )}
      </span>
      {open ? (
        <ChevronDown className="size-3" aria-hidden />
      ) : (
        <ChevronRight className="size-3" aria-hidden />
      )}
    </button>
  );
}

function countBySeverity(findings: ReviewFinding[]) {
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "error") error++;
    else if (f.severity === "warning") warning++;
    else info++;
  }
  return { error, warning, info };
}

// ReviewPanel renders the agent's summary + per-finding bullets when
// the user expands the badge. Findings are sorted error → warning →
// info so the most actionable items rise to the top regardless of the
// order the agent submitted them in.
function ReviewPanel({ link }: { link: PhaseSession }) {
  const sorted = useMemo(() => {
    const findings = link.review_findings ?? [];
    const order: Record<ReviewSeverity, number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    return [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  }, [link.review_findings]);
  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-3 text-[11px]">
      {link.review_error ? (
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="font-mono whitespace-pre-wrap">{link.review_error}</span>
        </div>
      ) : null}
      {link.review_summary && (
        <p className="whitespace-pre-wrap text-foreground/80">
          {link.review_summary}
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {sorted.map((f, i) => (
            <li
              key={`${f.severity}-${i}-${f.title}`}
              className="rounded-md border bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityChip severity={f.severity} />
                {f.category && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {f.category}
                  </Badge>
                )}
                <span className="font-medium">{f.title}</span>
                {f.file && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {f.file}
                    {typeof f.line === "number" ? `:${f.line}` : ""}
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground/80">
                {f.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      {link.review_completed_at && (
        <div className="mt-2 font-mono text-[10px] text-muted-foreground">
          reviewed {link.review_completed_at}
          {link.review_base ? ` · base ${link.review_base.slice(0, 7)}` : ""}
        </div>
      )}
    </div>
  );
}

function SeverityChip({ severity }: { severity: ReviewSeverity }) {
  const cls =
    severity === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : severity === "warning"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 py-0 font-mono text-[10px] uppercase tracking-wide",
        cls,
      )}
    >
      {severity}
    </span>
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
          : status === "rate_limited"
            ? "bg-rose-500 animate-pulse"
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

// MergePanel renders the plan-level merge affordance below the header.
// Three states drive the layout:
//   1. not-yet-eligible (some phases missing commit_status) → muted
//      hint + disabled button so the user can see what's left.
//   2. eligible, no merge yet → highlighted row with input + Merge
//      button.
//   3. post-merge → result chips per phase + retry button when status
//      is "pending" or "failed".
// We always render the strip when the plan has phases; collapsing the
// row when not eligible would make the affordance harder to discover.
function MergePanel({
  gate,
  status,
  results,
  headSha,
  mergedAt,
  error,
  branch,
  onBranchChange,
  onMerge,
  merging,
  integrationReview,
  integrationReviewOpen,
  onToggleIntegrationReview,
  onIntegrationReview,
  integrationReviewPending,
}: {
  gate: { ready: number; total: number; pending: string[]; eligible: boolean };
  status: PlanMergeStatus | undefined;
  results: PhaseMergeResult[];
  headSha: string | undefined;
  mergedAt: string | undefined;
  error: string | undefined;
  branch: string;
  onBranchChange: (b: string) => void;
  onMerge: () => void;
  merging: boolean;
  integrationReview: IntegrationReviewSnapshot;
  integrationReviewOpen: boolean;
  onToggleIntegrationReview: () => void;
  onIntegrationReview: () => void;
  integrationReviewPending: boolean;
}) {
  if (gate.total === 0) return null;

  const merged = results.filter((r) => r.status === "merged").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  const buttonLabel =
    status === "merged"
      ? "Re-merge"
      : status === "pending" || status === "failed"
        ? "Retry merge"
        : "Merge into";

  return (
    <section
      className={cn(
        "flex flex-col gap-2 border-b px-6 py-3 text-xs",
        gate.eligible && status !== "merged" && "bg-emerald-500/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitMerge
          className={cn(
            "size-4 shrink-0",
            gate.eligible ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Plan merge</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {gate.ready}/{gate.total} phases committed
            </span>
            {status && <MergeStatusBadge status={status} />}
          </div>
          {!gate.eligible && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              waiting on{" "}
              <span className="font-mono">
                {gate.pending.slice(0, 4).join(", ")}
                {gate.pending.length > 4 ? `, +${gate.pending.length - 4} more` : ""}
              </span>{" "}
              — click <span className="font-mono">commit &amp; complete</span> on
              each phase first.
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">
            {buttonLabel}
          </span>
          <input
            type="text"
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            disabled={merging}
            spellCheck={false}
            placeholder="main"
            className={cn(
              "h-7 w-32 rounded-md border bg-background px-2 font-mono text-[11px]",
              "focus:outline-none focus:ring-1 focus:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <button
            type="button"
            onClick={onMerge}
            disabled={!gate.eligible || merging || branch.trim().length === 0}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
              "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20",
              "dark:text-emerald-300",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-500/10",
            )}
          >
            {merging ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <GitMerge className="size-3" aria-hidden />
            )}
            <span className="font-mono">merge</span>
          </button>
        </div>
      </div>

      {(results.length > 0 || error) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {merged > 0 && (
            <MergeSummaryChip tone="emerald" label={`${merged} merged`} />
          )}
          {skipped > 0 && (
            <MergeSummaryChip tone="muted" label={`${skipped} skipped`} />
          )}
          {failed > 0 && (
            <MergeSummaryChip tone="rose" label={`${failed} failed`} />
          )}
          {headSha && (
            <span
              className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              title={mergedAt ? `merged ${mergedAt}` : undefined}
            >
              <GitCommit className="size-3" aria-hidden />
              {headSha.slice(0, 7)}
            </span>
          )}
          {results.map((r) => (
            <MergeResultChip key={r.phase_slug} result={r} />
          ))}
          {error && (
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-mono text-[11px] text-destructive"
              title={error}
            >
              <XCircle className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{error}</span>
            </span>
          )}
        </div>
      )}

      {status === "merged" && (
        <IntegrationReviewRow
          snapshot={integrationReview}
          open={integrationReviewOpen}
          onToggle={onToggleIntegrationReview}
          onRun={onIntegrationReview}
          pending={integrationReviewPending}
        />
      )}
    </section>
  );
}

// IntegrationReviewSnapshot collapses the integration_review_* fields
// from PlanRecord into a single object so prop-drilling stays tidy.
// We mirror the wire shape one-for-one — no derived fields here, just
// a structural slice so MergePanel can read it without depending on
// the full PlanRecord shape.
interface IntegrationReviewSnapshot {
  status: PlanIntegrationReviewStatus | undefined;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  findings?: ReviewFinding[];
  error?: string;
  base?: string;
  head?: string;
  branch?: string;
}

function snapshotIntegrationReview(plan: PlanRecord): IntegrationReviewSnapshot {
  return {
    status: plan.integration_review_status,
    startedAt: plan.integration_review_started_at,
    completedAt: plan.integration_review_completed_at,
    summary: plan.integration_review_summary,
    findings: plan.integration_review_findings,
    error: plan.integration_review_error,
    base: plan.integration_review_base,
    head: plan.integration_review_head,
    branch: plan.integration_review_branch,
  };
}

// IntegrationReviewRow is the second strip inside MergePanel — only
// renders once the merge has fully landed (status === "merged"). It
// mirrors the per-phase ReviewBadge + ReviewPanel pair: a button to
// kick the agent, a badge that flips through running/clean/findings/
// failed states, and an expandable panel below for the agent's
// summary + findings list.
function IntegrationReviewRow({
  snapshot,
  open,
  onToggle,
  onRun,
  pending,
}: {
  snapshot: IntegrationReviewSnapshot;
  open: boolean;
  onToggle: () => void;
  onRun: () => void;
  pending: boolean;
}) {
  const status = snapshot.status;
  const running = status === "running";
  const buttonLabel =
    status === "complete"
      ? "Re-review"
      : status === "failed"
        ? "Retry review"
        : "Run integration review";
  const canRun = !running && !pending;
  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareText
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Integration review</span>
            <span className="text-[11px] text-muted-foreground">
              cross-phase coherence on the merged branch
            </span>
            <IntegrationReviewBadge
              snapshot={snapshot}
              open={open}
              onToggle={onToggle}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            title={
              status === "complete"
                ? "Re-run the integration reviewer — useful after follow-up commits on the integration branch"
                : status === "failed"
                  ? "Retry — the previous run errored or didn't submit findings"
                  : "Spawn a read-only agent that reviews the cumulative diff"
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
              "border-violet-500/40 bg-violet-500/10 text-violet-700 hover:bg-violet-500/20",
              "dark:text-violet-300",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {pending || running ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <MessageSquareText className="size-3" aria-hidden />
            )}
            <span className="font-mono">{buttonLabel}</span>
          </button>
        </div>
      </div>
      {open &&
        (status === "complete" || status === "failed") &&
        (snapshot.summary || snapshot.error || (snapshot.findings?.length ?? 0) > 0) && (
          <IntegrationReviewPanel snapshot={snapshot} />
        )}
    </div>
  );
}

function IntegrationReviewBadge({
  snapshot,
  open,
  onToggle,
}: {
  snapshot: IntegrationReviewSnapshot;
  open: boolean;
  onToggle: () => void;
}) {
  const status = snapshot.status;
  if (!status) return null;
  if (status === "running") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        )}
        title={
          snapshot.startedAt ? `started ${snapshot.startedAt}` : undefined
        }
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        reviewing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={snapshot.error}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
      >
        <AlertTriangle className="size-3" aria-hidden />
        review failed
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  // complete
  const findings = snapshot.findings ?? [];
  const counts = countBySeverity(findings);
  const totalIssues = counts.error + counts.warning + counts.info;
  if (totalIssues === 0) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={snapshot.summary}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <ShieldCheck className="size-3" aria-hidden />
        clean integration
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronRight className="size-3" aria-hidden />
        )}
      </button>
    );
  }
  const tone =
    counts.error > 0
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : counts.warning > 0
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={snapshot.summary}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        tone,
      )}
    >
      <MessageSquareText className="size-3" aria-hidden />
      <span>
        {counts.error > 0 && <span>{counts.error}e</span>}
        {counts.warning > 0 && (
          <span>
            {counts.error > 0 ? " · " : ""}
            {counts.warning}w
          </span>
        )}
        {counts.info > 0 && (
          <span>
            {counts.error > 0 || counts.warning > 0 ? " · " : ""}
            {counts.info}i
          </span>
        )}
      </span>
      {open ? (
        <ChevronDown className="size-3" aria-hidden />
      ) : (
        <ChevronRight className="size-3" aria-hidden />
      )}
    </button>
  );
}

// IntegrationReviewPanel renders summary + sorted findings, mirroring
// ReviewPanel's layout. We also surface the diff range (base..head)
// in the footer because, unlike per-phase reviews, the user can't
// derive it from "the worktree this card refers to" — it's the
// cumulative range across all phases.
function IntegrationReviewPanel({
  snapshot,
}: {
  snapshot: IntegrationReviewSnapshot;
}) {
  const findings = snapshot.findings ?? [];
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-[11px]">
      {snapshot.error ? (
        <div className="flex items-start gap-2 text-destructive">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          <span className="font-mono whitespace-pre-wrap">{snapshot.error}</span>
        </div>
      ) : null}
      {snapshot.summary && (
        <p className="whitespace-pre-wrap text-foreground/80">
          {snapshot.summary}
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {sorted.map((f, i) => (
            <li
              key={`${f.severity}-${i}-${f.title}`}
              className="rounded-md border bg-background/60 p-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <SeverityChip severity={f.severity} />
                {f.category && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {f.category}
                  </Badge>
                )}
                <span className="font-medium">{f.title}</span>
                {f.file && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {f.file}
                    {typeof f.line === "number" ? `:${f.line}` : ""}
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-foreground/80">
                {f.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(snapshot.completedAt || snapshot.base || snapshot.head) && (
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
          {snapshot.completedAt && (
            <span>reviewed {snapshot.completedAt}</span>
          )}
          {snapshot.base && snapshot.head && (
            <span>
              · diff {snapshot.base.slice(0, 7)}..{snapshot.head.slice(0, 7)}
            </span>
          )}
          {snapshot.branch && <span>· branch {snapshot.branch}</span>}
        </div>
      )}
    </div>
  );
}

function severityRank(s: ReviewSeverity): number {
  if (s === "error") return 0;
  if (s === "warning") return 1;
  return 2;
}

function MergeStatusBadge({ status }: { status: PlanMergeStatus }) {
  if (status === "merged") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        merged
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        partial
      </Badge>
    );
  }
  return <Badge variant="destructive">failed</Badge>;
}

function MergeSummaryChip({
  tone,
  label,
}: {
  tone: "emerald" | "muted" | "rose";
  label: string;
}) {
  const cls =
    tone === "emerald"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "rose"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border bg-muted/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function MergeResultChip({ result }: { result: PhaseMergeResult }) {
  const cls =
    result.status === "merged"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : result.status === "skipped"
        ? "border bg-muted/40 text-muted-foreground"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  const detail =
    result.status === "merged" && result.sha
      ? result.sha.slice(0, 7)
      : result.status === "skipped"
        ? "already merged"
        : "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px]",
        cls,
      )}
      title={result.error ? result.error : `${result.branch}`}
    >
      <span>{result.phase_slug}</span>
      <span className="opacity-70">· {detail}</span>
    </span>
  );
}

// NotesPanel surfaces the phase_notes broadcast log. Phases write via
// the submit_phase_note MCP tool; the plan-record poll above picks them
// up. Collapsible because the list grows over the plan's lifetime —
// users glance at recent activity, occasionally expand for the full
// history. Latest-first ordering matches list_phase_notes.
function NotesPanel({
  notes,
  open,
  onToggle,
}: {
  notes: PhaseNote[];
  open: boolean;
  onToggle: () => void;
}) {
  const sorted = useMemo(() => {
    return [...notes].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }, [notes]);
  if (notes.length === 0) {
    // Suppress entirely when empty so the board doesn't gain a hollow
    // strip pre-broadcast. The header chip drives discoverability once
    // the first note lands.
    return null;
  }
  const latest = sorted[0];
  return (
    <div className="border-b bg-violet-500/5 px-6 py-2 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <Megaphone className="size-3.5 text-violet-500" aria-hidden />
        <span className="font-medium uppercase tracking-wide">
          Phase notes
        </span>
        <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-violet-600 dark:text-violet-300">
          {notes.length}
        </span>
        {!open && latest && (
          <span className="min-w-0 flex-1 truncate text-foreground/70">
            <span className="font-mono text-[11px]">{latest.phase_slug}</span>
            <span className="opacity-70"> — {latest.body}</span>
          </span>
        )}
        {open ? (
          <ChevronDown className="ml-auto size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-2 pb-1">
          {sorted.map((note) => (
            <li
              key={note.id}
              className="rounded-md border border-violet-500/20 bg-background px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground/80">
                  {note.phase_slug}
                </span>
                <span className="opacity-70">
                  {formatNoteTime(note.created_at)}
                </span>
                {note.tags?.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-600 dark:text-violet-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                {note.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatNoteTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleString();
}

// ViewToggle is a 2-button segmented control for kanban / dag. Sits in
// the header so the user can flip without scrolling. Active button
// gets the primary background; the inactive one stays muted so the
// current state is unambiguous at a glance.
function ViewToggle({
  value,
  onChange,
}: {
  value: BoardView;
  onChange: (next: BoardView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Board view"
      className="inline-flex items-center rounded-md border bg-muted/30 p-0.5 font-mono"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === "kanban"}
        onClick={() => onChange("kanban")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          value === "kanban"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Kanban swimlanes by status"
      >
        <KanbanSquare className="size-3" aria-hidden />
        <span>kanban</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === "dag"}
        onClick={() => onChange("dag")}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
          value === "dag"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="Dependency graph by depends_on"
      >
        <Network className="size-3" aria-hidden />
        <span>dag</span>
      </button>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "amber" | "blue" | "emerald" | "rose" | "violet";
}) {
  const dot =
    tone === "amber"
      ? "bg-amber-500"
      : tone === "blue"
        ? "bg-blue-500"
        : tone === "emerald"
          ? "bg-emerald-500"
          : tone === "violet"
            ? "bg-violet-500"
            : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      <span className="tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

