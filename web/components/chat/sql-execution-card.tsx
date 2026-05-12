"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Table2,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import { cn } from "@/lib/utils";

// SqlExecutionCard renders one SQL execution as a compact playground
// panel: a header strip with driver/connection + run controls, an
// editable SQL block with line numbers, then a result panel with
// row/column stats and a table (or JSON) view. The user can tweak
// the SQL inline and press Run (or Cmd/Ctrl+Enter) to re-execute
// without going back through the chat. Reset restores the LLM's
// original SQL.
//
// Run fires a one-shot call to /api/mcp/db/execute which spawns a
// transient MCP client against the configured postgres-mcp /
// mcp-clickhouse server and returns the result. Pause aborts the
// in-flight fetch — the upstream MCP server is a child process of
// our Node worker, so aborting the fetch is enough to tear it down.

type Driver = "postgres" | "clickhouse";

type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: unknown }
  | { type: string; [k: string]: unknown };

interface Props {
  toolName: string; // mcp__<connection_name>__<tool>
  connectionName: string;
  driver: Driver;
  sql: string;
  initialContent?: ToolContentBlock[];
  initialIsError?: boolean;
}

interface Run {
  // "awaiting" = LLM has emitted tool_use, we're waiting for the
  // matching tool_result to arrive (server-side execution in flight).
  // "idle"    = user has cleared / cancelled; Run button is the next move.
  // "running" = a user-triggered re-run is in flight via /api/mcp/db/execute.
  // "ok" / "error" = terminal states with content populated.
  state: "awaiting" | "idle" | "running" | "ok" | "error";
  content?: ToolContentBlock[];
  isError?: boolean;
  message?: string;
}

