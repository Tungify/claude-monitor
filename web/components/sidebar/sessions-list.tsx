"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageSquare,
  Moon,
  Network,
  ShieldAlert,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessions, stopSessionRemote } from "@/lib/sessions-context";
import type { SessionSummary, SubagentSummary } from "@/lib/chat-types";

interface PlanGroup {
  planId: string;
  // The first session created in this plan group anchors a stable
  // display order. Plans whose newest phase session is most recent
  // bubble to the top of the plans block.
  newestCreatedAt: string;
  sessions: SessionSummary[];
}

// SessionsList consumes the shared SessionsProvider so the sidebar
// renders rows from one /api/chat poll instead of opening many. The
// running state is folded into each row directly (no separate "Running"
// panel) since a run always belongs to exactly one session.
//
// Phase sessions (those with a plan_id) are visually grouped under
// their owning plan. Standalone chats render flat at the top.
export function SessionsList() {
  const { sessions, refresh, unseenDone, loaded, markVisited } = useSessions();
  const pathname = usePathname();

  // Pull the active session id out of /chat/[id]. Avoids carrying the
  // pathname through every row.
  const activeId = pathname?.startsWith("/chat/")
    ? pathname.slice("/chat/".length).split("/")[0]
    : undefined;

  // Bucket sessions by plan_id. /api/chat already returns sessions
  // sorted newest-first, so within each plan the order matches the
  // order phase agents were spawned (sequential in approve route).
  const { standalone, plans } = useMemo(() => {
    const standalone: SessionSummary[] = [];
    const planMap = new Map<string, PlanGroup>();
    for (const s of sessions) {
      if (!s.plan_id) {
        standalone.push(s);
        continue;
      }
      let group = planMap.get(s.plan_id);
      if (!group) {
        group = {
          planId: s.plan_id,
          newestCreatedAt: s.created_at,
          sessions: [],
        };
        planMap.set(s.plan_id, group);
      }
      group.sessions.push(s);
      if (s.created_at > group.newestCreatedAt) {
        group.newestCreatedAt = s.created_at;
      }
    }
    const plans = Array.from(planMap.values()).sort((a, b) =>
      b.newestCreatedAt.localeCompare(a.newestCreatedAt),
    );
    return { standalone, plans };
  }, [sessions]);

  if (!loaded) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
        No sessions yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {standalone.length > 0 && (
        <ul className="space-y-0.5 px-1">
          {standalone.map((s) => (
            <li key={s.id}>
              <SessionRow
                session={s}
                active={s.id === activeId}
                done={unseenDone.has(s.id)}
                onAfterStop={refresh}
                onVisit={markVisited}
              />
            </li>
          ))}
        </ul>
      )}
      {plans.map((group) => (
        <PlanGroupBlock
          key={group.planId}
          group={group}
          activeId={activeId}
          unseenDone={unseenDone}
          onAfterStop={refresh}
          onVisit={markVisited}
        />
      ))}
    </div>
  );
}

