"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Folder,
  Home,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Entry {
  name: string;
  hidden: boolean;
}

interface OkPayload {
  ok: true;
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
}

interface ErrPayload {
  ok: false;
  error: string;
  path?: string;
}

type Payload = OkPayload | ErrPayload;

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  initialPath: string;
  onChoose: (path: string) => void;
}

// FolderBrowserDialog is a server-driven directory browser. We can't
// open the OS folder picker from a regular browser (drag-and-drop only
// gives File names, not absolute paths), so the dialog talks to
// /api/fs/list one level at a time. Single click drills in, breadcrumb
// segments jump to ancestors, "Use this folder" commits whatever's
// being viewed.
//
// The render-keyed inner component ensures we get a fresh navigation
// stack every time the dialog opens — without needing an effect that
// resets state when `initialPath` changes (which the React Compiler /
// set-state-in-effect lint rule actively discourages).
export function FolderBrowserDialog({
  open,
  onOpenChange,
  initialPath,
  onChoose,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose folder</DialogTitle>
        </DialogHeader>
        {open && (
          <BrowserBody
            key={initialPath || "<home>"}
            initialPath={initialPath}
            onChoose={(p) => {
              onChoose(p);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface BodyProps {
  initialPath: string;
  onChoose: (path: string) => void;
  onCancel: () => void;
}

function BrowserBody({ initialPath, onChoose, onCancel }: BodyProps) {
  const [target, setTarget] = useState<string>(initialPath || "");
  const [data, setData] = useState<OkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  // Bumping this triggers a re-fetch even when target hasn't changed —
  // the Refresh button drives it.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    void (async () => {
      // Yield once so the loading flag flip happens AFTER React's
      // commit phase. The set-state-in-effect lint rule fires on
      // sync setState inside an effect body; landing the flip in a
      // microtask satisfies it without changing observable behavior.
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const url = `/api/fs/list?path=${encodeURIComponent(target)}`;
        const res = await fetch(url, { signal: ctrl.signal });
        const json = (await res.json()) as Payload;
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error);
          return;
        }
        setData(json);
        setHome(json.home);
        // Sync target with the server's resolved path (e.g. "" → home,
        // "~/foo" → "/Users/<u>/foo"). The equality guard avoids an
        // infinite effect loop.
        if (json.path !== target) setTarget(json.path);
      } catch (e) {
        if (cancelled || (e as { name?: string }).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [target, refreshTick]);

  const visible = data?.entries.filter((e) => showHidden || !e.hidden) ?? [];
  const segments = splitPath(target);

  return (
    <>
      {/* Breadcrumb — clickable segments to jump to any ancestor. */}
      <div className="flex max-h-16 flex-wrap items-center gap-0.5 overflow-y-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
        <button
          type="button"
          onClick={() => setTarget("/")}
          title="Filesystem root"
          className="rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          /
        </button>
        {segments.map((seg, i) => {
          const p = "/" + segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={p} className="flex items-center">
              <ChevronRight className="size-3 opacity-40" />
              <button
                type="button"
                onClick={() => setTarget(p)}
                className={cn(
                  "rounded px-1 py-0.5 hover:bg-muted",
                  isLast && "font-semibold text-foreground",
                )}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </div>

      {/* Toolbar: Home / Up / Refresh + Show-hidden toggle. */}
      <div className="-mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => home && setTarget(home)}
            disabled={!home}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Home className="size-3" />
            Home
          </button>
          <button
            type="button"
            onClick={() => data?.parent && setTarget(data.parent)}
            disabled={!data?.parent}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronRight className="size-3 -rotate-90" />
            Up
          </button>
          <button
            type="button"
            onClick={() => setRefreshTick((n) => n + 1)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted"
            title="Refresh listing"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 select-none">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            className="size-3"
          />
          Show hidden
        </label>
      </div>

      {/* Listing. min-h keeps the dialog steady while loading so the
          footer doesn't pop up and down between fetches. */}
      <div className="max-h-72 min-h-48 overflow-y-auto rounded-md border">
        {loading && !data && <SkeletonList />}
        {error && (
          <div className="flex h-40 items-start justify-center gap-1.5 px-3 py-6 text-center text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        {!error && data && (
          <ul className="py-1">
            {visible.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                {showHidden
                  ? "Empty folder"
                  : "No visible folders. Toggle Show hidden to see dot-folders."}
              </li>
            ) : (
              visible.map((e) => {
                const child = joinPath(target, e.name);
                return (
                  <li key={e.name}>
                    <button
                      type="button"
                      onClick={() => setTarget(child)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                    >
                      <Folder
                        className={cn(
                          "size-3.5 shrink-0",
                          e.hidden ? "opacity-40" : "opacity-70",
                        )}
                      />
                      <span
                        className={cn(
                          "truncate font-mono",
                          e.hidden && "opacity-60",
                        )}
                      >
                        {e.name}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() => data?.path && onChoose(data.path)}
          disabled={!data}
        >
          Use this folder
        </Button>
      </DialogFooter>
    </>
  );
}

// SkeletonList is a 6-row shimmer used while the FIRST listing is in
// flight. After that we keep the previous data visible while loading
// — the spinner on the Refresh icon is enough to convey "fetching".
function SkeletonList() {
  return (
    <ul className="py-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
        >
          <span className="size-3.5 shrink-0 rounded bg-muted" />
          <span
            className="h-3 rounded bg-muted/70"
            style={{ width: `${40 + ((i * 7) % 50)}%` }}
          />
        </li>
      ))}
    </ul>
  );
}

// splitPath returns the trailing path segments excluding the empty
// pieces from leading/trailing slashes. POSIX-style absolute paths
// only — this app is macOS/Linux.
function splitPath(p: string): string[] {
  return p.split("/").filter(Boolean);
}

function joinPath(base: string, child: string): string {
  if (base.endsWith("/")) return base + child;
  return `${base}/${child}`;
}
