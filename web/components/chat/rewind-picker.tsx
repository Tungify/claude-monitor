"use client";

import { useEffect, useMemo, useState } from "react";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// FileSnapshot mirror — the server-only file-history module is the
// authoritative source. Duplicated here because client code can't
// import "server-only" modules and the route's shape is small + stable.
interface FileSnapshot {
  id: string;
  parentMessageId?: string;
  toolName: string;
  toolUseId?: string;
  timestamp: string;
  files: Array<{
    path: string;
    backupName: string;
    size: number;
    absent?: boolean;
  }>;
}

// One row in the picker: a user message plus any file snapshots
// captured while that message was the active turn. The CLI's
// MessageSelector lists every selectable user message regardless of
// whether code changed — code/both restore options are gated per-row,
// but conversation rewind is always available — and we mirror that
// behavior here so a chat with zero file edits still has restore
// points.
interface RewindGroup {
  // The user message id this group rolls back to. Conversation rewind
  // truncates history right after this message; code rewind restores
  // file state from immediately after this message arrived.
  parentMessageId: string;
  preview: string;
  // Earliest snapshot in the group is what we hand the server for
  // code/both restore — restoreCode walks from this snapshot forward,
  // so picking the earliest covers all later edits within the group.
  // Undefined when this user turn produced no file edits; in that
  // state only the Conversation button is enabled.
  anchorSnapshotId?: string;
  // Every file path touched in this group. Surfaced in the row hint
  // ("3 files: src/foo.ts, src/bar.ts, …") so the user knows what
  // they're restoring.
  files: string[];
  fileCount: number;
  timestamp: string;
}

type Mode = "code" | "conversation" | "both";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  history: SDKMessage[];
  // Called on successful rewind so the parent can refresh state (the
  // chat panel reloads from SSE; this nudges it to expect a state
  // change). Mode is passed back so the parent can show a toast that
  // matches what the user clicked.
  onRewound: (result: { mode: Mode }) => void;
}

