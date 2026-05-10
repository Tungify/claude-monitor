"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Mirror of OpenRouterStatus from the server module — duplicated here
// because client code can't import "server-only" modules. Keep in sync.
interface OpenRouterStatus {
  configured: boolean;
  has_key: boolean;
  models: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Sensible defaults the user can edit. These map the binary's three
// model tiers (opus / sonnet / haiku) to OpenRouter model ids. Picked
// to be roughly equivalent capability per tier; users routing to
// non-Anthropic models on OR will rewrite these. Empty string means
// "let OR resolve from the binary's default" — usually rejected, so
// we encourage filling all three.
const PRESET_MODELS = {
  opus: "anthropic/claude-opus-4.5",
  sonnet: "anthropic/claude-sonnet-4.5",
  haiku: "anthropic/claude-haiku-4.5",
};

// OpenRouterDialog manages the global OR config: API key + per-tier
// model overrides. Saved state lives at ~/.claude-monitor/config.json
// and is consumed at session-spawn time when the user picks
// provider="openrouter" in the composer.
export function OpenRouterDialog({ open, onOpenChange }: Props) {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [opus, setOpus] = useState(PRESET_MODELS.opus);
  const [sonnet, setSonnet] = useState(PRESET_MODELS.sonnet);
  const [haiku, setHaiku] = useState(PRESET_MODELS.haiku);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Pull current state every time the dialog opens so a save in another
  // tab (or a manual edit of config.json) shows up immediately. We
  // don't subscribe to changes — this dialog is the only writer.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/openrouter");
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as OpenRouterStatus;
        if (cancelled) return;
        setStatus(data);
        // Pre-fill the tier inputs from saved values, falling back to
        // presets so a fresh setup has something to look at.
        setOpus(data.models.opus ?? PRESET_MODELS.opus);
        setSonnet(data.models.sonnet ?? PRESET_MODELS.sonnet);
        setHaiku(data.models.haiku ?? PRESET_MODELS.haiku);
        // We never echo the API key back from the server. The text
        // field stays blank when one is on file; typing replaces it.
        setApiKey("");
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
        models: { opus, sonnet, haiku },
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
      setApiKey("");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (
      !window.confirm(
        "Disconnect OpenRouter? The API key and model overrides will be erased.",
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
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Save is only allowed when either a new key is typed (covers fresh
  // setup) or one is already on file (so the user can update just the
  // model mapping). The clear button is the escape hatch for the
  // "remove everything" case.
  const canSave = apiKey.trim().length > 0 || status?.has_key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-2xl gap-3 overflow-y-auto p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:gap-4 sm:p-4">
        <DialogHeader>
          <DialogTitle className="pr-8">OpenRouter</DialogTitle>
          <DialogDescription className="pr-8">
            Route session traffic through OpenRouter to swap in any model on
            their catalog (Claude family, GPT, Gemini, Llama, …). MCP tools,
            plan flow, and permission prompts work as usual.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {status?.configured && status.has_key && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              Connected. Pick the OpenRouter provider on the home composer
              when starting a new chat to route through it.
            </div>
          )}

          <section className="space-y-1.5">
            <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              API key
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  status?.has_key
                    ? "•••••••••• (leave blank to keep saved key)"
                    : "sk-or-v1-..."
                }
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border bg-background px-2 py-1.5 pr-9 font-mono text-xs sm:py-1.5"
              />
              <button
                type="button"
                aria-label={showKey ? "Hide key" : "Show key"}
                onClick={() => setShowKey((v) => !v)}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
              >
                {showKey ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Stored locally at <code>~/.claude-monitor/config.json</code>. Get
              one at{" "}
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
          </section>

          <section className="space-y-1.5">
            <label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Model mapping
            </label>
            <p className="text-[11px] text-muted-foreground">
              Claude Code asks the API for an &quot;opus&quot;,
              &quot;sonnet&quot;, or &quot;haiku&quot; tier per request. Map
              each tier to whatever OpenRouter model id you want — try{" "}
              <code>openai/gpt-4o</code>, <code>google/gemini-2.5-pro</code>,
              <code> qwen/qwen3-coder</code>, <code>deepseek/deepseek-chat</code>,
              etc.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <TierField label="Opus tier" value={opus} onChange={setOpus} />
              <TierField
                label="Sonnet tier"
                value={sonnet}
                onChange={setSonnet}
              />
              <TierField
                label="Haiku tier"
                value={haiku}
                onChange={setHaiku}
              />
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
              {savedAt !== null && Date.now() - savedAt < 4000 && (
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
    </Dialog>
  );
}

function TierField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs sm:py-1"
      />
    </label>
  );
}
