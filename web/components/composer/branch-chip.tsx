"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  GitBranch,
  Loader2,
  RefreshCw,
  XIcon,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useGitBranch } from "@/hooks/use-git-branch";
import { useGitDiff, type DiffFileStat } from "@/hooks/use-git-diff";
import { cn } from "@/lib/utils";

// BranchChip sits in the composer's chip row showing the current
// branch + "+A / -D" working-tree totals. Clicking opens a modal
// with a GitHub-style split diff viewer: file list on the left,
// side-by-side old/new code on the right.
//
// Why a modal vs. the earlier popover: a popover is too narrow for
// a side-by-side diff to be readable, and the user explicitly asked
// for a split layout. Modal lets us claim the full viewport width
// without pushing chat content around.
export function BranchChip({ cwd }: { cwd: string | null | undefined }) {
  const branch = useGitBranch(cwd);
  const diff = useGitDiff(cwd);
  const [open, setOpen] = useState(false);

  if (branch.loading) return null;
  if (!branch.branch && !branch.detached) return null;
  const text = branch.branch ?? `det@${branch.detached}`;

  const { additions, deletions } = diff.totals;
  const hasDiff = additions > 0 || deletions > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Re-fetch on open so the modal doesn't open against a
          // 30s-stale snapshot taken right before the agent finished
          // a flurry of Edit/Write tool calls.
          diff.refresh();
        }}
        title={
          branch.branch
            ? `Branch: ${branch.branch}${hasDiff ? ` · ${additions} additions, ${deletions} deletions` : ""}`
            : `Detached HEAD at ${branch.detached}`
        }
        className="inline-flex min-w-0 shrink items-center gap-1.5 rounded-md border border-dashed px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted/40"
      >
        <GitBranch className="size-3 shrink-0 opacity-70" aria-hidden />
        {/* min-w-0 on the text lets it actually truncate inside the
            flex button; max keeps a sane upper bound when there's
            room to spare. */}
        <span className="min-w-0 max-w-[160px] truncate">{text}</span>
        {hasDiff && (
          <span className="flex items-center gap-1 text-[10px]">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{additions}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              -{deletions}
            </span>
          </span>
        )}
        {diff.loading && !hasDiff && (
          <Loader2 className="size-3 shrink-0 animate-spin opacity-60" />
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          // Override the default sm:max-w-sm — a diff viewer needs
          // real width to fit two columns of code side by side. Cap
          // at the viewport so it doesn't overflow on small screens
          // either.
          showCloseButton={false}
          className="flex h-[85vh] max-h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]"
        >
          <DialogHeader
            branchName={text}
            totals={diff.totals}
            loading={diff.loading}
            onRefresh={() => diff.refresh()}
            onClose={() => setOpen(false)}
          />
          <DiffSplitView cwd={cwd ?? ""} files={diff.files} loading={diff.loading} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function DialogHeader({
  branchName,
  totals,
  loading,
  onRefresh,
  onClose,
}: {
  branchName: string;
  totals: { additions: number; deletions: number };
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <GitBranch className="size-4 shrink-0 opacity-70" aria-hidden />
      <span className="font-mono text-sm font-semibold">{branchName}</span>
      <span className="font-mono text-[11px] text-muted-foreground">
        working tree
      </span>
      <span className="ml-auto flex items-center gap-2 text-xs">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{totals.additions}
        </span>
        <span className="text-rose-600 dark:text-rose-400">
          -{totals.deletions}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          title="Refresh"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close"
        >
          <XIcon className="size-4" />
        </Button>
      </span>
    </div>
  );
}

function DiffSplitView({
  cwd,
  files,
  loading,
}: {
  cwd: string;
  files: DiffFileStat[];
  loading: boolean;
}) {
  // Derive the effective selection from (user pick) + (current file
  // list). Avoids setState-in-effect cascades when the file list
  // refreshes: user-clicked path wins if still present, otherwise
  // fall through to the first file so the right pane never blanks
  // out mid-session. Setting null in userSelected resets to "auto".
  const [userSelected, setUserSelected] = useState<string | null>(null);
  const selected = useMemo(() => {
    if (files.length === 0) return null;
    if (userSelected && files.some((f) => f.path === userSelected)) {
      return userSelected;
    }
    return files[0].path;
  }, [files, userSelected]);
  const setSelected = setUserSelected;

  if (files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {loading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Computing diff…
          </span>
        ) : (
          "Working tree is clean."
        )}
      </div>
    );
  }

  // min-h-0 on the flex-1 row is critical — without it the row's
  // implicit min-content height overrides flex-shrink and the diff
  // pane pushes past the dialog's h-[85vh], breaking the scroll.
  // Same for min-w-0 on the right pane: long unbroken code lines
  // would otherwise force the column wider than its share of the
  // row, shoving the file list off-screen.
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <FileList files={files} selected={selected} onSelect={setSelected} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <FilePatchPane cwd={cwd} file={selected} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a file
          </div>
        )}
      </div>
    </div>
  );
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFileStat[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="h-full w-72 shrink-0 overflow-y-auto border-r bg-muted/10">
      {files.map((f) => {
        const active = f.path === selected;
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onSelect(f.path)}
              className={cn(
                "flex w-full items-center gap-1.5 border-l-2 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/60",
                active
                  ? "border-l-primary bg-primary/10 text-foreground"
                  : "border-l-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <StatusBadge status={f.status} />
              <span className="flex-1 truncate font-mono">{f.path}</span>
              <span className="flex shrink-0 items-center gap-1 text-[10px]">
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{f.additions}
                </span>
                <span className="text-rose-600 dark:text-rose-400">
                  -{f.deletions}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Per-file patch cache — keyed by cwd + path so swapping between
// files in the same session doesn't refetch. Modeled as a ref so
// re-renders don't blow it away; we keep it inside the component
// (not at module scope) so it's torn down with the dialog.
function FilePatchPane({ cwd, file }: { cwd: string; file: string }) {
  const cache = useRef(new Map<string, string>());
  const [patch, setPatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = `${cwd} ${file}`;
    const hit = cache.current.get(key);
    if (hit !== undefined) {
      setPatch(hit);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPatch(null);
    (async () => {
      try {
        const url = `/api/fs/diff/patch?path=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`;
        const res = await fetch(url);
        const body = (await res.json()) as {
          ok: boolean;
          patch?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || body.ok === false) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const got = body.patch ?? "";
        cache.current.set(key, got);
        setPatch(got);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, file]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading patch…
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (!patch) {
    return (
      <div className="min-h-0 flex-1 p-3 text-xs text-muted-foreground">
        (no patch)
      </div>
    );
  }
  return <SplitPatch patch={patch} file={file} />;
}

// ── Split-diff renderer ──────────────────────────────────────────────
//
// Parses a unified `git diff` patch and renders it as two columns:
// removed lines on the left, added lines on the right, context lines
// on both. The pairing strategy is naive — a run of consecutive
// `-` lines pairs index-for-index with the following run of `+` lines.
// Anything past the shorter side becomes a blank cell on the other
// side. This isn't character-level diff but it matches how GitHub's
// split view aligns most edits.

type LineKind = "ctx" | "del" | "add" | "empty";

interface SideLine {
  kind: LineKind;
  // 1-based line number in the corresponding side's file. null for
  // empty padding rows (the other side carries the change).
  lineNo: number | null;
  text: string;
}

interface Row {
  left: SideLine;
  right: SideLine;
}

interface Hunk {
  header: string;
  rows: Row[];
}

function parsePatch(patch: string): Hunk[] {
  const lines = patch.split("\n");
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;
  let pendingDels: SideLine[] = [];
  let pendingAdds: SideLine[] = [];

  const flush = () => {
    if (!cur) return;
    const max = Math.max(pendingDels.length, pendingAdds.length);
    for (let i = 0; i < max; i++) {
      const d = pendingDels[i];
      const a = pendingAdds[i];
      cur.rows.push({
        left: d ?? { kind: "empty", lineNo: null, text: "" },
        right: a ?? { kind: "empty", lineNo: null, text: "" },
      });
    }
    pendingDels = [];
    pendingAdds = [];
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLineNo = m ? parseInt(m[1], 10) : 1;
      newLineNo = m ? parseInt(m[2], 10) : 1;
      cur = { header: line, rows: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    // Skip file headers — they're metadata, not diff content.
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      pendingDels.push({
        kind: "del",
        lineNo: oldLineNo++,
        text: line.slice(1),
      });
    } else if (line.startsWith("+")) {
      pendingAdds.push({
        kind: "add",
        lineNo: newLineNo++,
        text: line.slice(1),
      });
    } else {
      // Context. Flush pending +/- pairs first so context lines
      // land below them, then emit identical text on both sides.
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      cur.rows.push({
        left: { kind: "ctx", lineNo: oldLineNo++, text },
        right: { kind: "ctx", lineNo: newLineNo++, text },
      });
    }
  }
  flush();
  return hunks;
}

function SplitPatch({ patch, file }: { patch: string; file: string }) {
  const hunks = useMemo(() => parsePatch(patch), [patch]);
  // Detect once per file render — passes to every cell so the
  // tokenizer call is consistent across the whole hunk.
  const language = useMemo(() => detectLanguage(file), [file]);

  if (hunks.length === 0) {
    return (
      <div className="min-h-0 flex-1 p-3 text-xs text-muted-foreground">
        (no hunks — file probably has only metadata changes)
      </div>
    );
  }

  // code-syntax marker drives the scoped hljs CSS rules in
  // globals.css — picks our two-mode palette over the markdown
  // viewer's github-dark theme.
  return (
    <div className="code-syntax flex min-h-0 flex-1 flex-col bg-background">
      <div className="shrink-0 truncate border-b bg-muted/40 px-3 py-1.5 font-mono text-[11px]">
        {file}
        {language && (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
            {language}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-[1.55]">
        {hunks.map((h, i) => (
          <HunkBlock key={i} hunk={h} language={language} />
        ))}
      </div>
    </div>
  );
}

function HunkBlock({ hunk, language }: { hunk: Hunk; language: string | null }) {
  return (
    <div className="border-b last:border-b-0">
      <div className="border-y border-sky-500/30 bg-gradient-to-r from-sky-500/20 via-sky-500/10 to-transparent px-3 py-1 text-[10.5px] font-medium text-sky-700 dark:text-sky-300">
        {hunk.header}
      </div>
      {/* minmax(0, 1fr) lets the 1fr columns shrink below their
          intrinsic content width — without that, a long code line
          would push the column wider than its share of the row and
          break out of the modal. The whitespace-pre-wrap on cells
          then wraps overflowing text so we never need horizontal
          scroll. break-all is the escape hatch for unbroken strings
          (URLs, base64 blobs). */}
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_3.25rem_minmax(0,1fr)]">
        {hunk.rows.map((r, i) => (
          <DiffRow key={i} row={r} language={language} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ row, language }: { row: Row; language: string | null }) {
  return (
    <>
      <SideCell line={row.left} side="left" language={language} />
      <SideCell line={row.right} side="right" language={language} />
    </>
  );
}

function SideCell({
  line,
  side,
  language,
}: {
  line: SideLine;
  side: "left" | "right";
  language: string | null;
}) {
  const isLeftHalf = side === "left";
  const s = stylesFor(line.kind, side);
  return (
    <>
      <div
        className={cn(
          "flex select-none items-center justify-end gap-1 px-1.5 py-0.5 text-[10px] tabular-nums",
          s.gutterCls,
          isLeftHalf && "border-r border-border/30",
        )}
      >
        {/* Sigil column is fixed-width so line numbers stay
            vertically aligned across context/changed rows. */}
        <span
          aria-hidden
          className={cn("inline-block w-2 text-center", s.sigilCls)}
        >
          {s.sigil}
        </span>
        <span>{line.lineNo ?? ""}</span>
      </div>
      <div
        className={cn(
          "min-w-0 whitespace-pre-wrap break-all px-2 py-0.5",
          s.bodyCls,
          isLeftHalf && "border-r border-border/40",
        )}
      >
        {/* Sigil sits in the gutter so the code column starts on a
            clean character boundary — mono indentation aligns
            cell-to-cell across both sides. highlightLine renders
            hljs spans; CSS in .code-syntax paints them per token
            class. */}
        {line.text ? highlightLine(line.text, language) : " "}
      </div>
    </>
  );
}

interface CellStyle {
  gutterCls: string;
  bodyCls: string;
  sigil: string;
  sigilCls: string;
}

// stylesFor returns the per-cell colour set. The "owner" side of a
// change carries the strong tint; the opposite side gets a much
// lighter wash so the eye can track the row as a *pair* across the
// centre gutter rather than seeing an isolated coloured cell next
// to a plain one. Empty padding rows (one side ran out of paired
// lines) get a uniform striped muted look so they read as "no
// counterpart" rather than "context".
function stylesFor(kind: LineKind, side: "left" | "right"): CellStyle {
  if (kind === "ctx") {
    return {
      gutterCls: "bg-muted/20 text-muted-foreground/60",
      bodyCls: "",
      sigil: "",
      sigilCls: "",
    };
  }
  if (kind === "empty") {
    return {
      gutterCls: "bg-muted/40",
      bodyCls: "bg-muted/25",
      sigil: "",
      sigilCls: "",
    };
  }
  if (kind === "del") {
    const owns = side === "left";
    return {
      gutterCls: owns
        ? "bg-rose-500/25 text-rose-700 dark:text-rose-300"
        : "bg-rose-500/10 text-muted-foreground/50",
      // Body keeps only the tint — text colour comes from tokenize()
      // so syntax highlighting reads cleanly on changed lines too.
      bodyCls: owns ? "bg-rose-500/15" : "bg-rose-500/5",
      sigil: owns ? "-" : "",
      sigilCls: owns ? "text-rose-600 dark:text-rose-400" : "",
    };
  }
  // add
  const owns = side === "right";
  return {
    gutterCls: owns
      ? "bg-emerald-500/25 text-emerald-700 dark:text-emerald-300"
      : "bg-emerald-500/10 text-muted-foreground/50",
    bodyCls: owns ? "bg-emerald-500/15" : "bg-emerald-500/5",
    sigil: owns ? "+" : "",
    sigilCls: owns ? "text-emerald-600 dark:text-emerald-400" : "",
  };
}

// ── Language detection + hljs per-line highlighting ─────────────────
//
// Map file extension / basename to a highlight.js language ID. We're
// importing from `highlight.js/lib/common`, which bundles ~37 of the
// most common languages — anything outside that set falls back to no
// highlighting (still gets the rose/emerald row tint).
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  jsonc: "json",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
};

const BASENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
};

function detectLanguage(path: string): string | null {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const byBase = BASENAME_TO_LANG[base];
  if (byBase && hljs.getLanguage(byBase)) return byBase;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  const lang = EXT_TO_LANG[ext];
  // Only return a language hljs actually has registered — otherwise
  // hljs.highlight would throw at runtime.
  if (lang && hljs.getLanguage(lang)) return lang;
  return null;
}

function highlightLine(text: string, language: string | null): ReactNode {
  if (!text) return " ";
  if (!language) return text;
  try {
    // ignoreIllegals stops hljs from bailing on a single weird token
    // (a half-comment at line boundary, etc) and falling back to raw
    // text mid-row.
    const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return text;
  }
}

function StatusBadge({ status }: { status: string | null }) {
  const cfg = STATUS_STYLES[status ?? "?"] ?? STATUS_STYLES["?"];
  return (
    <span
      title={cfg.label}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-bold",
        cfg.cls,
      )}
    >
      {cfg.glyph}
    </span>
  );
}

const STATUS_STYLES: Record<
  string,
  { glyph: string; label: string; cls: string }
> = {
  A: {
    glyph: "A",
    label: "Added (staged)",
    cls: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  },
  M: {
    glyph: "M",
    label: "Modified",
    cls: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  },
  D: {
    glyph: "D",
    label: "Deleted",
    cls: "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  },
  R: {
    glyph: "R",
    label: "Renamed",
    cls: "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  },
  C: {
    glyph: "C",
    label: "Copied",
    cls: "bg-sky-500/20 text-sky-700 dark:text-sky-300",
  },
  T: {
    glyph: "T",
    label: "Type changed",
    cls: "bg-muted text-muted-foreground",
  },
  U: {
    glyph: "U",
    label: "Unmerged",
    cls: "bg-destructive/20 text-destructive",
  },
  "?": {
    glyph: "?",
    label: "Untracked",
    cls: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  },
};