export function SqlExecutionCard({
  toolName,
  connectionName,
  driver,
  sql,
  initialContent,
  initialIsError,
}: Props) {
  // The card mounts as soon as the LLM emits its tool_use block — the
  // matching tool_result usually arrives on the next render tick.
  // `awaiting` covers that gap: instead of showing the misleading
  // "Click Run to execute" idle copy while the model's own execution
  // is in flight, we show a "Waiting for result…" state and then
  // adopt the result the moment initialContent populates.
  const hasInitial = !!initialContent && initialContent.length > 0;
  const [run, setRun] = useState<Run>(() => {
    if (!hasInitial) return { state: "awaiting" };
    return {
      state: initialIsError ? "error" : "ok",
      content: initialContent,
      isError: initialIsError,
    };
  });
  // Sync from prop when the LLM's tool_result arrives after mount.
  // Only the awaiting→ok/error transition is automatic; once the user
  // has taken local action (Run, Pause, edit-and-Run), we keep their
  // state and ignore later prop changes — a re-render from a Virtuoso
  // recycle shouldn't clobber a manual re-run.
  useEffect(() => {
    if (!hasInitial) return;
    setRun((r) => {
      if (r.state !== "awaiting") return r;
      return {
        state: initialIsError ? "error" : "ok",
        content: initialContent,
        isError: initialIsError,
      };
    });
  }, [hasInitial, initialContent, initialIsError]);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);
  const originalSql = useMemo(() => sql.trim(), [sql]);
  const [sqlText, setSqlText] = useState(originalSql);
  const edited = sqlText.trim() !== originalSql;
  // If the prop SQL changes (e.g., a Virtuoso recycle, or rare
  // mid-stream tool_use refinement) and the user hasn't edited
  // locally, follow the prop. Track "what we last accepted from the
  // prop" via a ref so edits are detected as "diverged from accepted
  // baseline" instead of compared to a stale originalSql.
  const acceptedSqlRef = useRef(originalSql);
  useEffect(() => {
    if (sqlText === acceptedSqlRef.current) {
      setSqlText(originalSql);
    }
    acceptedSqlRef.current = originalSql;
    // sqlText intentionally omitted — we only re-check at prop boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalSql]);
  // Result panel starts expanded — the playground card IS the canonical
  // tabular view of the SQL output, and the system-prompt directive
  // (DB_MCP_PRESENTATION_APPEND) tells the LLM not to mirror the same
  // rows as a markdown table in its reply. The chevron in the result
  // header lets the user collapse manually if they want.
  const [resultOpen, setResultOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // ESC closes the modal-fullscreen view; body scroll is locked while
  // active so the chat behind the backdrop can't scroll out from
  // under the user. Virtuoso would otherwise be free to recycle this
  // card and unmount it mid-modal — blocking body scroll keeps it
  // pinned in viewport.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  const cancel = useCallback(() => {
    abortCtrl?.abort();
    setAbortCtrl(null);
    setRun((r) => (r.state === "running" ? { state: "idle" } : r));
  }, [abortCtrl]);

  const run_ = useCallback(async () => {
    if (run.state === "running") return;
    setResultOpen(true);
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    setRun({ state: "running" });
    try {
      const res = await fetch("/api/mcp/db/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connection: connectionName, sql: sqlText }),
        signal: ctrl.signal,
      });
      const body = (await res.json()) as {
        ok?: boolean;
        content?: ToolContentBlock[];
        isError?: boolean;
        error?: string;
      };
      if (!res.ok || body.ok === false) {
        setRun({
          state: "error",
          message: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setRun({
        state: body.isError ? "error" : "ok",
        content: body.content ?? [],
        isError: body.isError,
        message: body.isError ? "Server returned an error result" : undefined,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setRun({ state: "idle" });
        return;
      }
      setRun({ state: "error", message: (err as Error).message });
    } finally {
      setAbortCtrl(null);
    }
  }, [connectionName, sqlText, run.state]);

  // Cancel in-flight on unmount so a backgrounded card doesn't leak
  // a network request when the user navigates away mid-execution.
  useEffect(() => {
    return () => abortCtrl?.abort();
  }, [abortCtrl]);

  const lines = useMemo(() => sqlText.split("\n"), [sqlText]);

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (run.state === "running") cancel();
      else void run_();
    }
  };

  return (
    <>
      {fullscreen && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
          onClick={() => setFullscreen(false)}
          aria-hidden
        />
      )}
      <div
        className={cn(
          "min-w-0 max-w-full overflow-hidden rounded-md border bg-background/40",
          fullscreen &&
            "fixed inset-4 z-50 flex flex-col bg-background shadow-2xl",
        )}
      >
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
        <DriverBadge driver={driver} />
        <span className="truncate font-mono font-medium">{connectionName}</span>
        <span
          className="hidden truncate font-mono text-muted-foreground sm:inline"
          title={toolName}
        >
          · {driver === "postgres" ? "execute_sql" : "run_query"}
        </span>
        {edited && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
            edited
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {edited && (
            <button
              type="button"
              onClick={() => setSqlText(originalSql)}
              className="inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Reset to original SQL"
            >
              <RotateCcw className="size-3" /> Reset
            </button>
          )}
          <CopyButton text={sqlText} />
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {fullscreen ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </button>
          <button
            type="button"
            onClick={run.state === "running" ? cancel : run_}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-[11px] font-medium hover:bg-muted",
              run.state === "running" && "text-amber-600",
            )}
            aria-label={run.state === "running" ? "Pause execution" : "Run SQL"}
            title={
              run.state === "running"
                ? "Pause"
                : "Run (⌘/Ctrl+Enter)"
            }
          >
            {run.state === "running" ? (
              <>
                <Pause className="size-3" /> Pause
              </>
            ) : (
              <>
                <Play className="size-3" /> Run
              </>
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b bg-background/60 px-3 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono uppercase tracking-wider">SQL</span>
        <span className="font-mono text-muted-foreground/70">
          · {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
          ⌘/Ctrl + Enter
        </span>
      </div>

      <SqlEditor
        value={sqlText}
        onChange={setSqlText}
        onKeyDown={onEditorKeyDown}
        lines={lines}
      />

        <ResultPane
          run={run}
          open={resultOpen}
          onToggle={() => setResultOpen((v) => !v)}
          fullscreen={fullscreen}
        />
      </div>
    </>
  );
}

// SqlEditor overlays a transparent <textarea> on top of a highlighted
// <pre>: the user types into the form control, but reads the
// highlight layer underneath. Typography on the two elements must
// match character-for-character — same font, padding, line-height,
// whitespace handling — or glyphs drift away from their highlighted
// background. The pre defines the box's intrinsic size; the textarea
// inset-0 fills it, so a long line grows both layers in lockstep
// and the outer overflow-auto handles horizontal scroll.
function SqlEditor({
  value,
  onChange,
  onKeyDown,
  lines,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  lines: string[];
}) {
  const highlighted = useMemo(() => {
    try {
      const html = hljs.highlight(value, {
        language: "sql",
        ignoreIllegals: true,
      }).value;
      // Trailing newline guarantees the pre keeps a final empty
      // line so the caret has somewhere to sit when the user lands
      // at end-of-document and starts typing.
      return html + (html.endsWith("\n") ? "\n" : "\n");
    } catch {
      return escapeHtml(value) + "\n";
    }
  }, [value]);

  return (
    <div className="code-syntax max-h-56 overflow-auto bg-muted/10">
      <div className="flex font-mono text-xs leading-5">
        <div
          aria-hidden
          className="sticky left-0 z-10 select-none border-r bg-muted/30 py-2 pr-2 pl-3 text-right text-muted-foreground/60"
        >
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="relative">
          <pre
            aria-hidden
            className="m-0 whitespace-pre px-3 py-2 font-mono text-xs leading-5"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            wrap="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="absolute inset-0 block w-full resize-none whitespace-pre border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/30 selection:text-foreground focus:bg-background/40"
          />
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// jsonHighlight returns HTML safe to drop into `dangerouslySetInnerHTML`.
// hljs always HTML-escapes its input, so the highlighted branch is
// safe; the fallback path escapes manually because raw user text is
// not safe by default. Only treats {…}/[…] input as JSON so plain
// status strings like "ok" don't get mis-tokenised.
function jsonHighlight(text: string): { __html: string } {
  if (!text) return { __html: "" };
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { __html: escapeHtml(text) };
  }
  try {
    const raw = hljs.highlight(text, {
      language: "json",
      ignoreIllegals: true,
    }).value;
    return { __html: decorateJsonPunctuation(raw) };
  } catch {
    return { __html: escapeHtml(text) };
  }
}

// decorateJsonPunctuation wraps bare {}[],: characters in
// hljs-punctuation spans so they pick up the syntax palette.
// hljs's JSON grammar doesn't tag punctuation, so without this pass
// brackets/commas/colons render in foreground colour — exactly the
// "wall of plain text with a few coloured tokens" look the user
// complained about. We track span nesting depth so colons inside
// `hljs-string` values (e.g. a stored URL or a timestamp like
// "12:34") are left alone — they're part of the user's data, not
// JSON syntax.
function decorateJsonPunctuation(html: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        out += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      out += tag;
      if (tag.startsWith("</")) depth = Math.max(0, depth - 1);
      else if (!tag.endsWith("/>")) depth++;
      i = end + 1;
      continue;
    }
    if (
      depth === 0 &&
      (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "," || ch === ":")
    ) {
      out += `<span class="hljs-punctuation">${ch}</span>`;
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable in some embedded contexts; the
      // user can still select the text manually. Silently swallow.
    }
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
      title={copied ? "Copied" : "Copy SQL"}
      aria-label="Copy SQL"
    >
      {copied ? (
        <Check className="size-3 text-emerald-600" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  );
}

function DriverBadge({ driver }: { driver: Driver }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        driver === "postgres"
          ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
          : "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
      )}
    >
      {driver === "postgres" ? "pg" : "ch"}
    </span>
  );
}

function ResultPane({
  run,
  open,
  onToggle,
  fullscreen,
}: {
  run: Run;
  open: boolean;
  onToggle: () => void;
  fullscreen: boolean;
}) {
  if (run.state === "awaiting") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Waiting for result…
      </div>
    );
  }
  if (run.state === "idle") {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        Click Run to execute.
      </div>
    );
  }
  if (run.state === "running") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Executing…
      </div>
    );
  }
  // Errors stay always-visible — too important to hide behind a chevron.
  if (run.state === "error") {
    return (
      <div className="space-y-1 px-3 py-2">
        <div className="text-xs font-medium text-destructive">
          {run.message ?? "Error"}
        </div>
        {renderText(run.content) && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-destructive/80">
            {renderText(run.content)}
          </pre>
        )}
      </div>
    );
  }
  return (
    <ResultBody
      content={run.content ?? []}
      open={open}
      onToggle={onToggle}
      fullscreen={fullscreen}
    />
  );
}

