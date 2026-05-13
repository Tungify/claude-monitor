"use client";

import { Markdown } from "@/components/markdown/markdown";
import { cn } from "@/lib/utils";

export interface UsageBar {
  // Short left-side label, e.g. "Session 5h" or "Context".
  label: string;
  // Fill ratio, 0..1. Values outside the range are clamped at render.
  value: number;
  // Right-side note shown after the percentage, e.g. "↻ 14:30" or
  // "18.4K / 1M". Optional; omit for plain bars.
  meta?: string;
  // Visual hint when a window is approaching/over its limit. When
  // omitted the bar follows the bubble's overall tone.
  tone?: "info" | "warning" | "error";
}

// ContextCategory is one segment in the /context category breakdown — a
// region of context window real-estate attributed to a known source
// (system prompt, tools, memory, messages, etc.). `tokens` is the
// estimate; `color` drives both the right-list bullet and the matching
// cells in the grid visualization.
export interface ContextCategory {
  name: string;
  tokens: number;
  color: string;
  // When true, the right-list shows the category but the grid does NOT
  // paint cells for it. Used for autocompact buffer + the free-space
  // remainder, which both have their own visual treatment.
  exclude?: "free" | "autocompact";
}

export interface ContextView {
  // Display label + raw model id (CLI shows both stacked). modelLabel is
  // the friendly name ("Opus 4.7 (1M context)"), modelId the SDK string
  // ("claude-opus-4-7[1m]").
  modelLabel: string;
  modelId: string;
  totalTokens: number;
  rawMaxTokens: number;
  // Number of trailing cells reserved as autocompact buffer. The CLI
  // reserves a fixed window so the model can respond before /compact
  // triggers; we approximate as 5% of rawMaxTokens.
  autocompactBufferTokens: number;
  categories: ContextCategory[];
}

export interface CommandOutput {
  // The full text the user typed, including the leading slash, e.g.
  // "/model claude-haiku-4-5-20251001". Echoed in mono at the top so the
  // user can see exactly what they ran.
  echo: string;
  // Optional one-line subtitle (e.g. "Active session settings").
  subtitle?: string;
  // Markdown body rendered with the standard chat Markdown component.
  body?: string;
  // Optional structured rows displayed as a key/value list above the body.
  // Useful for /usage, /context, /status — anything the user reads as
  // discrete fields rather than prose.
  rows?: Array<{ label: string; value: string }>;
  // Progress bars rendered above rows. Used by /usage, /context to show
  // quota / context-window utilization at a glance.
  bars?: UsageBar[];
  // Single trailing line in monospace, useful for token totals or other
  // tagalong stats that don't fit cleanly in a row grid.
  footer?: string;
  // Rich /context payload — when present, renders the CLI-like grid +
  // category list. Mutually exclusive with bars/rows in practice; the
  // bubble renders both if both are set.
  context?: ContextView;
  // Visual accent when the command resulted in an error or warning.
  tone?: "info" | "success" | "warning" | "error";
}

interface Props {
  output: CommandOutput;
}

