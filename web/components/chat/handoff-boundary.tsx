"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight } from "lucide-react";

import type { HandoffRecord } from "@/lib/chat-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// HandoffBoundary is the inline card rendered between turns where the
// session swapped providers. It marks the switch visually and reveals
// the summary the outgoing model wrote so the user can audit what
// context the incoming model received.
//
// Both directions render through this card:
//   forward (anthropic/OR → codex): emerald, → arrow
//   reverse (codex → anthropic/OR): indigo,  ← arrow
//
// Design: a thin horizontal divider with a centered chip naming the
// destination, plus a collapsible block underneath holding the full
// summary. Default-collapsed because the user rarely re-reads it.
export function HandoffBoundary({ record }: { record: HandoffRecord }) {
  const [expanded, setExpanded] = useState(false);
  const reverse = record.from_provider === "codex";
  const tone = reverse ? "indigo" : "emerald";
  const fromLabel = describeSource(record);
  const targetLabel = describeTarget(record);
  return (
    <div
      className={
        reverse
          ? "my-3 border-y border-dashed border-indigo-500/30 bg-indigo-500/[0.04] px-3 py-2"
          : "my-3 border-y border-dashed border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2"
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {reverse ? (
          <ArrowLeft className="size-3.5 text-indigo-600 dark:text-indigo-400" />
        ) : (
          <ArrowRight className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        )}
        <span
          className={
            reverse
              ? "font-medium text-indigo-700 dark:text-indigo-300"
              : "font-medium text-emerald-700 dark:text-emerald-300"
          }
        >
          {reverse ? "Resumed Claude" : "Handed off"}
        </span>
        <ProviderChip label={fromLabel} tone="muted" />
        <span className="text-muted-foreground">→</span>
        <ProviderChip label={targetLabel} tone={tone} />
        <span className="text-muted-foreground">·</span>
        <time
          className="text-muted-foreground"
          dateTime={record.at}
          title={record.at}
        >
          {formatTime(record.at)}
        </time>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronDown className="mr-1 size-3" /> Hide summary
            </>
          ) : (
            <>
              <ChevronRight className="mr-1 size-3" /> Show summary
            </>
          )}
        </Button>
      </div>
      {expanded && (
        <div className="mt-2 max-h-72 overflow-auto rounded border bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {record.summary}
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {reverse
          ? "Claude has the full tool suite back (Read/Edit/Bash/MCP). The codex thread stays around — switch back via the model picker if you want to resume there."
          : "Codex drives its own tool suite (shell, apply_patch, file ops, MCP). Pick a Claude model from the composer to hand back."}
      </p>
    </div>
  );
}

function ProviderChip({
  label,
  tone,
}: {
  label: string;
  tone: "emerald" | "indigo" | "muted";
}) {
  if (tone === "emerald") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
      >
        {label}
      </Badge>
    );
  }
  if (tone === "indigo") {
    return (
      <Badge
        variant="outline"
        className="border-indigo-500/40 bg-indigo-500/10 text-[10px] text-indigo-700 dark:text-indigo-300"
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px]">
      {label}
    </Badge>
  );
}

function describeTarget(record: HandoffRecord): string {
  if (record.to_provider === "codex") {
    const acct = record.codex_account_name;
    const model = record.codex_model;
    if (acct && model) return `codex · ${acct} · ${model}`;
    if (acct) return `codex · ${acct}`;
    if (model) return `codex · ${model}`;
    return "codex";
  }
  return record.to_provider;
}

function describeSource(record: HandoffRecord): string {
  if (record.from_provider === "codex") {
    const acct = record.codex_account_name;
    const model = record.codex_model;
    if (acct && model) return `codex · ${acct} · ${model}`;
    if (acct) return `codex · ${acct}`;
    if (model) return `codex · ${model}`;
    return "codex";
  }
  return record.from_provider;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
