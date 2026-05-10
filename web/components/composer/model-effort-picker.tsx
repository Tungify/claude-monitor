"use client";

import { useState } from "react";
import { Check, ChevronDown, Router, Settings2 } from "lucide-react";
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
  // When provider === "openrouter", the chip and the rows render the
  // user's saved OR favorites (full ids like "openai/gpt-oss-120b")
  // and selecting one passes that id straight back through
  // onModelChange. Empty list means the user hasn't saved any
  // favorites yet — we surface a one-click hint to open the OR
  // settings dialog.
  provider?: SessionProvider;
  orModels?: string[];
  // Optional callback for the "open OR settings" link inside the
  // popover. Wired by the home composer (which owns the dialog state)
  // and skipped by the chat-panel — there the user can still open the
  // dialog from the sidebar.
  onConfigureOpenRouter?: () => void;
}

// Trims `provider/model-name` → `model-name` for compact display in
// the chip. Long ids would otherwise blow out the toolbar layout,
// especially on phones where the chip lives in a wrap-row with the
// effort + permission-mode pills.
function shortOrModel(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

// Effort levels supported when routing through OR. We don't know what
// the third-party model can actually do, so we keep the lower three
// universally enabled and gate xhigh/max behind ids that look like
// Claude Opus (the only family confirmed to honor those levels). This
// is just UX hinting — the model id is what the request actually
// carries.
const OR_BASE_EFFORTS: Effort[] = ["low", "medium", "high"];
function effortsForOr(modelId?: string): Effort[] {
  if (!modelId) return OR_BASE_EFFORTS;
  if (/opus/i.test(modelId)) return ["low", "medium", "high", "xhigh", "max"];
  return OR_BASE_EFFORTS;
}

// ModelEffortPicker mirrors Claude Code CLI's combined picker: one chip
// summarizes "<model> · <effort>", and the popover lists both sections
// stacked with a separator. For the native provider the model list is
// the static MODELS lineup; for OpenRouter it's the user's saved
// favorites — picking one calls onModelChange with the OR id directly,
// which the SDK forwards as the request's `model` field.
export function ModelEffortPicker({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  provider,
  orModels,
  onConfigureOpenRouter,
}: Props) {
  const [open, setOpen] = useState(false);
  const isOR = provider === "openrouter";
  const current = modelById(modelId);
  // Effort options change shape between providers. Native uses the
  // model's declared list; OR uses our heuristic above so the popover
  // doesn't dangle disabled rows the user can't possibly enable.
  const supportedEfforts = isOR
    ? effortsForOr(modelId)
    : (current?.supportedEffortLevels ?? ["low", "medium", "high"]);

  const alternatives = MODELS.filter((m) => m.id !== modelId);

  // For OR, `modelId` IS the OR id (we set it that way at session
  // spawn). When it isn't yet — e.g. fresh home composer where the
  // initial model is the default Anthropic id — fall back to the
  // first favorite or "(unset)" so the chip never reads as a Claude
  // tier label that wouldn't actually apply.
  const orCurrent = isOR
    ? (orModels?.includes(modelId) ? modelId : orModels?.[0])
    : undefined;

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

  // For OR the supportedEfforts list is provider-derived (no
  // ModelInfo lookup), so falling effort back uses that list directly.
  const pickOrModel = (id: string) => {
    onModelChange(id);
    const efforts = effortsForOr(id);
    if (!efforts.includes(effort)) {
      onEffortChange(efforts.at(-1) ?? "high");
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
        {isOR ? (
          <span className="font-mono text-[11px]">
            {orCurrent ? shortOrModel(orCurrent) : "(no models saved)"}
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
          {isOR && onConfigureOpenRouter && (
            <button
              type="button"
              onClick={() => {
                onConfigureOpenRouter();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 text-[10px] text-violet-600 hover:underline dark:text-violet-400"
            >
              <Settings2 className="size-3" />
              Manage
            </button>
          )}
        </div>
        {isOR ? (
          orModels && orModels.length > 0 ? (
            <ul className="px-1.5 pb-1.5">
              {orModels.map((id) => (
                <OrModelRow
                  key={id}
                  modelId={id}
                  selected={id === orCurrent}
                  onPick={() => pickOrModel(id)}
                />
              ))}
            </ul>
          ) : (
            <div className="px-3 pb-3 text-[11px] text-muted-foreground">
              No saved models.{" "}
              {onConfigureOpenRouter ? (
                <button
                  type="button"
                  onClick={() => {
                    onConfigureOpenRouter();
                    setOpen(false);
                  }}
                  className="text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
                >
                  Open OpenRouter settings
                </button>
              ) : (
                "Open OpenRouter settings from the sidebar to add some."
              )}
            </div>
          )
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

// OrModelRow renders one of the user's saved OR favorites. The OR id is
// the headline (the user picked it directly from the catalog so they
// recognize the full string); we split off the vendor prefix into
// muted-foreground so a long id stays readable.
function OrModelRow({
  modelId,
  selected,
  onPick,
}: {
  modelId: string;
  selected: boolean;
  onPick: () => void;
}) {
  const slash = modelId.indexOf("/");
  const vendor = slash >= 0 ? modelId.slice(0, slash) : "";
  const name = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
          selected && "bg-violet-500/5",
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {vendor && (
            <span className="text-muted-foreground">{vendor}/</span>
          )}
          <span className="font-medium">{name}</span>
        </span>
        {selected && <Check className="size-3.5 shrink-0" />}
      </button>
    </li>
  );
}