function ResultBody({
  content,
  open,
  onToggle,
  fullscreen,
}: {
  content: ToolContentBlock[];
  open: boolean;
  onToggle: () => void;
  fullscreen: boolean;
}) {
  const text = renderText(content);
  const parsed = useMemo(() => tryParseRows(text), [text]);
  const [view, setView] = useState<"table" | "raw">(parsed ? "table" : "raw");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  if (!text) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">No output.</div>
    );
  }

  // Cap render to keep DOM modest. The user can re-run a LIMIT for
  // deeper exploration; pagination on a tool-result card would lock
  // a lot of UI space behind a niche use case.
  const cap = 200;
  const display = parsed ? parsed.rows.slice(0, cap) : [];

  return (
    <div
      className={cn(
        "min-w-0",
        fullscreen && open && "flex flex-1 flex-col min-h-0",
      )}
    >
      <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded hover:text-foreground"
          title={open ? "Hide result" : "Show result"}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span className="font-mono uppercase tracking-wider">Result</span>
        </button>
        <span className="text-muted-foreground/60">·</span>
        {parsed ? (
          <>
            <span className="font-mono">
              {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono">
              {parsed.columns.length} col
              {parsed.columns.length === 1 ? "" : "s"}
            </span>
            {parsed.rows.length > cap && (
              <span className="text-muted-foreground/60">
                · showing first {cap}
              </span>
            )}
          </>
        ) : (
          <span className="font-mono">{formatBytes(text.length)}</span>
        )}
        {open && (
          <div className="ml-auto inline-flex overflow-hidden rounded border">
            <ViewToggle
              active={view === "table"}
              disabled={!parsed}
              onClick={() => setView("table")}
              label="Table"
              icon={<Table2 className="size-3" />}
              title={parsed ? "Show as table" : "Couldn't parse rows"}
            />
            <ViewToggle
              active={view === "raw"}
              onClick={() => setView("raw")}
              label="Raw"
              icon={<FileText className="size-3" />}
              title="Show raw text"
            />
          </div>
        )}
      </div>

      {!open ? null : view === "raw" || !parsed ? (
        <pre
          className={cn(
            "code-syntax overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all",
            fullscreen ? "min-h-0 flex-1" : "max-h-96",
          )}
          dangerouslySetInnerHTML={jsonHighlight(text)}
        />
      ) : parsed.rows.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">(0 rows)</div>
      ) : (
        <div
          className={cn(
            "overflow-auto",
            fullscreen ? "min-h-0 flex-1" : "max-h-96",
          )}
        >
          <table className="w-max min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-muted backdrop-blur-sm">
              <tr>
                <th className="sticky left-0 z-20 border-b border-r bg-muted px-2 py-1 text-right font-medium text-muted-foreground/60">
                  #
                </th>
                {parsed.columns.map((c) => (
                  <th
                    key={c}
                    className="border-b border-r bg-muted px-2 py-1 text-left font-medium text-muted-foreground"
                    title={c}
                  >
                    <span className="block max-w-[16ch] truncate">{c}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.map((row, i) => {
                const isOpen = expandedRow === i;
                return (
                  <RowItem
                    key={i}
                    index={i}
                    row={row}
                    columns={parsed.columns}
                    expanded={isOpen}
                    onToggle={() => setExpandedRow(isOpen ? null : i)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// renderText concatenates text blocks, peels any outer MCP envelope,
// then normalizes the inner text to pretty-printed JSON so the Raw
// view shows clean structured data instead of either the wrapper
// (`{"result":[{"type":"text","text":"<inner>",...}]}`) or Python repr
// (`[{'id': '...', 'createdAt': datetime.datetime(...), ...}]` from
// pg8000-backed servers like mcp__dev).
//
// Order matters: peel envelope first (the wrapper itself is valid
// JSON, so without peeling we'd pretty-print the wrapper), then
// attempt Python-repr → JSON conversion, then JSON.parse for pretty
// output. If any step fails, fall back to the most-peeled string we
// have so the user still sees something useful in Raw view.
function renderText(content?: ToolContentBlock[]): string {
  if (!content) return "";
  const joined = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const peeled = peelMcpEnvelope(joined) ?? joined;
  return normalizeToJsonText(peeled);
}

// normalizeToJsonText returns a pretty-printed JSON string when the
// input parses as JSON OR as Python repr. Idempotent on already-JSON
// input. Returns the original string unchanged when neither parse
// succeeds (e.g. plain "ok" / error messages from servers that don't
// emit structured output).
function normalizeToJsonText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  // Try as-is first — covers clickhouse + servers that already emit
  // proper JSON. Avoids the corner case where pythonReprToJson would
  // mangle the literal word "None" appearing inside a JSON string.
  const direct = safeJsonParse(trimmed);
  if (direct !== undefined) return JSON.stringify(direct, null, 2);
  // Then try Python repr.
  const normalized = safeJsonParse(pythonReprToJson(trimmed));
  if (normalized !== undefined) return JSON.stringify(normalized, null, 2);
  return text;
}

// tryParseRows handles multiple upstream shapes:
//   - mcp-clickhouse: `{"columns":["a","b"],"rows":[[1,"x"],...]}`
//   - postgres-mcp:   `[{"col1":1,"col2":"x"}, ...]`
//   - Some MCP servers wrap output as `{"result":[{"type":"text","text":"<inner>"}], ...}`
//   - Python-based servers (e.g. mcp__dev) emit Python repr:
//       `[{'id': 'x', 'createdAt': datetime.datetime(2026, 4, 15, ...), ...}]`
// We peel the envelope and normalize Python repr to JSON before
// retrying. Best-effort — returns null when nothing usable comes back.
function tryParseRows(text: string): {
  columns: string[];
  rows: unknown[][];
} | null {
  const candidates = [text, peelMcpEnvelope(text)].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const direct = safeJsonParse(trimmed);
    if (direct !== undefined) {
      const rows = rowsFromData(direct);
      if (rows) return rows;
    }
    const normalized = safeJsonParse(pythonReprToJson(trimmed));
    if (normalized !== undefined) {
      const rows = rowsFromData(normalized);
      if (rows) return rows;
    }
  }
  return null;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function peelMcpEnvelope(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  const data = safeJsonParse(trimmed);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = (data as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length === 0) return null;
  const first = result[0] as { text?: unknown } | undefined;
  if (first && typeof first.text === "string") return first.text;
  return null;
}

function rowsFromData(
  data: unknown,
): { columns: string[]; rows: unknown[][] } | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as { columns?: unknown; rows?: unknown };
    if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) {
      return {
        columns: obj.columns.map(String),
        rows: (obj.rows as unknown[]).map((r) => (Array.isArray(r) ? r : [r])),
      };
    }
  }
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      // Union of keys across all rows so a sparse row doesn't drop
      // columns that other rows have.
      const cols: string[] = [];
      const seen = new Set<string>();
      for (const r of data) {
        if (!r || typeof r !== "object") continue;
        for (const k of Object.keys(r as Record<string, unknown>)) {
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
        }
      }
      const rows = data.map((r) =>
        cols.map((c) =>
          r && typeof r === "object"
            ? (r as Record<string, unknown>)[c]
            : undefined,
        ),
      );
      return { columns: cols, rows };
    }
  }
  return null;
}

// pythonReprToJson converts a Python literal string into JSON. Handles
// the cases we've seen in MCP outputs: single-quoted strings,
// `None/True/False`, and `datetime.datetime(y, m, d, H, M, S[, us])`
// constructors. Best-effort — uncommon repr forms (`Decimal('...')`,
// `UUID('...')`) are normalized to bare strings; truly weird shapes
// still fall back to Raw view.
function pythonReprToJson(input: string): string {
  let s = input;
  s = s.replace(
    /datetime\.datetime\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*\d+)?\s*\)/g,
    (_m, y, mo, d, h, mi, se) =>
      `"${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}"`,
  );
  s = s.replace(
    /datetime\.date\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g,
    (_m, y, mo, d) => `"${y}-${pad2(mo)}-${pad2(d)}"`,
  );
  s = s.replace(/(?:Decimal|UUID)\(\s*'([^']*)'\s*\)/g, '"$1"');
  // Walk string-by-string so single-quoted strings become double-quoted
  // JSON strings without mangling apostrophes inside double-quoted ones.
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "'") {
      out += '"';
      i++;
      while (i < s.length) {
        const ch = s[i];
        if (ch === "\\" && i + 1 < s.length) {
          const nx = s[i + 1];
          if (nx === "'") {
            out += "'";
            i += 2;
            continue;
          }
          out += ch + nx;
          i += 2;
          continue;
        }
        if (ch === '"') {
          out += '\\"';
          i++;
          continue;
        }
        if (ch === "'") {
          out += '"';
          i++;
          break;
        }
        out += ch;
        i++;
      }
      continue;
    }
    if (c === '"') {
      out += c;
      i++;
      while (i < s.length) {
        const ch = s[i];
        if (ch === "\\" && i + 1 < s.length) {
          out += ch + s[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          out += ch;
          i++;
          break;
        }
        out += ch;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  out = out
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false");
  return out;
}

function pad2(s: string): string {
  return s.length >= 2 ? s : "0" + s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ViewToggle({
  active,
  onClick,
  label,
  icon,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-[11px]",
        active
          ? "bg-background font-medium text-foreground"
          : "bg-transparent text-muted-foreground hover:bg-background/60",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RowItem({
  index,
  row,
  columns,
  expanded,
  onToggle,
}: {
  index: number;
  row: unknown[];
  columns: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  // Zebra striping intentionally dropped: tailwind's translucent
  // utilities (`bg-muted/10`) leak the scrolling content through the
  // sticky `#` cell when the user pans horizontally. Sticky cells
  // need an opaque background to actually mask the columns sliding
  // behind them, so the whole row uses solid `bg-background` and
  // hover/expanded give the row interaction feedback.
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "cursor-pointer bg-background hover:bg-muted/60",
          expanded && "bg-muted/60",
        )}
      >
        <td className="sticky left-0 border-b border-r bg-inherit px-2 py-1 text-right font-mono text-muted-foreground/60">
          {index + 1}
        </td>
        {row.map((cell, j) => (
          <td
            key={j}
            className="border-b border-r px-2 py-1 align-top font-mono"
          >
            <span
              className="block max-w-[40ch] truncate"
              title={fullCell(cell)}
            >
              {formatCell(cell)}
            </span>
          </td>
        ))}
      </tr>
      {expanded && (
        <tr>
          <td
            colSpan={columns.length + 1}
            className="border-b bg-muted/20 px-3 py-2"
          >
            <pre
              className="code-syntax max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px]"
              dangerouslySetInnerHTML={jsonHighlight(
                JSON.stringify(rowToObject(columns, row), null, 2),
              )}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function rowToObject(
  columns: string[],
  row: unknown[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i] ?? `col${i}`] = row[i];
  }
  return obj;
}

function formatCell(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fullCell(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
