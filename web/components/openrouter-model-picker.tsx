"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface CatalogModel {
  id: string;
  name: string;
  context_length: number;
  prompt_price?: string;
  completion_price?: string;
  description?: string;
  vendor: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Currently-selected id for highlight / "selected" dot. Optional —
  // the picker is also used for "add a new favorite" where there's no
  // current selection to compare against.
  currentId?: string;
  // Header title + description. Defaults handle the standalone "browse
  // and add a favorite" flow; callers that mount this for a different
  // purpose (e.g. "switch active model") can override both.
  title?: string;
  description?: string;
  onPick: (id: string) => void;
}

// Top vendors get pinned filter chips for one-click narrowing. Order
// here matches the lineup users seem to reach for — Anthropic / OpenAI
// first, the rest alphabetical. "All" is rendered as the leading row
// in the picker itself; chips below mirror it.
const VENDOR_CHIPS = [
  "anthropic",
  "openai",
  "google",
  "meta-llama",
  "qwen",
  "deepseek",
  "mistralai",
  "x-ai",
];

// OpenRouterModelPicker is a searchable list of every model on OR.
// It's shown when the user clicks "Pick" next to a tier slot in the
// settings dialog. Single-select: a click fires onPick with the OR
// id and closes the modal.
export function OpenRouterModelPicker({
  open,
  onOpenChange,
  currentId,
  title = "Pick an OpenRouter model",
  description = "Anything you pick will be sent to OpenRouter for this session.",
  onPick,
}: Props) {
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch lazily when the dialog first opens; server-side has its own
  // 5min cache so subsequent opens are essentially free.
  useEffect(() => {
    if (!open || models !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/openrouter/catalog");
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { models: CatalogModel[] };
        if (!cancelled) setModels(data.models);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, models]);

  // Autofocus the search input when the dialog mounts so the user can
  // start typing immediately. setTimeout sidesteps a race with the
  // Dialog's own focus management.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (vendorFilter && m.vendor !== vendorFilter) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [models, query, vendorFilter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-2xl flex-col gap-3 overflow-hidden p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-4">
        <DialogHeader>
          <DialogTitle className="pr-8">{title}</DialogTitle>
          <DialogDescription className="pr-8">{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search id, name, description…"
              className="w-full rounded border bg-background py-1.5 pr-2 pl-7 text-sm"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <VendorChip
              label="All"
              active={vendorFilter === ""}
              onClick={() => setVendorFilter("")}
            />
            {VENDOR_CHIPS.map((v) => (
              <VendorChip
                key={v}
                label={v}
                active={vendorFilter === v}
                onClick={() => setVendorFilter(vendorFilter === v ? "" : v)}
              />
            ))}
          </div>
        </div>

        <div className="-mx-1 flex-1 overflow-y-auto">
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              Failed to load: {error}
            </div>
          )}
          {!error && models === null && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading catalog…
            </div>
          )}
          {!error && models !== null && filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No matches.
            </div>
          )}
          {!error && filtered.length > 0 && (
            <ul className="space-y-0.5">
              {filtered.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === currentId}
                  onPick={() => {
                    onPick(m.id);
                    onOpenChange(false);
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        {models && (
          <div className="text-[10px] text-muted-foreground">
            {filtered.length} of {models.length} models
            {vendorFilter ? ` · vendor: ${vendorFilter}` : ""}
            {query ? ` · "${query}"` : ""}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VendorChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-mono transition-colors",
        active
          ? "border-violet-500/60 bg-violet-500/15 text-violet-700 dark:text-violet-300"
          : "border-border text-muted-foreground hover:bg-muted",
      )}
    >
      {label}
    </button>
  );
}

function ModelRow({
  model,
  selected,
  onPick,
}: {
  model: CatalogModel;
  selected: boolean;
  onPick: () => void;
}) {
  const ctx =
    model.context_length >= 1_000_000
      ? `${(model.context_length / 1_000_000).toFixed(1)}M`
      : model.context_length >= 1000
        ? `${Math.round(model.context_length / 1000)}K`
        : model.context_length
          ? String(model.context_length)
          : "—";
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex w-full items-start gap-3 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-muted",
          selected && "border-violet-500/40 bg-violet-500/5",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {model.name}
          </span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {model.id}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10px] tabular-nums text-muted-foreground">
          <span>{ctx}</span>
          {model.prompt_price && model.prompt_price !== "0" && (
            <span>${formatPrice(model.prompt_price)}/M in</span>
          )}
        </span>
        {selected && <Check className="mt-1 size-3.5 shrink-0 text-violet-600" />}
      </button>
    </li>
  );
}

// OR returns per-token prices as strings like "0.000003" (USD per
// token). Multiply by 1M to get the more familiar "$3 / M tokens"
// figure used in their docs and the Anthropic console.
function formatPrice(perToken: string): string {
  const n = Number(perToken);
  if (!Number.isFinite(n)) return perToken;
  const perM = n * 1_000_000;
  if (perM === 0) return "0";
  if (perM < 0.1) return perM.toFixed(3);
  if (perM < 10) return perM.toFixed(2);
  return perM.toFixed(1);
}