// CommandOutputBubble renders the result of a slash command as an inline
// system-style notice in the chat list. Distinct from regular message
// bubbles so it doesn't get confused with assistant or user content.
export function CommandOutputBubble({ output }: Props) {
  const tone = output.tone ?? "info";
  const accent =
    tone === "error"
      ? "border-l-destructive/70"
      : tone === "warning"
        ? "border-l-amber-500/70"
        : tone === "success"
          ? "border-l-emerald-500/70"
          : "border-l-muted-foreground/40";

  const hasBody =
    (output.bars?.length ?? 0) > 0 ||
    (output.rows?.length ?? 0) > 0 ||
    !!output.body ||
    !!output.footer ||
    !!output.context;

  return (
    <div
      className={cn(
        "rounded-md border bg-muted/30 border-l-2",
        accent,
      )}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">
          {output.echo}
        </span>
        {output.subtitle && (
          <span className="truncate text-[11px] text-muted-foreground/80">
            {output.subtitle}
          </span>
        )}
      </div>
      {hasBody && (
        <div className="space-y-2 px-3 py-2 text-sm">
          {output.context && <ContextPanel view={output.context} />}
          {output.bars && output.bars.length > 0 && (
            <div className="space-y-1">
              {output.bars.map((b, i) => (
                <BarRow key={i} bar={b} />
              ))}
            </div>
          )}
          {output.rows && output.rows.length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              {output.rows.map((r, i) => (
                <div key={i} className="contents">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="font-mono break-all">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {output.body && <Markdown source={output.body} />}
          {output.footer && (
            <div className="font-mono text-[11px] text-muted-foreground pt-1">
              {output.footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// GRID_ROWS / GRID_COLS match the CLI's /context viewport exactly so the
// grid feels familiar. Total cells = 200, each cell ≈ rawMaxTokens / 200
// tokens — e.g. for a 1M window, one cell is 5K tokens.
const GRID_ROWS = 10;
const GRID_COLS = 20;
const GRID_TOTAL = GRID_ROWS * GRID_COLS;

interface CellPaint {
  // Tailwind text color class for the cell glyph. Free / autocompact
  // cells use muted/destructive variants; categories use their own.
  className: string;
  // Filled vs hollow square. CLI uses ⛁ for >=70% full of a category and
  // ⛀ for the trailing partial cell — we approximate with two filled
  // glyphs but distinct by category since fractional fullness rarely
  // shows on a 200-cell grid.
  glyph: "full" | "partial" | "free" | "autocompact";
}

// paintGrid converts the categories into 200 ordered cells. Categories
// fill cells left-to-right, top-to-bottom in the order given. Free
// space + autocompact buffer occupy the trailing cells.
function paintGrid(view: ContextView): CellPaint[] {
  const cells: CellPaint[] = [];
  const tokensPerCell = view.rawMaxTokens / GRID_TOTAL || 1;
  const autocompactCells = Math.min(
    GRID_TOTAL,
    Math.max(
      0,
      Math.round(view.autocompactBufferTokens / tokensPerCell),
    ),
  );
  const usableCells = GRID_TOTAL - autocompactCells;

  let used = 0;
  for (const cat of view.categories) {
    if (cat.exclude) continue;
    const want = Math.round(cat.tokens / tokensPerCell);
    const take = Math.min(want, usableCells - used);
    for (let i = 0; i < take; i++) {
      // Last cell of a category gets the partial glyph as a subtle
      // boundary marker — not perfectly faithful to CLI's "fullness"
      // logic but close enough at 200-cell resolution.
      const isLast = i === take - 1 && want > 0;
      cells.push({
        className: cat.color,
        glyph: isLast ? "partial" : "full",
      });
    }
    used += take;
    if (used >= usableCells) break;
  }
  while (cells.length < usableCells) {
    cells.push({ className: "text-muted-foreground/40", glyph: "free" });
  }
  for (let i = 0; i < autocompactCells; i++) {
    cells.push({
      className: "text-amber-500/70",
      glyph: "autocompact",
    });
  }
  return cells;
}

const GLYPH: Record<CellPaint["glyph"], string> = {
  full: "⛁",
  partial: "⛀",
  free: "⛶",
  autocompact: "⛝",
};

function ContextPanel({ view }: { view: ContextView }) {
  const cells = paintGrid(view);
  const pct = view.rawMaxTokens > 0
    ? (view.totalTokens / view.rawMaxTokens) * 100
    : 0;
  const freeTokens = Math.max(
    0,
    view.rawMaxTokens - view.totalTokens - view.autocompactBufferTokens,
  );
  const freePct = view.rawMaxTokens > 0
    ? (freeTokens / view.rawMaxTokens) * 100
    : 0;
  const bufferPct = view.rawMaxTokens > 0
    ? (view.autocompactBufferTokens / view.rawMaxTokens) * 100
    : 0;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
      <div className="shrink-0 font-mono text-[11px] leading-[1.05]">
        {Array.from({ length: GRID_ROWS }).map((_, r) => (
          <div key={r} className="flex">
            {cells
              .slice(r * GRID_COLS, (r + 1) * GRID_COLS)
              .map((cell, c) => (
                <span
                  key={c}
                  className={cn("inline-block px-[1px]", cell.className)}
                >
                  {GLYPH[cell.glyph]}
                </span>
              ))}
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        <div className="font-semibold">{view.modelLabel}</div>
        <div className="font-mono text-muted-foreground">{view.modelId}</div>
        <div className="text-muted-foreground">
          {humanInt(view.totalTokens)}/{humanInt(view.rawMaxTokens)} tokens
          {" "}
          ({pct.toFixed(pct < 10 ? 1 : 0)}%)
        </div>
        <div className="mt-2 italic text-muted-foreground/80">
          Estimated usage by category
        </div>
        <ul className="space-y-0.5">
          {view.categories
            .filter((c) => c.exclude !== "free" && c.tokens > 0)
            .map((c) => (
              <li key={c.name} className="flex gap-1">
                <span className={cn("shrink-0", c.color)}>
                  {c.exclude === "autocompact" ? "⛝" : "⛁"}
                </span>
                <span className="truncate">{c.name}:</span>
                <span className="text-muted-foreground tabular-nums">
                  {humanInt(c.tokens)} tokens (
                  {((c.tokens / view.rawMaxTokens) * 100).toFixed(1)}%)
                </span>
              </li>
            ))}
          <li className="flex gap-1">
            <span className="shrink-0 text-muted-foreground/60">⛶</span>
            <span className="truncate">Free space:</span>
            <span className="text-muted-foreground tabular-nums">
              {humanInt(freeTokens)} tokens ({freePct.toFixed(1)}%)
            </span>
          </li>
          {view.autocompactBufferTokens > 0 && (
            <li className="flex gap-1">
              <span className="shrink-0 text-amber-500/80">⛝</span>
              <span className="truncate">Autocompact buffer:</span>
              <span className="text-muted-foreground tabular-nums">
                {humanInt(view.autocompactBufferTokens)} tokens (
                {bufferPct.toFixed(1)}%)
              </span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function humanInt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function BarRow({ bar }: { bar: UsageBar }) {
  const pct = Math.max(0, Math.min(1, bar.value)) * 100;
  // Auto-promote tone for hot windows so the user notices before any
  // explicit override the caller might pass. Caller's tone wins.
  const auto: UsageBar["tone"] =
    pct >= 95 ? "error" : pct >= 75 ? "warning" : "info";
  const tone = bar.tone ?? auto;
  const fill =
    tone === "error"
      ? "bg-destructive"
      : tone === "warning"
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="w-28 shrink-0 truncate text-muted-foreground">
        {bar.label}
      </div>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", fill)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="w-12 shrink-0 text-right font-mono tabular-nums">
        {pct.toFixed(pct < 10 ? 1 : 0)}%
      </div>
      <div className="w-24 shrink-0 truncate text-right text-[11px] text-muted-foreground">
        {bar.meta ?? ""}
      </div>
    </div>
  );
}
