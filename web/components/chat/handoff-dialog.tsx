"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, ShieldAlert } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// HandoffDialog walks the user through the claude→codex mid-session
// switch. We deliberately keep the flow blunt: pick a codex slot,
// confirm, fire. The actual summary turn is driven server-side
// against the live claude session — the dialog doesn't block on it
// (it shows "summary turn in progress" feedback via the chat
// transcript once it closes).
//
// MVP scope: target == codex only. The picker preselects the slot's
// most recent default model (read from ~/.codex*/models_cache.json
// via /api/codex). An inline override input still lets the user type
// any slug their plan supports.

const DEFAULT_CODEX_MODEL = "gpt-5.5";

interface CodexAccountModel {
  slug: string;
  display_name: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: string[];
}

interface CodexSlot {
  config_dir: string;
  name: string;
  email?: string;
  plan_type?: string;
  models?: CodexAccountModel[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Mode toggles between the two flows that share this UI:
  //   - "handoff" (default): mid-session claude→codex switch. Requires
  //     sessionId. Submits to /api/chat/<id>/handoff.
  //   - "start": brand-new codex session from the home composer. No
  //     sessionId. On submit we hand the picked slot+model up to the
  //     parent via onConfirmStart and let it drive session creation
  //     + first-message dispatch.
  mode?: "handoff" | "start";
  // Required when mode="handoff", ignored when mode="start".
  sessionId?: string;
  // Surface the current session's account label so the user has
  // context for what they're handing off FROM. Cosmetic only — only
  // shown in handoff mode.
  fromAccountLabel?: string;
  // Optional preselected model id, used when the user opened the
  // dialog via the composer picker (which already named the model).
  // Falls back to DEFAULT_CODEX_MODEL when undefined.
  initialModel?: string;
  // Required in start mode. Fires AFTER the user picks slot + model
  // and clicks Confirm. Returning a rejected promise keeps the dialog
  // open and surfaces the error — the parent typically does the
  // /api/chat POST + redirect inside this callback.
  onConfirmStart?: (picked: {
    codex_config_dir: string;
    codex_account_name?: string;
    codex_model: string;
  }) => Promise<void>;
}

export function HandoffDialog({
  open,
  onOpenChange,
  mode = "handoff",
  sessionId,
  fromAccountLabel,
  initialModel,
  onConfirmStart,
}: Props) {
  const [slots, setSlots] = useState<CodexSlot[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [model, setModel] = useState(initialModel || DEFAULT_CODEX_MODEL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch codex slots once the dialog opens. We refetch every time it
  // opens (the user may have run `codex login` between visits) — an
  // extra GET is cheap and avoids a stale empty state. The synchronous
  // resets are deferred via queueMicrotask so the effect body itself
  // doesn't call setState — matches the codebase's pattern for
  // "reset-on-trigger" effects that the lint rule otherwise rejects.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setError(null);
      setSlots(null);
      setSelected(undefined);
      // Re-sync model when the trigger preselected one. Each open
      // re-applies initialModel so a second open with a different
      // preselect doesn't carry over the previous edit.
      setModel(initialModel || DEFAULT_CODEX_MODEL);
    });
    fetch("/api/codex")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const list = (j.slots ?? []) as CodexSlot[];
        setSlots(list);
        if (list.length > 0) {
          const first = list[0];
          setSelected(first.config_dir);
          // Snap the model to the slot's live catalog when the caller
          // didn't preselect. Picks the slug matching DEFAULT_CODEX_MODEL
          // if present, else the first listed model. This avoids the
          // "user picks slot → submits → 400 because hardcoded default
          // isn't in their plan" failure mode.
          if (!initialModel && first.models && first.models.length > 0) {
            const preferred =
              first.models.find((m) => m.slug === DEFAULT_CODEX_MODEL) ??
              first.models[0];
            setModel(preferred.slug);
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setSlots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialModel]);

  // When the user switches slot mid-dialog, re-snap the model to that
  // slot's catalog so we don't submit a slug the new account doesn't
  // support. Skip if the user has typed a custom slug that already
  // matches one of the new slot's models (preserves the choice).
  useEffect(() => {
    if (!selected || !slots) return;
    const slot = slots.find((s) => s.config_dir === selected);
    const list = slot?.models ?? [];
    if (list.length === 0) return;
    if (list.some((m) => m.slug === model)) return;
    queueMicrotask(() => {
      const preferred =
        list.find((m) => m.slug === DEFAULT_CODEX_MODEL) ?? list[0];
      setModel(preferred.slug);
    });
  }, [selected, slots, model]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const slot = slots?.find((s) => s.config_dir === selected);
      const finalModel = model.trim() || DEFAULT_CODEX_MODEL;
      if (mode === "start") {
        if (!onConfirmStart) {
          throw new Error("start mode requires onConfirmStart");
        }
        await onConfirmStart({
          codex_config_dir: selected,
          codex_account_name: slot?.name,
          codex_model: finalModel,
        });
        onOpenChange(false);
        return;
      }
      if (!sessionId) {
        throw new Error("handoff mode requires sessionId");
      }
      const res = await fetch(`/api/chat/${sessionId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codex_config_dir: selected,
          codex_account_name: slot?.name,
          codex_model: finalModel,
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
  }, [mode, selected, model, sessionId, slots, onOpenChange, onConfirmStart]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {mode === "start" ? "Start with Codex" : "Hand off to Codex"}
            <ArrowRight className="size-4 text-muted-foreground" />
            {mode === "handoff" && (
              <Badge variant="outline" className="text-[10px]">
                reversible
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {mode === "start" ? (
              <>
                The session talks directly to your ChatGPT-subscription
                Codex tokens via{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                  chatgpt.com/backend-api/codex/responses
                </code>
                . Codex runs its own tool suite (shell, apply_patch,
                file ops, MCP, web search) inside the working directory
                you picked.
              </>
            ) : (
              <>
                Claude writes a self-contained summary, then subsequent
                turns run through your ChatGPT-subscription Codex tokens
                via{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                  chatgpt.com/backend-api/codex/responses
                </code>
                . Codex drives its own tool suite (shell, apply_patch,
                file ops, MCP, web search). You can hand back to Claude
                at any time from the model picker.
                {fromAccountLabel ? (
                  <>
                    {" "}
                    You&apos;ll switch away from{" "}
                    <span className="font-medium">{fromAccountLabel}</span>.
                  </>
                ) : null}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Codex account
            </div>
            {slots === null ? (
              <div className="flex items-center gap-2 rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Reading ~/.codex* …
              </div>
            ) : slots.length === 0 ? (
              <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 size-3.5" />
                <div>
                  No authenticated codex accounts found. Run{" "}
                  <code className="rounded bg-amber-500/20 px-1 py-0.5 font-mono">
                    codex login
                  </code>{" "}
                  in a terminal, then reopen this dialog.
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {slots.map((slot) => {
                  const active = selected === slot.config_dir;
                  return (
                    <button
                      key={slot.config_dir}
                      type="button"
                      onClick={() => setSelected(slot.config_dir)}
                      className={`flex w-full items-start gap-2 rounded border px-3 py-2 text-left transition-colors ${
                        active
                          ? "border-emerald-500/60 bg-emerald-500/10"
                          : "border-border bg-background hover:bg-muted/60"
                      }`}
                    >
                      <input
                        type="radio"
                        checked={active}
                        readOnly
                        className="mt-0.5 accent-emerald-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium">
                            {slot.name}
                          </span>
                          {slot.plan_type && (
                            <Badge variant="outline" className="text-[10px]">
                              {slot.plan_type}
                            </Badge>
                          )}
                        </div>
                        {slot.email && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {slot.email}
                          </div>
                        )}
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {slot.config_dir}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {(() => {
            // The model was already chosen in the composer picker
            // (and re-syncs via the slot-snap effect when the picked
            // slug isn't in the account's live catalog). Just surface
            // the resolved id as a single read-only line so the user
            // can verify before confirming — picking is done in the
            // model chip, not here.
            const slot = slots?.find((s) => s.config_dir === selected);
            const accountModels = slot?.models ?? [];
            const match = accountModels.find((m) => m.slug === model);
            return (
              <div className="flex items-center justify-between gap-2 rounded border bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Model
                  </span>
                  <span className="font-medium">
                    {match?.display_name ?? model}
                  </span>
                  <code className="truncate font-mono text-[10px] text-muted-foreground">
                    {model}
                  </code>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  change in composer
                </span>
              </div>
            );
          })()}

          {error && (
            <div className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!selected || submitting || slots?.length === 0}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-1 size-3 animate-spin" />
                {mode === "start" ? "Starting…" : "Driving summary turn…"}
              </>
            ) : (
              <>
                <ArrowRight className="mr-1 size-3" />
                {mode === "start" ? "Start session" : "Hand off"}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
