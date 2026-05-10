"use client";

import { useState } from "react";
import { Check, ChevronDown, Router } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DEFAULT_MODEL_ID,
  EFFORT_LABELS,
  MODELS,
  modelById,
  type ModelInfo,
} from "@/lib/models";
import { cn } from "@/lib/utils";
import type { Effort, SessionProvider } from "@/lib/chat-types";

interface Props {
  modelId: string;
  effort: Effort;
  onModelChange: (id: string) => void;
  onEffortChange: (e: Effort) => void;
  // When provider === "openrouter", the chip and the model rows show
  // the OR model id mapped to each Anthropic tier. Without a mapping,
  // the row just shows the Claude tier name (which is what the binary
  // requests) — that's still legal, OR will pick a default.
  provider?: SessionProvider;
  orModels?: { opus?: string; sonnet?: string; haiku?: string };
}

// Maps a Claude model id to the binary's internal tier so we can look
// up the user's OR mapping. Defaults to opus on unknown ids — the
// orchestrator's MODELS list only carries Anthropic ids today, but if
// someone wires a tier-less custom id we'd rather show "opus" than
// throw.
function tierFor(modelId: string): "opus" | "sonnet" | "haiku" {
  if (modelId.includes("haiku")) return "haiku";
  if (modelId.includes("sonnet")) return "sonnet";
  return "opus";
}

// Trims `provider/model-name` → `model-name` for compact display in
// the chip. Long ids would otherwise blow out the toolbar layout,
// especially on phones where the chip lives in a wrap-row with the
// effort + permission-mode pills.
function shortOrModel(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

// ModelEffortPicker mirrors Claude Code CLI's combined picker: one chip
// summarizes "<model> · <effort>", and the popover lists both sections
// stacked with a separator. Effort options are filtered by the selected
// model's `supportedEffortLevels` (xhigh = Opus only, max = Opus only).
export function ModelEffortPicker({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  provider,
  orModels,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = modelById(modelId);
  const supportedEfforts = current?.supportedEffortLevels ?? [
    "low",
    "medium",
    "high",
  ];

  const alternatives = MODELS.filter((m) => m.id !== modelId);

  // Active OR model id for the currently-picked tier. Empty string =
  // user picked OR but didn't map this tier — chip falls back to the
  // Claude label so the user sees they're flying without a route map.
  const isOR = provider === "openrouter";
  const orForCurrent =
    isOR && current ? (orModels?.[tierFor(current.id)] ?? "") : "";

  const pickModel = (id: string) => {
    onModelChange(id);
    // Drop unsupported effort to a sensible fallback when the new
    // model can't run the current effort (e.g. switching Opus → Haiku
    // collapses xhigh/max).
    const next = modelById(id);
    if (next && !next.supportedEffortLevels.includes(effort)) {
      onEffortChange(next.supportedEffortLevels.at(-1) ?? "high");
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
              isOR
                ? "bg-violet-500/10 text-violet-700 hover:bg-violet-500/15 dark:text-violet-300"
                : "bg-muted/60 hover:bg-muted",
            )}
          />
        }
      >
        {isOR && <Router className="size-3 opacity-80" />}
        <span className="font-medium">{current?.label ?? modelId}</span>
        {!isOR && current?.badge && (
          <span className="text-muted-foreground">{current.badge}</span>
        )}
        {isOR && (
          <>
            <span className="opacity-50">→</span>
            <span className="font-mono text-[11px] opacity-90">
              {orForCurrent ? shortOrModel(orForCurrent) : "(unmapped)"}
            </span>
          </>
        )}
        <span className="text-muted-foreground">·</span>
        <span>{EFFORT_LABELS[effort]}</span>
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end" side="top">
        <div className="flex items-baseline justify-between px-3 pt-3 pb-1.5">
          <div className="text-xs text-muted-foreground">Models</div>
          {isOR && (
            <div className="text-[10px] text-violet-600 dark:text-violet-400">
              OpenRouter
            </div>
          )}
        </div>
        <ul className="px-1.5 pb-1.5">
          {current && (
            <ModelRow
              model={current}
              selected
              isDefault={current.id === DEFAULT_MODEL_ID}
              orMapping={isOR ? orModels?.[tierFor(current.id)] : undefined}
              onPick={pickModel}
            />
          )}
        </ul>
        <div className="mx-3 border-t" />
        <ul className="px-1.5 pt-1.5 pb-1.5">
          {alternatives.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              selected={false}
              isDefault={m.id === DEFAULT_MODEL_ID}
              orMapping={isOR ? orModels?.[tierFor(m.id)] : undefined}
              onPick={pickModel}
            />
          ))}
        </ul>
        <div className="mx-3 border-t" />
        <div className="px-3 pt-3 pb-1.5">
          <div className="text-xs text-muted-foreground">Effort</div>
        </div>
        <ul className="px-1.5 pb-2">
          {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => {
            const enabled = supportedEfforts.includes(e);
            const selected = e === effort;
            return (
              <li key={e}>
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => {
                    onEffortChange(e);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <span className="flex-1">{EFFORT_LABELS[e]}</span>
                  {selected && <Check className="size-3.5 shrink-0" />}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  model,
  selected,
  isDefault,
  orMapping,
  onPick,
}: {
  model: ModelInfo;
  selected: boolean;
  isDefault: boolean;
  // Set when this row is rendered while provider=openrouter — drives
  // the second-line preview "→ openai/gpt-oss-120b". Undefined for
  // native Anthropic mode (no preview row).
  orMapping?: string;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(model.id)}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">{model.label}</span>
            {model.badge && (
              <span className="text-xs text-muted-foreground">
                {model.badge}
              </span>
            )}
            {isDefault && (
              <span className="text-xs text-muted-foreground">Default</span>
            )}
          </span>
          {orMapping !== undefined && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-violet-600 dark:text-violet-400">
              → {orMapping || "(unmapped — OR will reject)"}
            </span>
          )}
        </span>
        <span className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
          {model.contextWindow >= 1_000_000
            ? "1M"
            : `${Math.round(model.contextWindow / 1000)}K`}
        </span>
        {selected && <Check className="mt-0.5 size-3.5 shrink-0" />}
      </button>
    </li>
  );
}
