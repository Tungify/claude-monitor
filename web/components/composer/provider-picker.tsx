"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Cloud, Router } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { SessionProvider } from "@/lib/chat-types";

interface ProviderStatus {
  configured: boolean;
  has_key: boolean;
}

interface Props {
  provider: SessionProvider;
  onChange: (p: SessionProvider) => void;
  // Opens the OpenRouter settings dialog. Wired from the parent so the
  // dialog state lives next to the AccountChip's other modals — picking
  // OR with no key set then surfaces the right place to fix it.
  onConfigureOpenRouter: () => void;
}

// ProviderPicker lets the home composer flip a new chat between native
// Anthropic auth (whatever account is active in claude-monitor) and
// OpenRouter (using the global OR config). Closed = pill that names
// the active provider; open = two rows with brief context.
//
// Disabled state for the OR row when the user hasn't saved a key yet:
// the row is still clickable but routes to the OpenRouter dialog
// instead of flipping the provider, so they can't pick a broken
// route by mistake.
export function ProviderPicker({
  provider,
  onChange,
  onConfigureOpenRouter,
}: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);

  // Refresh status every time the picker opens. Cheap GET — keeps the
  // pill honest after the user saves an API key in another tab.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/openrouter");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ProviderStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // Silent — the row falls back to "configure" prompt and
        // surfaces the actual error in the dialog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const orReady = status?.configured && status.has_key;
  const isOR = provider === "openrouter";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
              isOR
                ? "bg-violet-500/15 text-violet-700 hover:bg-violet-500/20 dark:text-violet-300"
                : "bg-muted/60 hover:bg-muted",
            )}
          />
        }
      >
        {isOR ? (
          <Router className="size-3.5" />
        ) : (
          <Cloud className="size-3.5" />
        )}
        <span>{isOR ? "OpenRouter" : "Anthropic"}</span>
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1.5" align="end" side="top">
        <Row
          icon={<Cloud className="size-4" />}
          label="Anthropic native"
          hint="Active claude-monitor account · auto swaps on quota"
          selected={provider === "anthropic"}
          onClick={() => {
            onChange("anthropic");
            setOpen(false);
          }}
        />
        <Row
          icon={<Router className="size-4" />}
          label="OpenRouter"
          hint={
            orReady
              ? "Routed through OR · model mapping in settings"
              : "Not configured — opens settings to add an API key"
          }
          selected={provider === "openrouter"}
          onClick={() => {
            if (!orReady) {
              onConfigureOpenRouter();
              setOpen(false);
              return;
            }
            onChange("openrouter");
            setOpen(false);
          }}
          accent="violet"
        />
        <button
          type="button"
          onClick={() => {
            onConfigureOpenRouter();
            setOpen(false);
          }}
          className="mt-1 block w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted"
        >
          Manage OpenRouter settings…
        </button>
      </PopoverContent>
    </Popover>
  );
}

function Row({
  icon,
  label,
  hint,
  selected,
  onClick,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
  accent?: "violet";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted",
        selected && accent === "violet" && "bg-violet-500/10",
        selected && !accent && "bg-muted",
      )}
    >
      <span
        className={cn(
          "mt-0.5",
          accent === "violet"
            ? "text-violet-600 dark:text-violet-400"
            : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {hint}
        </span>
      </span>
      {selected && <Check className="mt-1 size-3.5 shrink-0" />}
    </button>
  );
}
