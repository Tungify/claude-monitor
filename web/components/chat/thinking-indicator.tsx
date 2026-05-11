"use client";

import { useEffect, useState } from "react";

// ThinkingIndicator fills the dead air between "user just sent" and the
// first streamed delta. Without it the UI looks frozen for the few
// seconds the API takes to start producing tokens, and users assume the
// app crashed. Three rotating verbs (Thinking / Working / Reasoning)
// also signal progress so the indicator doesn't go stale-feeling. When
// the parent passes turn-in-progress metadata (elapsed wall-clock,
// running token totals) we surface it inline so the user can watch
// "(3m 43s · ↑ 17.5k tokens)" tick alongside the verb — same shape the
// Claude CLI uses for its thinking line.
const VERBS = ["Thinking", "Working", "Reasoning"] as const;

export function ThinkingIndicator({
  variant = "default",
  elapsedMs,
  inputTokens,
  outputTokens,
}: {
  // "default" matches the assistant message bubble; "compact" is sized
  // for inline footer usage (under the composer). Both look identical
  // visually, just slightly different padding.
  variant?: "default" | "compact";
  // Wall-clock milliseconds since the in-flight turn began. The parent
  // ticks this at 1 Hz so the rendered string stays fresh; omit to hide
  // the elapsed segment entirely (e.g. when no turn is in progress).
  elapsedMs?: number;
  // Latest assistant message's input/output token usage for the
  // current turn. Input includes raw + cache_read + cache_creation —
  // that's the "context size pumped into Claude" number the CLI shows
  // as `↑`. Output is the model's running response token count.
  inputTokens?: number;
  outputTokens?: number;
}) {
  const [verbIdx, setVerbIdx] = useState(0);

  // Rotate the verb every 2.5s. Slow enough to read, fast enough to
  // signal continuous progress. Cleared on unmount so the timer doesn't
  // outlive the indicator.
  useEffect(() => {
    const id = setInterval(() => {
      setVerbIdx((i) => (i + 1) % VERBS.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  const verb = VERBS[verbIdx];

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        variant === "compact"
          ? "inline-flex items-center gap-2 text-xs text-muted-foreground"
          : "inline-flex items-center gap-2 rounded-md bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm"
      }
    >
      {/* Three pulsing dots in a row, each delayed so they appear to
          chase one another. Tailwind's animate-bounce is too tall for
          inline use; we use a custom keyframe via opacity instead. */}
      <span className="flex gap-1" aria-hidden>
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </span>
      <span className="tabular-nums">{verb}…</span>
      <TurnMetaLine
        elapsedMs={elapsedMs}
        inputTokens={inputTokens}
        outputTokens={outputTokens}
      />
    </div>
  );
}

// TurnMetaLine renders the parenthesised meta used by the in-flight
// turn: "(3m 43s · ↑ 17.5k tokens · ↓ 1.2k)". Pulled out of the
// ThinkingIndicator so we can reuse it as a footer below the streaming
// assistant bubble — the user sees the same numbers continue ticking
// once Claude transitions from "still thinking" to "writing response".
export function TurnMetaLine({
  elapsedMs,
  inputTokens,
  outputTokens,
}: {
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const parts: string[] = [];
  if (typeof elapsedMs === "number") parts.push(formatElapsed(elapsedMs));
  if (typeof inputTokens === "number" && inputTokens > 0) {
    parts.push(`↑ ${formatTokens(inputTokens)} tokens`);
  }
  if (typeof outputTokens === "number" && outputTokens > 0) {
    parts.push(`↓ ${formatTokens(outputTokens)}`);
  }
  if (parts.length === 0) return null;
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground/80">
      {parts.join(" · ")}
    </span>
  );
}

// Compact elapsed string: under a minute → "12s"; under an hour → "1m 23s";
// anything longer → "2h 5m". Matches the CLI's shape so a user moving
// between surfaces reads the same units.
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes - hours * 60;
  return `${hours}h ${remMin}m`;
}

// Tokens shorten as k/M so the chip stays compact: 17500 → "17.5k",
// 1_250_000 → "1.25M". Sub-1k values render as-is (no decimals).
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block size-1.5 rounded-full bg-muted-foreground/70"
      style={{
        animation: "cm-thinking-pulse 1s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}
