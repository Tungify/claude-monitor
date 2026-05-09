"use client";

import { useState } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ChevronDown,
  Hourglass,
  Pencil,
  Trash2,
  X,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface QueuedMessage {
  // SDK uuid when present; falls back to position-based id for synthetic
  // user messages we surface before the first turn completes.
  id: string;
  // First plain-text block from the user message, capped to one line.
  preview: string;
  // True for the oldest unprocessed message — the one the SDK is
  // currently chewing on. The others are strictly waiting in line.
  current: boolean;
}

// queuedMessages walks the transcript and pulls out user messages that
// haven't been answered yet. The SDK delimits each completed turn with
// a `result` SDKMessage, so anything between the last result and the
// end of history is in flight or queued.
//
// Tool-result user messages (sent by the SDK to relay tool output back
// to the model) are skipped — those aren't user-typed input and don't
// belong in the queue display.
export function computeQueuedMessages(
  history: SDKMessage[],
  thinking: boolean,
): QueuedMessage[] {
  let lastResultIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "result") {
      lastResultIdx = i;
      break;
    }
  }
  const out: QueuedMessage[] = [];
  for (let i = lastResultIdx + 1; i < history.length; i++) {
    const m = history[i];
    if (m.type !== "user") continue;
    const content = m.message.content;
    let preview = "";
    if (typeof content === "string") {
      preview = content;
    } else if (Array.isArray(content)) {
      // Skip pure tool_result messages: they have no text/image blocks
      // the user actually typed. A user message with attachments + text
      // surfaces the text portion as the preview.
      const text = content.find(
        (b): b is { type: "text"; text: string } =>
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      );
      if (!text) continue;
      preview = text.text;
    }
    const trimmed = preview.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    out.push({
      id: (m as { uuid?: string }).uuid ?? `pos-${i}`,
      preview: trimmed,
      // We mark only the oldest message as "current" — that's the one
      // being processed. If the session isn't actively thinking (e.g. an
      // error closed the turn), we don't claim any of them is in flight.
      current: thinking && out.length === 0,
    });
  }
  return out;
}

// QueueIndicator shows up in the composer footer when there's at least
// one user message that the SDK hasn't responded to yet. Click expands
// the previews so the user can see exactly what they queued — and from
// the expanded view, the user can edit or cancel any message that
// hasn't started processing (i.e. !q.current). The in-flight message
// stays read-only because the SDK already has it.
export function QueueIndicator({
  queued,
  onEdit,
  onCancel,
}: {
  queued: QueuedMessage[];
  // When omitted, the indicator stays read-only (current behavior).
  // The chat panel passes the wrappers around chat.editQueued/
  // chat.cancelQueued; the home view never has a queue so it never
  // needs them.
  onEdit?: (uuid: string, text: string) => Promise<void>;
  onCancel?: (uuid: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // Track which row is in edit mode by uuid. Keep it as a single id
  // (not Set) — editing two messages simultaneously would be
  // confusing and the inline editor takes the whole row anyway.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState<{ id: string; what: "edit" | "cancel" } | null>(
    null,
  );

  if (queued.length === 0) return null;

  const pending = queued.filter((q) => !q.current).length;
  const inFlight = queued.find((q) => q.current);
  const summary =
    pending > 0
      ? `${pending} queued`
      : inFlight
        ? "Sending…"
        : `${queued.length} pending`;

  const startEdit = (q: QueuedMessage) => {
    setEditingId(q.id);
    setEditText(q.preview);
    if (!open) setOpen(true);
  };

  const submitEdit = async () => {
    if (!editingId || !onEdit) return;
    const text = editText.trim();
    if (!text) return;
    setBusy({ id: editingId, what: "edit" });
    try {
      await onEdit(editingId, text);
      setEditingId(null);
    } finally {
      setBusy(null);
    }
  };

  const submitCancel = async (id: string) => {
    if (!onCancel) return;
    setBusy({ id, what: "cancel" });
    try {
      await onCancel(id);
      if (editingId === id) setEditingId(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-amber-500/[0.10]"
      >
        <Hourglass className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-amber-700 dark:text-amber-300">
          {summary}
        </span>
        {inFlight && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {inFlight.preview}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="space-y-1 border-t border-amber-500/30 px-3 py-2">
          {queued.map((q, i) => {
            const editable = !q.current && (onEdit || onCancel);
            const editing = editingId === q.id;
            const rowBusy = busy?.id === q.id;
            return (
              <li
                key={q.id}
                className="flex items-start gap-2 rounded text-[11.5px]"
              >
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded px-1.5 font-mono text-[10px]",
                    q.current
                      ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {q.current ? "now" : `#${i}`}
                </span>
                {editing ? (
                  // Inline editor takes the rest of the row so the
                  // user can rewrite without juggling a modal.
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      autoFocus
                      rows={Math.min(
                        6,
                        Math.max(2, editText.split("\n").length),
                      )}
                      className="w-full resize-y rounded border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:border-ring"
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter saves; Escape cancels. Lets
                        // the user commit without reaching for the
                        // mouse.
                        if (
                          (e.metaKey || e.ctrlKey) &&
                          e.key === "Enter" &&
                          !rowBusy
                        ) {
                          e.preventDefault();
                          void submitEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingId(null);
                        }
                      }}
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void submitEdit()}
                        disabled={rowBusy || !editText.trim()}
                        className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[10.5px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        <Check className="size-3" />
                        {rowBusy && busy?.what === "edit" ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={rowBusy}
                        className="inline-flex items-center gap-1 rounded border bg-background px-2 py-0.5 text-[10.5px] hover:bg-muted disabled:opacity-50"
                      >
                        <X className="size-3" />
                        Cancel
                      </button>
                      <span className="text-[10px] text-muted-foreground">
                        ⌘↵ to save · Esc to discard
                      </span>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="line-clamp-2 min-w-0 flex-1 break-words">
                      {q.preview}
                    </span>
                    {editable && (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity hover:opacity-100">
                        {onEdit && (
                          <button
                            type="button"
                            onClick={() => startEdit(q)}
                            disabled={rowBusy}
                            aria-label="Edit queued message"
                            title="Edit"
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        {onCancel && (
                          <button
                            type="button"
                            onClick={() => void submitCancel(q.id)}
                            disabled={rowBusy}
                            aria-label="Cancel queued message"
                            title="Remove from queue"
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