function PlanGroupBlock({
  group,
  activeId,
  unseenDone,
  onAfterStop,
  onVisit,
}: {
  group: PlanGroup;
  activeId?: string;
  unseenDone: Set<string>;
  onAfterStop: () => void;
  onVisit: (id: string) => void;
}) {
  // Default-open so newly spawned plan groups surface their phases
  // without an extra click; the user can collapse if it gets noisy.
  const [open, setOpen] = useState<boolean>(true);
  const planShort = group.planId.slice(0, 8);
  const runningCount = group.sessions.filter(
    (s) => s.status === "thinking" || s.status === "starting",
  ).length;

  return (
    <div className="px-1">
      <div className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-mono uppercase tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent/50">
        <Link
          href={`/plans/${group.planId}`}
          title="Open phase board"
          className="flex min-w-0 flex-1 items-center gap-1.5 hover:text-foreground"
        >
          <Network className="size-3 shrink-0" aria-hidden />
          <span className="truncate">plan {planShort}</span>
        </Link>
        <span className="shrink-0 normal-case tabular-nums">
          {runningCount > 0
            ? `${runningCount}/${group.sessions.length} running`
            : `${group.sessions.length} phases`}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse plan" : "Expand plan"}
          className="shrink-0 rounded p-0.5 hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              open ? "rotate-0" : "-rotate-90",
            )}
            aria-hidden
          />
        </button>
      </div>
      {open && (
        <ul className="mt-1 ml-2 space-y-0.5 border-l border-border/60 pl-2">
          {group.sessions.map((s) => (
            <li key={s.id}>
              <SessionRow
                session={s}
                active={s.id === activeId}
                done={unseenDone.has(s.id)}
                onAfterStop={onAfterStop}
                onVisit={onVisit}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  done,
  onAfterStop,
  onVisit,
}: {
  session: SessionSummary;
  active: boolean;
  done: boolean;
  onAfterStop: () => void;
  onVisit: (id: string) => void;
}) {
  // Phase sessions surface their slug as the headline — that's what
  // the user thinks of them as ("the publish phase", not the kickoff
  // prompt's first line). Standalone chats keep the user-text title.
  const title = session.phase_slug ?? session.title ?? "New chat";
  const titleIsSlug = Boolean(session.phase_slug);
  const subtitle = subtitleFor(session);
  // Only surface subagents that are still working: once a Task completes,
  // the user doesn't need it cluttering the sidebar tree. Filter inside
  // useMemo so a fresh `[]` literal in `session.subagents` doesn't bust
  // the dependency array on every render.
  const activeSubagents = useMemo(
    () => (session.subagents ?? []).filter((s) => s.status === "active"),
    [session.subagents],
  );
  // Collapse subagent tree by default. Active row starts expanded so
  // the user landing in /chat/[id] sees the tree they came to dig into.
  const [open, setOpen] = useState(active);
  const [stopping, startStop] = useTransition();

  const running =
    session.status === "thinking" || session.status === "awaiting_permission";
  const awaiting = session.status === "awaiting_permission";
  // "starting" = SDK Query is spinning up (fresh session OR a session
  // that was just promoted from the interrupted shadow). Show the same
  // spinner as `running` but a distinct label so the user knows the
  // backend is booting, not yet doing model work.
  const starting = session.status === "starting";
  // "interrupted" = loaded from disk after a restart, no live Query.
  // Render with a sleeping icon + muted label so the user can tell at
  // a glance it's a stored session waiting to wake up on click.
  const interrupted = session.status === "interrupted";

  const onStop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startStop(async () => {
      await stopSessionRemote(session.id);
      onAfterStop();
    });
  };

  return (
    <div className="group/row">
      <div
        className={cn(
          "relative flex items-start rounded-md transition-colors",
          // Running rows get a soft amber wash so the eye spots them
          // even when scanning a long list. Active row keeps its own
          // accent so the user doesn't lose track of where they are.
          running && !active && "bg-amber-500/[0.07]",
          // Starting rows: same wash family but cooler, signaling
          // "booting up" vs "actively working".
          starting && !active && "bg-sky-500/[0.07]",
          // Active row: stronger accent + a primary-colored vertical
          // bar on the left edge so the eye snaps to it even in a long
          // list with multiple amber/sky-washed rows. Previously the
          // sidebar-accent wash blended in with running rows.
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium ring-1 ring-sidebar-ring/40 shadow-sm before:absolute before:inset-y-1 before:-left-0.5 before:w-[3px] before:rounded-full before:bg-primary"
            : "text-sidebar-foreground/85 hover:bg-sidebar-accent/60",
        )}
      >
        <Link
          href={`/chat/${session.id}`}
          onClick={() => onVisit(session.id)}
          className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-sm"
        >
          {running ? (
            // Spinner / shield for in-flight sessions. Replaces the
            // generic MessageSquare icon so a quick glance tells you
            // which rows are doing work right now.
            awaiting ? (
              <ShieldAlert
                className="mt-0.5 size-3.5 shrink-0 text-blue-500"
                aria-hidden
              />
            ) : (
              <Loader2
                className="mt-0.5 size-3.5 shrink-0 animate-spin text-amber-500"
                aria-hidden
              />
            )
          ) : starting ? (
            // Same spinner glyph as `running` but in sky to differentiate
            // "booting" from "actively thinking". The transition from
            // starting → idle (or → thinking) flips the color naturally.
            <Loader2
              className="mt-0.5 size-3.5 shrink-0 animate-spin text-sky-500"
              aria-hidden
            />
          ) : interrupted ? (
            <Moon
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : done ? (
            // "Task just finished, you haven't checked it yet" — green
            // check (matches the success palette used elsewhere). Clears
            // the moment the user clicks into the chat.
            <CheckCircle2
              className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
              aria-hidden
            />
          ) : (
            <MessageSquare className="mt-0.5 size-3.5 shrink-0 opacity-70" />
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <div className={cn("truncate", titleIsSlug && "font-mono")}>{title}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {running ? (
                <>
                  <span
                    className={cn(
                      "font-medium",
                      awaiting
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {awaiting ? "Awaiting permission" : "Working…"}
                  </span>
                  {" · "}
                  <span>{subtitle}</span>
                </>
              ) : starting ? (
                <>
                  <span className="font-medium text-sky-600 dark:text-sky-400">
                    Starting…
                  </span>
                  {" · "}
                  <span>{subtitle}</span>
                </>
              ) : interrupted ? (
                <>
                  <span className="font-medium">Restored</span>
                  {" · "}
                  <span>{subtitle}</span>
                </>
              ) : done ? (
                <>
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    Done
                  </span>
                  {" · "}
                  <span>{subtitle}</span>
                </>
              ) : (
                subtitle
              )}
            </div>
          </div>
          {/* Status dot still rides along when the session is NOT
              running / starting / interrupted / done — those already
              carry their own icon (spinner / moon / green check) and a
              colored label, so an extra dot would just be noise.
              Errored / closed / idle keep the dot since they fall back
              to the generic MessageSquare icon. */}
          {!running && !starting && !interrupted && !done && (
            <StatusDot status={session.status} />
          )}
        </Link>

        {/* Stop button: visible on hover for running rows. Click stops
            the session via DELETE. We render it as a real <button>
            (not nested inside the Link) so its click handler runs
            without first navigating into the chat. */}
        {running && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={`Stop ${title}`}
            title="Stop session"
            className={cn(
              "mt-1 mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-all",
              "opacity-0 group-hover/row:opacity-100",
              "hover:bg-destructive/15 hover:text-destructive",
              "disabled:opacity-40",
            )}
          >
            <Square className="size-3" aria-hidden />
          </button>
        )}

        {activeSubagents.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={
              open
                ? `Hide ${activeSubagents.length} running subagents`
                : `Show ${activeSubagents.length} running subagents`
            }
            className="flex shrink-0 items-center gap-1 px-1.5 py-1.5 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>{activeSubagents.length}</span>
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                open ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden
            />
          </button>
        )}
      </div>

      {activeSubagents.length > 0 && open && (
        <ul className="mt-0.5 ml-4 space-y-0.5 border-l border-border/60 pl-2">
          {activeSubagents.map((sub) => (
            <li key={sub.task_id}>
              <SubagentRow sessionId={session.id} subagent={sub} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentRow({
  sessionId,
  subagent,
}: {
  sessionId: string;
  subagent: SubagentSummary;
}) {
  const heading = subagent.subagent_type ?? "subagent";
  const description = subagent.description?.trim();
  return (
    <Link
      href={`/chat/${sessionId}#subagent-${subagent.task_id}`}
      className="flex items-start gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
    >
      <SubagentDot status={subagent.status} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-mono">{heading}</div>
        {description && (
          <div className="truncate text-[10.5px] text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <span className="shrink-0 self-center font-mono text-[10px] text-muted-foreground">
        {subagent.tool_calls}
      </span>
    </Link>
  );
}

function SubagentDot({ status }: { status: SubagentSummary["status"] }) {
  const color =
    status === "errored"
      ? "bg-destructive"
      : status === "active"
        ? "bg-amber-500 animate-pulse"
        : "bg-emerald-500";
  return (
    <span
      title={status}
      className={cn("mt-1.5 inline-block size-1.5 shrink-0 rounded-full", color)}
    />
  );
}

function subtitleFor(s: SessionSummary): string {
  const when = relativeTime(s.created_at);
  if (s.account_name) return `${when} · ${s.account_name}`;
  return when;
}

// StatusDot is only used for the *non-running* states (errored / closed
// / idle) since running sessions get a more prominent spinner inline.
function StatusDot({ status }: { status: SessionSummary["status"] }) {
  const base =
    status === "errored"
      ? "bg-destructive"
      : status === "closed"
        ? "bg-muted-foreground/40"
        : "bg-emerald-500";
  return (
    <span
      title={status.replace("_", " ")}
      className={cn("mt-2 mr-2 inline-block size-1.5 shrink-0 rounded-full", base)}
    />
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
