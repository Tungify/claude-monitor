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

// One row in the picker: the parent user message plus all snapshots
// captured while that message was the active turn. Grouping condenses
// "user asks question → 5 Edits" into one restore point so the user
// reads the timeline as conversation beats, not raw tool calls.
interface RewindGroup {
  // The user message id this group rolls back to. Conversation rewind
  // truncates history right after this message; code rewind restores
  // file state from immediately after this message arrived.
  parentMessageId: string;
  preview: string;
  // Earliest snapshot in the group is what we hand the server for
  // restore — restoreCode walks from this snapshot forward, so picking
  // the earliest covers all later edits within the group.
  anchorSnapshotId: string;
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
    if (!snapshots) return [];
    const byParent = new Map<string, RewindGroup>();
    for (const s of snapshots) {
      if (!s.parentMessageId) continue;
      const preview = userMessagePreview(history, s.parentMessageId);
      const existing = byParent.get(s.parentMessageId);
      if (existing) {
        for (const f of s.files) {
          if (!existing.files.includes(f.path)) {
            existing.files.push(f.path);
          }
        }
        existing.fileCount = existing.files.length;
        // Keep anchor pointing at the earliest snapshot — that's what
        // the restore logic walks from.
        if (s.timestamp < existing.timestamp) {
          existing.anchorSnapshotId = s.id;
          existing.timestamp = s.timestamp;
        }
      } else {
        byParent.set(s.parentMessageId, {
          parentMessageId: s.parentMessageId,
          preview,
          anchorSnapshotId: s.id,
          files: s.files.map((f) => f.path),
          fileCount: s.files.length,
          timestamp: s.timestamp,
        });
      }
    }
    return [...byParent.values()].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    );
  }, [snapshots, history]);

  const onConfirm = async () => {
    if (!pendingChoice) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${sessionId}/rewind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshot_id: pendingChoice.group.anchorSnapshotId,
          mode: pendingChoice.mode,
        }),
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
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-2xl flex-col gap-3 overflow-hidden p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-4">
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
              No restore points yet — file backups appear here once a tool
              modifies a file in this session.
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
  const filesPreview =
    group.fileCount === 0
      ? "no files"
      : group.fileCount === 1
        ? group.files[0]
        : `${group.fileCount} files: ${shortenList(group.files, 3)}`;
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
      <div className="mb-1.5 truncate font-mono text-[10px] text-muted-foreground">
        {filesPreview}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <RowAction
          disabled={disabled}
          onClick={() => onPickMode("conversation")}
          label="Conversation"
        />
        <RowAction
          disabled={disabled}
          onClick={() => onPickMode("code")}
          label="Code"
        />
        <RowAction
          disabled={disabled}
          onClick={() => onPickMode("both")}
          label="Both"
          tone="primary"
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

function userMessagePreview(
  history: SDKMessage[],
  parentMessageId: string,
): string {
  for (const m of history) {
    if (m.type !== "user") continue;
    const uuid = (m as { uuid?: string }).uuid;
    if (uuid !== parentMessageId) continue;
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
