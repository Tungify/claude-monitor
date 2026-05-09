"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Phase, PhaseSession } from "@/lib/plan-types";
import type { SessionStatus, SessionSummary } from "@/lib/chat-types";
import { Badge } from "@/components/ui/badge";
import { computeDagLayout, type DagNode } from "./dag-layout";

// PhaseRow mirrors the shape PhaseBoard already builds for its kanban
// columns. Duplicated locally because the canonical type is internal
// to phase-board.tsx and exporting it would re-trigger the file's
// 1971-line monolith problem. The shape is small enough that drift
// risk is tolerable.
export interface DagPhaseRow {
  phase: Phase;
  link?: PhaseSession;
  session?: SessionSummary;
}

// DagView positions phases by dependency depth (left-to-right) and
// draws bezier edges from each phase to its dependents. Read-only:
// click a node to open its agent. Drag-to-edit deps is a follow-up.
//
// Edge color reflects the source phase's session status so the user
// can trace blockers visually — a rose-tinted edge means the upstream
// phase is rate-limited / errored, an amber one means it's still
// thinking, etc.
export function DagView({ rows }: { rows: DagPhaseRow[] }) {
  const phases = useMemo(() => rows.map((r) => r.phase), [rows]);
  const layout = useMemo(() => computeDagLayout(phases), [phases]);
  const rowBySlug = useMemo(
    () => new Map(rows.map((r) => [r.phase.slug, r])),
    [rows],
  );
  const nodeBySlug = useMemo(
    () => new Map(layout.nodes.map((n) => [n.slug, n])),
    [layout.nodes],
  );

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
        no phases
      </div>
    );
  }

  // Card geometry: nodes consume ~88% of cell width and ~78% of cell
  // height, leaving gutter for edges and labels.
  const cardW = layout.cellW * 0.88;
  const cardH = layout.cellH * 0.78;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {layout.hasCycle && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3.5" aria-hidden />
          <span>
            Cycle detected in <code className="font-mono">depends_on</code> —
            cycle members rendered at depth 0. Fix the plan to remove the loop.
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            <defs>
              <marker
                id="dag-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  className="fill-muted-foreground/60"
                />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const from = nodeBySlug.get(e.from);
              const to = nodeBySlug.get(e.to);
              if (!from || !to) return null;
              const fromX = from.x + cardW;
              const fromY = from.y + cardH / 2;
              const toX = to.x;
              const toY = to.y + cardH / 2;
              // Cubic bezier with horizontal handles so the curve eases
              // into the right side of the source and the left side of
              // the target — visually clear directionality.
              const dx = Math.max(40, (toX - fromX) / 2);
              const path = `M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
              const fromStatus = rowBySlug.get(e.from)?.session?.status;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={path}
                  fill="none"
                  strokeWidth={1.5}
                  className={edgeColor(fromStatus)}
                  markerEnd="url(#dag-arrow)"
                />
              );
            })}
          </svg>
          {layout.nodes.map((n) => {
            const row = rowBySlug.get(n.slug);
            if (!row) return null;
            return (
              <DagNodeCard
                key={n.slug}
                node={n}
                row={row}
                width={cardW}
                height={cardH}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function edgeColor(status: SessionStatus | undefined): string {
  if (!status) return "stroke-muted-foreground/40";
  if (status === "errored") return "stroke-destructive/70";
  if (status === "thinking") return "stroke-amber-500/70";
  if (status === "awaiting_permission") return "stroke-blue-500/60";
  if (status === "rate_limited") return "stroke-rose-500/70";
  if (status === "idle") return "stroke-emerald-500/60";
  return "stroke-muted-foreground/40";
}

function DagNodeCard({
  node,
  row,
  width,
  height,
}: {
  node: DagNode;
  row: DagPhaseRow;
  width: number;
  height: number;
}) {
  const { phase, link, session } = row;
  const status = session?.status;
  const className = cn(
    "absolute flex flex-col gap-1 rounded-md border bg-background p-2 shadow-sm transition-colors",
    link && "hover:bg-muted/50",
    statusBorder(status),
  );
  const style = { left: node.x, top: node.y, width, height };
  const inner = (
    <>
      <div className="flex items-start gap-1.5">
        <DagStatusDot status={status} />
        <Badge variant="outline" className="font-mono text-[10px]">
          {phase.slug}
        </Badge>
        {link && (
          <ArrowRight
            className="ml-auto size-3 text-muted-foreground/70"
            aria-hidden
          />
        )}
      </div>
      <div className="line-clamp-2 text-xs font-medium leading-snug">
        {phase.title}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1 text-[10px] font-mono text-muted-foreground">
        {link?.commit_status && (
          <span
            className={cn(
              "rounded px-1 py-0.5",
              link.commit_status === "failed"
                ? "bg-destructive/10 text-destructive"
                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
            title={`commit: ${link.commit_status}`}
          >
            {link.commit_status === "committed"
              ? link.commit_sha?.slice(0, 7) ?? "committed"
              : link.commit_status}
          </span>
        )}
        {link?.review_status === "running" && (
          <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700 dark:text-violet-300">
            reviewing…
          </span>
        )}
        {link?.review_status === "complete" &&
          (link.review_findings?.length ?? 0) > 0 && (
            <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700 dark:text-violet-300">
              {link.review_findings!.length} finding
              {link.review_findings!.length === 1 ? "" : "s"}
            </span>
          )}
        {(link?.scope_violations?.length ?? 0) > 0 && (
          <span
            className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-700 dark:text-amber-300"
            title={link!.scope_violations!.join("\n")}
          >
            {link!.scope_violations!.length} out of scope
          </span>
        )}
      </div>
    </>
  );
  if (link) {
    return (
      <Link
        href={`/chat/${link.session_id}`}
        className={className}
        style={style}
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}

function statusBorder(status: SessionStatus | undefined): string {
  if (status === "errored") return "border-destructive/40";
  if (status === "thinking") return "border-amber-500/50";
  if (status === "awaiting_permission") return "border-blue-500/50";
  if (status === "rate_limited") return "border-rose-500/50";
  return "";
}

function DagStatusDot({ status }: { status: SessionStatus | undefined }) {
  const color = !status
    ? "bg-muted-foreground/40"
    : status === "errored"
      ? "bg-destructive"
      : status === "thinking"
        ? "bg-amber-500 animate-pulse"
        : status === "awaiting_permission"
          ? "bg-blue-500"
          : status === "rate_limited"
            ? "bg-rose-500 animate-pulse"
            : status === "idle"
              ? "bg-emerald-500"
              : status === "closed"
                ? "bg-muted-foreground/40"
                : "bg-muted-foreground/60";
  return (
    <span
      className={cn("mt-0.5 inline-block size-2 shrink-0 rounded-full", color)}
      title={status ? status.replace("_", " ") : "not started"}
    />
  );
}
