"use client";

import { useState } from "react";
import { Folder, Check, AlertCircle, FolderTree } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { FolderBrowserDialog } from "./folder-browser-dialog";

interface Props {
  value: string;
  onChange: (path: string) => void;
  recents?: string[];
}

// FolderPicker provides a popover with: a default repo-root chip, a
// list of recent cwds from past sessions, a manual text entry validated
// through /api/fs/validate, and a "Browse…" button that opens a
// FolderBrowserDialog backed by /api/fs/list (server-side readdir, the
// closest thing to a native folder picker we can do from a browser).
export function FolderPicker({ value, onChange, recents = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  // Reset the draft to the current `value` whenever the popover opens.
  // Avoids the lint-fighting `useEffect(() => setDraft(value), [value])`
  // pattern; the draft only matters while the popover is on screen.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraft(value);
      setError(null);
    }
    setOpen(next);
  };

  const validateAndCommit = async (raw: string) => {
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/fs/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: raw }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        resolved?: string;
        error?: string;
      };
      if (!data.ok) {
        setError(data.error ?? "invalid path");
        return;
      }
      onChange(data.resolved ?? raw);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  };

  const display = shorten(value);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
          />
        }
      >
        <Folder className="size-3.5 shrink-0 opacity-70" />
        <span className="truncate">{display}</span>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3">
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Working folder
          </div>
          <div className="break-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
            {value}
          </div>
        </div>

        {recents.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Recent
            </div>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {recents.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
                  >
                    {p === value ? (
                      <Check className="size-3 shrink-0" />
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                    <span className="truncate font-mono">{shorten(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Set path
          </div>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="/absolute/path or ~/repos/foo"
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void validateAndCommit(draft);
              }
            }}
          />
          {error && (
            <div className="mt-1 flex items-start gap-1 text-[11px] text-destructive">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Close the popover first so the dialog isn't fighting
                // base-ui's outside-click handling. The dialog owns the
                // overlay anyway — popover stays out of its way.
                setOpen(false);
                setBrowseOpen(true);
              }}
            >
              <FolderTree className="size-3.5" />
              Browse…
            </Button>
            <Button
              size="sm"
              disabled={validating || !draft.trim()}
              onClick={() => void validateAndCommit(draft)}
            >
              {validating ? "Validating…" : "Use this folder"}
            </Button>
          </div>
        </div>
      </PopoverContent>

      <FolderBrowserDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        initialPath={value || draft}
        onChoose={(p) => {
          // Listing returned this path so it's already known to be a
          // real directory — skip the extra /api/fs/validate roundtrip.
          onChange(p);
        }}
      />
    </Popover>
  );
}

// shorten replaces the home prefix with `~` so long absolute paths fit
// in the chip. Keeps trailing two segments visible if the path is deep.
function shorten(p: string): string {
  if (!p) return "Select folder…";
  // Best-effort home replacement — we don't know the user's actual home
  // on the client, so we just collapse common macOS-style "/Users/<name>".
  const m = /^\/Users\/[^/]+/.exec(p);
  const compact = m ? "~" + p.slice(m[0].length) : p;
  if (compact.length <= 32) return compact;
  const parts = compact.split("/").filter(Boolean);
  if (parts.length <= 2) return compact;
  return ".../" + parts.slice(-2).join("/");
}
