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

// Canonical Claude id that the binary will actually request when the
// user picks an OR model whose mapping lives at the given tier. The
// SDK still needs a tier hint to know which env-var override to look
// at — we always pass the latest 4.7/4.6/4.5 in that family so effort
// levels resolve sensibly (Opus tier → xhigh / max available).
const TIER_ANCHOR: Record<"opus" | "sonnet" | "haiku", string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

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

  const isOR = provider === "openrouter";
  // OR mode treats "the picked model" as whichever tier mapping the
  // current modelId routes through. The chip and popover render OR
  // ids directly — the user picked openai/gpt-oss-120b, that's what
  // they should see, not the Anthropic label that happens to share a
  // tier with it.
  const currentTier = current ? tierFor(current.id) : "opus";
  const orForCurrent = isOR ? (orModels?.[currentTier] ?? "") : "";
  // Build the list of OR rows from the user's saved mapping. Tiers
  // with no mapping still render so the user knows the slot exists
  // (clicking offers to open the OR settings dialog instead, but
  // that's a future polish — for now the chip shows "(unmapped)").
  const orRows: Array<{
    tier: "opus" | "sonnet" | "haiku";
    label: string;
    modelId?: string;
  }> = [
    { tier: "opus", label: "Opus", modelId: orModels?.opus },
    { tier: "sonnet", label: "Sonnet", modelId: orModels?.sonnet },
    { tier: "haiku", label: "Haiku", modelId: orModels?.haiku },
  ];

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

  const pickOrTier = (tier: "opus" | "sonnet" | "haiku") => {
    pickModel(TIER_ANCHOR[tier]);
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
        {isOR ? (
          <span className="font-mono text-[11px]">
            {orForCurrent ? shortOrModel(orForCurrent) : "(unmapped)"}
          </span>
        ) : (
          <>
            <span className="font-medium">{current?.label ?? modelId}</span>
            {current?.badge && (
              <span className="text-muted-foreground">{current.badge}</span>
            )}
          </>
        )}
        <span className="text-muted-foreground">·</span>
        <span>{EFFORT_LABELS[effort]}</span>
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end" side="top">
        <div className="flex items-baseline justify-between px-3 pt-3 pb-1.5">
          <div className="text-xs text-muted-foreground">
            {isOR ? "OpenRouter models" : "Models"}
          </div>
          {isOR && (
            <div className="text-[10px] text-violet-600 dark:text-violet-400">
              via tier
            </div>
          )}
        </div>
        {isOR ? (
          <ul className="px-1.5 pb-1.5">
            {orRows.map((row) => (
              <OrModelRow
                key={row.tier}
                tier={row.tier}
                tierLabel={row.label}
                modelId={row.modelId}
                selected={row.tier === currentTier}
                onPick={() => pickOrTier(row.tier)}
              />
            ))}
          </ul>
        ) : (
          <>
            <ul className="px-1.5 pb-1.5">
              {current && (
                <ModelRow
                  model={current}
                  selected
                  isDefault={current.id === DEFAULT_MODEL_ID}
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
                  onPick={pickModel}
                />
              ))}
            </ul>
          </>
        )}
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
  onPick,
}: {
  model: ModelInfo;
  selected: boolean;
  isDefault: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(model.id)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
      >
        <span className="text-sm font-medium">{model.label}</span>
        {model.badge && (
          <span className="text-xs text-muted-foreground">{model.badge}</span>
        )}
        {isDefault && (
          <span className="text-xs text-muted-foreground">Default</span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
          {model.contextWindow >= 1_000_000
            ? "1M"
            : `${Math.round(model.contextWindow / 1000)}K`}
        </span>
        {selected && <Check className="size-3.5 shrink-0" />}
      </button>
    </li>
  );
}

// OrModelRow renders a saved OR mapping. The OR id is the headline —
// users care about which model is actually answering, not the
// Anthropic tier name underneath. The tier still shows in muted text
// because it's load-bearing for effort levels (Opus tier is the only
// one that supports xhigh / max).
function OrModelRow({
  tier,
  tierLabel,
  modelId,
  selected,
  onPick,
}: {
  tier: "opus" | "sonnet" | "haiku";
  tierLabel: string;
  modelId?: string;
  selected: boolean;
  onPick: () => void;
}) {
  const unmapped = !modelId;
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        disabled={unmapped}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {unmapped ? (
              <span className="text-muted-foreground italic">
                {tierLabel} tier · unmapped
              </span>
            ) : (
              shortOrModel(modelId)
            )}
          </span>
          {!unmapped && (
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {modelId}
            </span>
          )}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground uppercase">
          {tier}
        </span>
        {selected && !unmapped && (
          <Check className="size-3.5 shrink-0" />
        )}
      </button>
    </li>
  );
}
