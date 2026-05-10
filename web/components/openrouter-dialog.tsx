"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, Plus, Star, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { OpenRouterModelPicker } from "@/components/openrouter-model-picker";
import { cn } from "@/lib/utils";

// Mirror of OpenRouterStatus from the server module — duplicated here
// because client code can't import "server-only" modules. Keep in sync.
interface OpenRouterStatus {
  configured: boolean;
  has_key: boolean;
  models: string[];
  default_model?: string;
  key_error?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Sensible seed favorites the user can edit. Chosen to give a fresh
// install a quick "click and go" path without forcing the user to
// browse the catalog first. Only used when the saved config has no
// favorites yet — never overrides a user choice.
const PRESET_FAVORITES = [
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
];

// OpenRouterDialog manages the global OR config: API key + the user's
// list of favorite OR models. Saved state lives at
// ~/.claude-monitor/config.json and is consumed at session-spawn time
// when the user picks provider="openrouter" in the composer; the
// composer's model picker also pulls this list to show OR favorites
// inline so the user can switch between them in-chat the same way they
// switch between Claude Opus / Sonnet on the native provider.
export function OpenRouterDialog({ open, onOpenChange }: Props) {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Boolean rather than a timestamp: the lint rule blocks Date.now()
  // during render, and a simple flag + a clear-after-timeout effect
  // gets us the "Saved" pulse without comparing wall-clock in JSX.
  const [justSaved, setJustSaved] = useState(false);
  // Picker dialog open flag. Opening the picker mounts the catalog
  // dialog; clicking a row appends the OR id to the favorites list
  // (and sets it as default if there's no current default).
  const [pickerOpen, setPickerOpen] = useState(false);
  // When true, the API-key input renders even though one is on file.
  // Saved-key state hides the input by default (just shows "Key on
  // file · Replace") so the dialog reads "everything's set" without
  // a stray password field cluttering the layout. Reset to false on
  // every open inside the existing fetch effect (one less standalone
  // useEffect).
  const [editingKey, setEditingKey] = useState(false);

  // Auto-clear the "Saved" pulse 4s after a successful save.
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);

