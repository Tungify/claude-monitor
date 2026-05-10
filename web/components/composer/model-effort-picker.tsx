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
  // Active provider for THIS picker mount. Drives the chip styling
  // (violet for OR, neutral for native) and what counts as "current"
  // in the popover. Both sections always render — the chat panel's
  // onModelChange handler triggers a respawn when the user crosses
  // provider lines, so we don't lock the picker to one side.
  //
  // undefined → home mode (no session yet); the parent infers
  // provider from the chosen id at session-create time.
  provider?: SessionProvider;
  // Saved OR favorites. Required for home mode (otherwise the OR
  // section is empty), and consulted in session mode when the
  // session is OR-routed. Empty list is fine — we surface a one-
  // click hint to open the OR settings dialog.
  orModels?: string[];
  // Optional callback for the "open OR settings" link inside the
  // popover. Wired by the home composer (which owns the dialog
  // state). Skip in session-mode contexts where the user can edit
  // OR settings via the sidebar instead.
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

// providerForModel infers which provider an id targets so the chip
// styling and effort filtering Just Work without a separate provider
// state. OR ids are vendor-prefixed ("openai/gpt-oss-120b"); native
// Anthropic ids are flat ("claude-opus-4-7").
function providerForModel(
  id: string,
  orModels: string[],
): SessionProvider {
  if (orModels.includes(id)) return "openrouter";
  if (id.includes("/")) return "openrouter";
  return "anthropic";
}

// Effort levels supported when routing through OR. We don't know what
// the third-party model can actually do, so we keep the lower three
// universally enabled and gate xhigh/max behind ids that look like
// Claude Opus (the only family confirmed to honor those levels).
const OR_BASE_EFFORTS: Effort[] = ["low", "medium", "high"];
function effortsForOr(modelId?: string): Effort[] {
  if (!modelId) return OR_BASE_EFFORTS;
  if (/opus/i.test(modelId)) return ["low", "medium", "high", "xhigh", "max"];
  return OR_BASE_EFFORTS;
}

// ModelEffortPicker is the single chip the user clicks to switch
// model + effort. The popover splits into sections by source:
//   - Anthropic native (always available unless provider locks to OR)
//   - OpenRouter favorites (when configured)
//   - Effort levels (filtered by what the picked model supports)
//
// In session mode (provider supplied), only the matching section
// renders — switching providers mid-chat would break since
// BASE_URL/AUTH_TOKEN env vars are locked at spawn time. In home mode
// (provider undefined), both sections render so the user picks any
// model in one click; the home view infers provider from the picked
// id when it spawns the session.
export function ModelEffortPicker({
  modelId,
  effort,
  onModelChange,
  onEffortChange,
  provider,
  orModels = [],
  onConfigureOpenRouter,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = modelById(modelId);
  // Effective provider for the chip + effort filter. In session mode
  // it's whatever the parent told us; in home mode we infer from the
  // picked id so the chip recolors correctly when the user switches
  // categories.
  const effectiveProvider =
    provider ?? providerForModel(modelId, orModels);
  const isOR = effectiveProvider === "openrouter";

  // Both sections render in every mode. Chat sessions started against
  // Anthropic can switch to an OR favorite (and vice versa) — the
  // composer's onModelChange handler asks the server for a respawn
  // when that happens. Home mode also shows both so the new session
  // can spawn against either provider.
  const showAnthropic = true;
  const showOR = true;

  // Effort filter follows the active model: native looks up
  // ModelInfo.supportedEffortLevels; OR uses our heuristic. We don't
  // intersect across both sections — the picker offers all of one
  // set, since the user has already committed to the picked model.
  const supportedEfforts = isOR
    ? effortsForOr(modelId)
    : (current?.supportedEffortLevels ?? ["low", "medium", "high"]);

  const alternatives = MODELS.filter((m) => m.id !== modelId);

  // The displayed OR id in the chip — only meaningful when the picked
  // model actually IS an OR id (or routes through OR). We never
  // rewrite to a tier label.
  const orChipLabel = isOR
    ? (orModels.includes(modelId) ? modelId : modelId)
    : "";

  const pickNative = (id: string) => {
    onModelChange(id);
    const next = modelById(id);
    if (next && !next.supportedEffortLevels.includes(effort)) {
      onEffortChange(next.supportedEffortLevels.at(-1) ?? "high");
    }
    setOpen(false);
  };

  const pickOr = (id: string) => {
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
            {orChipLabel ? shortOrModel(orChipLabel) : "(no models saved)"}
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
      <PopoverContent className="w-80 p-0" align="end" side="top">
        {showAnthropic && (
          <>
            <div className="px-3 pt-3 pb-1.5 text-xs text-muted-foreground">
              Anthropic
            </div>
            <ul className="px-1.5 pb-1.5">
              {current && current.id === modelId && !isOR && (
                <ModelRow
                  model={current}
                  selected
                  isDefault={current.id === DEFAULT_MODEL_ID}
                  onPick={pickNative}
                />
              )}
              {alternatives
                .filter((m) => isOR || m.id !== modelId)
                .map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={!isOR && m.id === modelId}
                    isDefault={m.id === DEFAULT_MODEL_ID}
                    onPick={pickNative}
                  />
                ))}
            </ul>
          </>
        )}

        {showOR && (
          <>
            {showAnthropic && <div className="mx-3 border-t" />}
            <div className="flex items-baseline justify-between px-3 pt-3 pb-1.5">
              <div className="text-xs text-muted-foreground">
                OpenRouter favorites
              </div>
              {onConfigureOpenRouter && (
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
            {orModels.length > 0 ? (
              <ul className="px-1.5 pb-1.5">
                {orModels.map((id) => (
                  <OrModelRow
                    key={id}
                    modelId={id}
                    selected={isOR && id === modelId}
                    onPick={() => pickOr(id)}
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
                    Add one
                  </button>
                ) : (
                  "Open OpenRouter settings from the sidebar to add some."
                )}
              </div>
            )}
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
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
          selected && "bg-muted",
        )}
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
