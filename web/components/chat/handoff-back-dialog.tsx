"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SessionProvider } from "@/lib/chat-types";
import { modelById } from "@/lib/models";

// HandoffBackDialog walks the user through the codex → claude reverse
// handoff. Symmetric to HandoffDialog but simpler: the destination
// account is already pinned to the session's original claude slot
// (we don't re-pick) and the model was selected when the user clicked
// a claude row in the composer picker. All this dialog does is
// confirm + fire the /handoff/back POST.

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  // Required: the target claude (or OR) model id picked in the composer.
  targetModel: string;
  // Defaults to "anthropic" when omitted. "openrouter" routes through
  // the saved OR config so the resumed session uses ANTHROPIC_BASE_URL
  // pointed at openrouter.ai.
  targetProvider?: SessionProvider;
  // Source codex account label, cosmetic. Shown so the user knows what
  // they're stepping away from.
  fromAccountLabel?: string;
  fromCodexModel?: string;
}

export function HandoffBackDialog({
  open,
  onOpenChange,
  sessionId,
  targetModel,
  targetProvider = "anthropic",
  fromAccountLabel,
  fromCodexModel,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setError(null);
      setSubmitting(false);
    });
  }, [open]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${sessionId}/handoff/back`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          provider: targetProvider,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, targetModel, targetProvider, onOpenChange]);

  const targetLabel = modelById(targetModel)?.label ?? targetModel;
  const targetProviderLabel =
    targetProvider === "openrouter" ? "openrouter" : "anthropic";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            Hand back to Claude
            <ArrowLeft className="size-4 text-muted-foreground" />
            <Badge
              variant="outline"
              className="border-indigo-500/40 bg-indigo-500/10 text-[10px] text-indigo-700 dark:text-indigo-300"
            >
              {targetProviderLabel} · {targetLabel}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Codex will write a self-contained{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              &lt;handoff-summary&gt;
            </code>{" "}
            describing what it worked on, then control returns to Claude
            on the same session. Claude resumes with that summary as its
            kickoff context — its on-disk transcript skips the codex
            segment, so the brief is the only handover it sees.
            {fromAccountLabel || fromCodexModel ? (
              <>
                {" "}
                You&apos;ll step away from{" "}
                <span className="font-medium">
                  {[fromAccountLabel, fromCodexModel].filter(Boolean).join(" · ")}
                </span>
                .
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-3 animate-spin" />
                Driving summary turn…
              </>
            ) : (
              <>
                <ArrowLeft className="mr-1 size-3" />
                Hand back
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