  // Pull current state every time the dialog opens so a save in another
  // tab (or a manual edit of config.json) shows up immediately.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setError(null);
      setEditingKey(false);
      try {
        const res = await fetch("/api/openrouter");
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as OpenRouterStatus;
        if (cancelled) return;
        setStatus(data);
        // Seed favorites from saved state, falling back to presets only
        // for a brand-new setup. Once the user has edited the list (even
        // to empty) we trust their choice.
        const seeded = data.configured ? data.models : PRESET_FAVORITES;
        setModels(seeded);
        setDefaultModel(data.default_model ?? seeded[0]);
        // We never echo the API key back from the server. The text
        // field stays blank when one is on file; typing replaces it.
        setApiKey("");
        // If the on-disk key is invalid (e.g. legacy paste of hint
        // text), force the input open immediately so the user can
        // type a clean replacement without finding the Replace button.
        if (data.key_error) setEditingKey(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        models,
        default_model: defaultModel,
      };
      // Only send api_key when the user typed one; the server treats
      // an empty string as "leave the existing key untouched".
      if (apiKey.trim().length > 0) body.api_key = apiKey.trim();
      const res = await fetch("/api/openrouter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = (await res.json()) as OpenRouterStatus;
      setStatus(data);
      setModels(data.models);
      setDefaultModel(data.default_model);
      setApiKey("");
      setEditingKey(false);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (
      !window.confirm(
        "Disconnect OpenRouter? The API key and saved models will be erased.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/openrouter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const data = (await res.json()) as OpenRouterStatus;
      setStatus(data);
      setModels([]);
      setDefaultModel(undefined);
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Adds an OR id to the favorites list. Skips dupes — the picker
  // doesn't filter against the current list, so re-clicking a saved
  // model would otherwise grow the array unbounded. First favorite
  // becomes the default automatically.
  const addModel = (id: string) => {
    setModels((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      if (!defaultModel) setDefaultModel(id);
      return next;
    });
  };

  const removeModel = (id: string) => {
    setModels((prev) => prev.filter((m) => m !== id));
    // If we just removed the default, fall back to whatever's first in
    // the remaining list. Empty → undefined; the env builder copes.
    setDefaultModel((cur) => {
      if (cur !== id) return cur;
      const remaining = models.filter((m) => m !== id);
      return remaining[0];
    });
  };

  // Save is only allowed when either a new key is typed (covers fresh
  // setup) or one is already on file (so the user can update just the
  // model list). The clear button is the escape hatch for the
  // "remove everything" case.
  const canSave = apiKey.trim().length > 0 || status?.has_key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-2xl gap-3 overflow-y-auto p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:gap-4 sm:p-4">
        <DialogHeader>
          <DialogTitle className="pr-8">OpenRouter</DialogTitle>
          <DialogDescription className="pr-8">
            Route session traffic through OpenRouter to swap in any model on
            their catalog (Claude family, GPT, Gemini, Llama, …). Add as many
            favorites as you like — they show up directly in the chat composer
            so you can switch between them mid-conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {status?.configured && status.has_key && !status.key_error && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              Connected. Pick the OpenRouter provider on the home composer
              when starting a new chat to route through it.
            </div>
          )}
          {status?.key_error && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <strong>Saved API key looks corrupted.</strong> {status.key_error}
            </div>
          )}

          <section className="space-y-1.5">
            <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              API key
            </label>
            {status?.has_key && !editingKey ? (
              <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
                <span className="font-mono tracking-widest text-muted-foreground">
                  ••••••••••••••••••
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">
                  on file
                </span>
                <button
                  type="button"
                  onClick={() => setEditingKey(true)}
                  className="ml-auto rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                >
                  Replace
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-or-v1-..."
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded border bg-background px-2 py-1.5 pr-16 font-mono text-xs sm:py-1.5"
                  />
                  <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={showKey ? "Hide key" : "Show key"}
                      onClick={() => setShowKey((v) => !v)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                    >
                      {showKey ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </button>
                    {status?.has_key && (
                      <button
                        type="button"
                        aria-label="Cancel replace"
                        onClick={() => {
                          setEditingKey(false);
                          setApiKey("");
                        }}
                        className="rounded p-1 text-muted-foreground hover:bg-muted"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Stored locally at{" "}
                  <code>~/.claude-monitor/config.json</code>. Get one at{" "}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-foreground underline-offset-4 hover:underline"
                  >
                    openrouter.ai/keys
                    <ExternalLink className="size-3" />
                  </a>
                  .
                </p>
              </>
            )}
          </section>

          <section className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Saved models
              </label>
              <span className="text-[11px] text-muted-foreground">
                {models.length} saved · star marks the session default
              </span>
            </div>
            <div className="space-y-1.5">
              {models.length === 0 ? (
                <div className="rounded-md border border-dashed bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                  No models saved yet. Click{" "}
                  <span className="font-medium">Add model</span> to browse the
                  catalog.
                </div>
              ) : (
                models.map((id) => (
                  <FavoriteRow
                    key={id}
                    modelId={id}
                    isDefault={id === defaultModel}
                    onPickDefault={() => setDefaultModel(id)}
                    onRemove={() => removeModel(id)}
                  />
                ))
              )}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-500/15 dark:text-violet-300"
              >
                <Plus className="size-3.5" />
                Add model
              </button>
            </div>
          </section>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={busy || !status?.configured}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Disconnect
            </Button>
            <div className="flex items-center gap-2">
              {justSaved && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  Saved
                </span>
              )}
              <Button
                size="sm"
                onClick={onSave}
                disabled={busy || !canSave}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Catalog picker. Mounted alongside the main dialog so picking
          a model can append to the favorites list while the parent
          stays open underneath. */}
      <OpenRouterModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        currentId={defaultModel}
        title="Add an OpenRouter model"
        description="Anything you pick gets saved to your favorites and shows up in the chat composer's model picker."
        onPick={(id) => addModel(id)}
      />
    </Dialog>
  );
}

// FavoriteRow renders one entry in the favorites list. Star toggles the
// default; X removes the row. The OR id is the headline (mono); we
// don't bother showing the human-friendly label because the catalog's
// `name` field isn't persisted with the favorites — the OR id is what
// the user actually picked and recognizes.
function FavoriteRow({
  modelId,
  isDefault,
  onPickDefault,
  onRemove,
}: {
  modelId: string;
  isDefault: boolean;
  onPickDefault: () => void;
  onRemove: () => void;
}) {
  const slash = modelId.indexOf("/");
  const vendor = slash >= 0 ? modelId.slice(0, slash) : "";
  const name = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border bg-background px-2 py-1.5",
        isDefault && "border-violet-500/40 bg-violet-500/5",
      )}
    >
      <button
        type="button"
        onClick={onPickDefault}
        aria-label={isDefault ? "Default model" : "Make default"}
        title={isDefault ? "Default for new sessions" : "Make default"}
        className={cn(
          "rounded p-1 transition-colors",
          isDefault
            ? "text-violet-600 dark:text-violet-300"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Star
          className={cn("size-3.5", isDefault && "fill-current")}
        />
      </button>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {vendor && (
          <span className="text-muted-foreground">{vendor}/</span>
        )}
        <span className="font-medium">{name}</span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${modelId}`}
        onClick={onRemove}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