// RewindPicker shows the file-history timeline as a list of restore
// points. The user picks a parent user message + a mode (conversation,
// code, or both); the server executes and the picker closes with a
// success toast. Mirrors Claude Code CLI's MessageSelector + restore
// confirm flow but rendered as a single dialog instead of a TUI two-
// step (the desktop UX has more screen real-estate).
export function RewindPicker({
  open,
  onOpenChange,
  sessionId,
  history,
  onRewound,
}: Props) {
  const [snapshots, setSnapshots] = useState<FileSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // pendingChoice doubles as "confirm dialog open + which group". We
  // gate the actual POST behind a confirm step so a click isn't a
  // surprise file rewrite.
  const [pendingChoice, setPendingChoice] = useState<{
    group: RewindGroup;
    mode: Mode;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Setters live in the async body to dodge React 19's
      // set-state-in-effect lint rule. The dialog stays in its
      // previous state for one extra microtask after `open` flips,
      // which is imperceptible — the dialog itself only animates in/
      // out after a render cycle anyway.
      if (!open) {
        if (cancelled) return;
        setSnapshots(null);
        setError(null);
        setPendingChoice(null);
        return;
      }
      try {
        const res = await fetch(`/api/chat/${sessionId}/rewind`);
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { snapshots: FileSnapshot[] };
        if (!cancelled) setSnapshots(data.snapshots);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  const groups = useMemo<RewindGroup[]>(() => {
    // Wait for the snapshots fetch to land before computing — we still
    // build rows from history, but we want snapshot decoration ready in
    // the same render so rows don't briefly flash "no code restore".
    if (!snapshots) return [];

    // Index snapshots by parent message id once so the per-row lookup is
    // O(1). Multiple snapshots can share one parent (one user turn → N
    // tool calls); we keep them ordered by timestamp so picking the
    // earliest as the anchor covers every later edit in the group.
    const byParent = new Map<string, FileSnapshot[]>();
    for (const s of snapshots) {
      if (!s.parentMessageId) continue;
      const list = byParent.get(s.parentMessageId) ?? [];
      list.push(s);
      byParent.set(s.parentMessageId, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    }

    // Source of truth for rows: history's user messages, filtered the
    // same way the CLI's MessageSelector filters them (drop tool
    // results, synthetic / meta entries, slash-command stdout, etc.).
    // Without this filter the picker would surface internal turns the
    // user never typed.
    const rows: RewindGroup[] = [];
    for (const m of history) {
      if (!isSelectableUserMessage(m)) continue;
      const uuid = (m as { uuid?: string }).uuid;
      if (!uuid) continue;
      const preview = extractText(m);
      const ts = (m as { timestamp?: string }).timestamp;
      const snapshotsForTurn = byParent.get(uuid) ?? [];
      const files: string[] = [];
      for (const s of snapshotsForTurn) {
        for (const f of s.files) {
          if (!files.includes(f.path)) files.push(f.path);
        }
      }
      rows.push({
        parentMessageId: uuid,
        preview,
        anchorSnapshotId: snapshotsForTurn[0]?.id,
        files,
        fileCount: files.length,
        // Prefer the user message's own timestamp; fall back to the
        // first snapshot's timestamp; finally now() so the row still
        // sorts in some sensible order.
        timestamp: ts ?? snapshotsForTurn[0]?.timestamp ?? new Date().toISOString(),
      });
    }
    return rows;
  }, [snapshots, history]);

  const onConfirm = async () => {
    if (!pendingChoice) return;
    setBusy(true);
    setError(null);
    try {
      // POST shape: pass snapshot_id when we have one (covers all three
      // modes); otherwise fall back to parent_message_id, which the
      // server accepts for conversation-only rewinds. Code/both POSTs
      // without a snapshot are blocked client-side via row gating, but
      // we still send anchorSnapshotId when present so a future "code
      // even when no snapshot" path (e.g. soft-delete created files)
      // doesn't need a wire change.
      const body: Record<string, string> =
        pendingChoice.group.anchorSnapshotId
          ? {
              snapshot_id: pendingChoice.group.anchorSnapshotId,
              mode: pendingChoice.mode,
            }
          : {
              parent_message_id: pendingChoice.group.parentMessageId,
              mode: pendingChoice.mode,
            };
      const res = await fetch(`/api/chat/${sessionId}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      onRewound({ mode: pendingChoice.mode });
      setPendingChoice(null);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[min(96vw,72rem)] !max-w-[min(96vw,72rem)] flex-col gap-3 overflow-hidden p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <History className="size-4" />
            Rewind to a previous point
          </DialogTitle>
          <DialogDescription className="pr-8">
            Pick a user message to restore. <strong>Conversation</strong>{" "}
            truncates the chat back to that point.{" "}
            <strong>Code</strong> writes the file backups taken before any
            tool ran on that turn back over the working tree.{" "}
            <strong>Both</strong> does the same on both surfaces.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="-mx-1 flex-1 overflow-y-auto">
          {!snapshots && !error && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading history…
            </div>
          )}
          {snapshots && groups.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No restore points yet — send a message to create one.
            </div>
          )}
          {groups.length > 0 && (
            <ul className="space-y-1.5">
              {groups.map((g) => (
                <RewindRow
                  key={g.parentMessageId}
                  group={g}
                  disabled={busy}
                  onPickMode={(mode) =>
                    setPendingChoice({ group: g, mode })
                  }
                />
              ))}
            </ul>
          )}
        </div>

        <ConfirmRewind
          choice={pendingChoice}
          busy={busy}
          onCancel={() => setPendingChoice(null)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

function RewindRow({
  group,
  disabled,
  onPickMode,
}: {
  group: RewindGroup;
  disabled: boolean;
  onPickMode: (mode: Mode) => void;
}) {
  // Code/both restore is only meaningful when at least one file
  // snapshot was captured during this turn. The CLI surfaces the same
  // gating ("No code restore" hint) — without it, clicking Code on a
  // conversation-only turn would no-op silently and look broken.
  const hasCode = !!group.anchorSnapshotId && group.fileCount > 0;
  const filesPreview = hasCode
    ? group.fileCount === 1
      ? group.files[0]
      : `${group.fileCount} files: ${shortenList(group.files, 3)}`
    : "No code changes";
  return (
    <li
      className={cn(
        "rounded-md border bg-background px-2 py-2",
        disabled && "opacity-60",
      )}
    >
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatTime(group.timestamp)}
        </span>
        <span className="line-clamp-2 flex-1 text-sm">
          {group.preview || (
            <span className="text-muted-foreground italic">(no preview)</span>
          )}
        </span>
      </div>
      <div
        className={cn(
          "mb-1.5 truncate font-mono text-[10px]",
          hasCode ? "text-muted-foreground" : "italic text-muted-foreground/70",
        )}
      >
        {filesPreview}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <RowAction
          disabled={disabled}
          onClick={() => onPickMode("conversation")}
          label="Conversation"
          tone={hasCode ? "subtle" : "primary"}
        />
        <RowAction
          disabled={disabled || !hasCode}
          onClick={() => onPickMode("code")}
          label="Code"
        />
        <RowAction
          disabled={disabled || !hasCode}
          onClick={() => onPickMode("both")}
          label="Both"
          tone={hasCode ? "primary" : "subtle"}
        />
      </div>
    </li>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  tone = "subtle",
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "subtle" | "primary";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        tone === "primary"
          ? "bg-primary/90 text-primary-foreground hover:bg-primary"
          : "border bg-muted/40 hover:bg-muted",
      )}
    >
      <RotateCcw className="size-3" />
      Restore {label}
    </button>
  );
}

function ConfirmRewind({
  choice,
  busy,
  onCancel,
  onConfirm,
}: {
  choice: { group: RewindGroup; mode: Mode } | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!choice) return null;
  const { group, mode } = choice;
  const { conversation, code } = describeMode(mode);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <RotateCcw className="size-3.5" />
        Restore {modeLabel(mode)}?
      </div>
      <ul className="mb-2 space-y-0.5 text-xs text-muted-foreground">
        {conversation && (
          <li>
            • Truncate this chat back to:{" "}
            <span className="text-foreground">
              “{shortenPreview(group.preview)}”
            </span>
          </li>
        )}
        {code && group.fileCount > 0 && (
          <li>
            • Restore {group.fileCount} file{group.fileCount === 1 ? "" : "s"}{" "}
            on disk to their pre-edit state:{" "}
            <span className="font-mono text-foreground">
              {shortenList(group.files, 4)}
            </span>
          </li>
        )}
        {code && group.fileCount === 0 && (
          <li>• No file backups in this group — code restore is a no-op.</li>
        )}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          <X className="size-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}{" "}
          Confirm
        </Button>
      </div>
    </div>
  );
}

// Mirrors selectableUserMessagesFilter from the leaked CLI: only true
// user-authored turns are rewindable. Tool results, synthetic / meta
// messages, compact summaries, and slash-command stdout are all dropped
// — those aren't things the user can meaningfully "rewind to" because
// they were never typed.
function isSelectableUserMessage(m: SDKMessage): boolean {
  if (m.type !== "user") return false;
  const msg = (m as { message?: { content?: unknown } }).message;
  if (!msg) return false;
  const content = msg.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { type?: string } | undefined;
    if (first?.type === "tool_result") return false;
  }
  const flags = m as {
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
  };
  if (flags.isMeta) return false;
  if (flags.isCompactSummary) return false;
  if (flags.isVisibleInTranscriptOnly) return false;
  const text = extractText(m);
  // Slash-command stdout, bash output, task notifications, ticks, and
  // teammate messages all arrive wrapped in these tags. Match the CLI's
  // filter so the picker doesn't surface them as rewindable turns.
  for (const tag of [
    "local-command-stdout",
    "local-command-stderr",
    "bash-stdout",
    "bash-stderr",
    "task-notification",
    "tick",
    "teammate-message",
  ]) {
    if (text.indexOf(`<${tag}>`) !== -1) return false;
    if (text.indexOf(`<${tag} `) !== -1) return false;
  }
  return true;
}

function extractText(m: SDKMessage): string {
  if (m.type !== "user") return "";
  const content = m.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
      ) {
        const text = (block as { text?: string }).text;
        if (text) return text;
      }
    }
  }
  return "";
}

function modeLabel(mode: Mode): string {
  if (mode === "conversation") return "conversation";
  if (mode === "code") return "code";
  return "conversation + code";
}

function describeMode(mode: Mode): { conversation: boolean; code: boolean } {
  return {
    conversation: mode === "conversation" || mode === "both",
    code: mode === "code" || mode === "both",
  };
}

function shortenList(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, +${items.length - max} more`;
}

function shortenPreview(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 80)}…`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
