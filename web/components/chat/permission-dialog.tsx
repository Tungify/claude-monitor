"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Code,
  FileEdit,
  FilePlus,
  FileText,
  Globe,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  PermissionDecision,
  PermissionRequest,
} from "@/lib/chat-types";
import { cn } from "@/lib/utils";

interface Props {
  request: PermissionRequest | null;
  onDecide: (decision: PermissionDecision) => Promise<void>;
}

// PermissionDialog asks the user whether the agent may run a tool. The
// previous version dumped the raw JSON input, which is unreadable for
// most tools (especially Edit's escaped strings). This rewrite renders a
// per-tool preview — file path, diff, command, URL, pattern, etc. — and
// keeps the JSON behind a "Show details" toggle for power users.
export function PermissionDialog({ request, onDecide }: Props) {
  const [denyMessage, setDenyMessage] = useState("");
  const [denyMode, setDenyMode] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState<"allow" | "always" | "deny" | null>(null);
  const open = request !== null;
  // The SDK ships per-call permission suggestions (e.g. "addRules:
  // Bash(<exact command>:*) for session"). When present we surface an
  // "Always allow" affordance that round-trips those suggestions back
  // as updatedPermissions — the SDK then short-circuits matching tool
  // calls for the rest of the session without bothering the user.
  const canAlwaysAllow = (request?.permission_suggestions?.length ?? 0) > 0;

  const reset = () => {
    setDenyMessage("");
    setDenyMode(false);
    setShowRaw(false);
    setBusy(null);
  };

  const onAllow = async () => {
    setBusy("allow");
    try {
      await onDecide({ behavior: "allow" });
    } finally {
      reset();
    }
  };

  const onAlwaysAllow = async () => {
    setBusy("always");
    try {
      await onDecide({ behavior: "allow", always_allow: true });
    } finally {
      reset();
    }
  };

  const onDeny = async () => {
    setBusy("deny");
    try {
      await onDecide({
        behavior: "deny",
        message: denyMessage.trim() || "denied by user",
      });
    } finally {
      reset();
    }
  };

  const meta = request ? toolMeta(request.tool_name) : null;
  const Icon = meta?.icon ?? AlertTriangle;

  return (
    <Dialog open={open}>
      {/* DialogContent uses CSS grid; grid items default to
          min-width:auto so an unwrappable child (long path, long bash
          command, JSON blob) can blow past max-w-2xl. min-w-0 lets the
          grid tracks shrink, and the inner pre's wrap rules handle the
          rest. */}
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md",
                meta?.tone === "danger"
                  ? "bg-destructive/15 text-destructive"
                  : meta?.tone === "warn"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-primary/10 text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 truncate">
              {meta?.title ?? request?.tool_name}
            </span>
            <span className="ml-2 min-w-0 truncate font-mono text-xs text-muted-foreground">
              {request?.tool_name}
            </span>
          </DialogTitle>
          <DialogDescription>
            {meta?.description ??
              "The agent wants to run this tool. Review the operation below before allowing."}
          </DialogDescription>
        </DialogHeader>

        {request && (
          <div className="min-w-0 space-y-3">
            <PermissionPreview request={request} />

            {/* Raw input expandable for power users / unknown tools.
                Collapsed by default so the dialog stays scannable. */}
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3 transition-transform",
                  showRaw && "rotate-90",
                )}
                aria-hidden
              />
              <span>{showRaw ? "Hide" : "Show"} raw input</span>
            </button>
            {showRaw && (
              <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                {JSON.stringify(request.input, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Deny reason field appears only after the user clicks Deny so
            the steady-state dialog isn't cluttered with an empty input
            most people skip. */}
        {denyMode && (
          <div className="space-y-1">
            <label
              htmlFor="cm-deny-reason"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Reason for denying (optional, sent to the agent)
            </label>
            <Textarea
              id="cm-deny-reason"
              autoFocus
              placeholder="e.g. wrong file, suggest using X instead"
              value={denyMessage}
              onChange={(e) => setDenyMessage(e.target.value)}
              rows={2}
            />
          </div>
        )}

        <DialogFooter className="gap-1.5 sm:gap-1.5">
          {!denyMode ? (
            <>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => setDenyMode(true)}
              >
                Deny
              </Button>
              {canAlwaysAllow && (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={onAlwaysAllow}
                  title="Allow this tool call AND don't ask again for matching calls (applies the SDK's suggested rules — typically session-scoped)."
                >
                  {busy === "always" ? "Saving…" : "Always allow"}
                </Button>
              )}
              <Button disabled={busy !== null} onClick={onAllow}>
                {busy === "allow" ? "Allowing…" : "Allow"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setDenyMode(false);
                  setDenyMessage("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={onDeny}
              >
                {busy === "deny" ? "Denying…" : "Confirm deny"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ToolMeta {
  title: string;
  description: string;
  icon: typeof FileText;
  tone: "neutral" | "warn" | "danger";
}

// toolMeta picks a friendly label, blurb, icon, and tone for the most
// common tools the SDK gates. Defaults to a neutral "tool call" for
// anything we haven't curated.
function toolMeta(name: string): ToolMeta {
  switch (name) {
    case "Read":
      return {
        title: "Read a file",
        description: "Claude wants to read a file from your workspace.",
        icon: FileText,
        tone: "neutral",
      };
    case "Write":
      return {
        title: "Create or overwrite a file",
        description:
          "Claude wants to write a file. This replaces the file's contents if it exists.",
        icon: FilePlus,
        tone: "warn",
      };
    case "Edit":
    case "NotebookEdit":
      return {
        title: "Edit a file",
        description:
          "Claude wants to apply a string replacement. Review the diff below before allowing.",
        icon: FileEdit,
        tone: "warn",
      };
    case "Bash":
      return {
        title: "Run a shell command",
        description:
          "Claude wants to run a command in your terminal. Inspect the command before allowing — it executes with your shell privileges.",
        icon: Terminal,
        tone: "danger",
      };
    case "Glob":
      return {
        title: "Find files by pattern",
        description: "Claude wants to search for files matching a glob.",
        icon: Search,
        tone: "neutral",
      };
    case "Grep":
      return {
        title: "Search file contents",
        description: "Claude wants to grep through your files.",
        icon: Search,
        tone: "neutral",
      };
    case "WebFetch":
      return {
        title: "Fetch a URL",
        description: "Claude wants to make an HTTP request and read the response.",
        icon: Globe,
        tone: "neutral",
      };
    case "WebSearch":
      return {
        title: "Search the web",
        description: "Claude wants to run a web search query.",
        icon: Globe,
        tone: "neutral",
      };
    case "Task":
    case "Agent":
      return {
        title: "Dispatch a subagent",
        description:
          "Claude wants to spawn a subagent to handle a focused task. The subagent runs with the same permissions as this session.",
        icon: Sparkles,
        tone: "warn",
      };
    case "Skill":
      return {
        title: "Invoke a skill",
        description: "Claude wants to invoke a skill from the registry.",
        icon: Sparkles,
        tone: "neutral",
      };
    default:
      return {
        title: "Tool call",
        description:
          "The agent wants to run this tool. Review the input below.",
        icon: Code,
        tone: "neutral",
      };
  }
}

// PermissionPreview renders a per-tool friendly view of the input. Each
// helper sits next to it and only handles its own shape, so adding a
// new tool is a one-case extension.
function PermissionPreview({ request }: { request: PermissionRequest }) {
  const { tool_name, input } = request;
  switch (tool_name) {
    case "Read":
      return (
        <PathRow
          label="Read"
          path={asString(input.file_path)}
          extras={
            input.offset || input.limit
              ? `lines ${input.offset ?? 1}–${
                  Number(input.offset ?? 1) + Number(input.limit ?? 0)
                }`
              : undefined
          }
        />
      );
    case "Write":
      return (
        <div className="space-y-2">
          <PathRow label="Write" path={asString(input.file_path)} />
          {Boolean(input.content) && (
            <CodePreview
              label="Content"
              source={asString(input.content)}
              language={languageFromPath(asString(input.file_path))}
            />
          )}
        </div>
      );
    case "Edit":
    case "NotebookEdit":
      return (
        <div className="space-y-2">
          <PathRow
            label="Edit"
            path={asString(input.file_path ?? input.notebook_path)}
            extras={
              input.replace_all
                ? "Replace all occurrences"
                : "Replace single match"
            }
          />
          <DiffPreview
            oldStr={asString(input.old_string)}
            newStr={asString(input.new_string)}
          />
        </div>
      );
    case "Bash":
      return (
        <div className="space-y-2">
          {Boolean(input.description) && (
            <p className="text-sm">{asString(input.description)}</p>
          )}
          <CodePreview
            label="Command"
            source={asString(input.command)}
            language="bash"
          />
          {Boolean(input.run_in_background) && (
            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" aria-hidden />
              Runs in background — process keeps going after the dialog
              closes.
            </p>
          )}
        </div>
      );
    case "Glob":
      return (
        <KeyValue
          rows={[
            { label: "Pattern", value: asString(input.pattern) },
            ...(input.path
              ? [{ label: "In folder", value: asString(input.path) }]
              : []),
          ]}
        />
      );
    case "Grep":
      return (
        <KeyValue
          rows={[
            { label: "Pattern", value: asString(input.pattern), mono: true },
            ...(input.path
              ? [{ label: "In", value: asString(input.path) }]
              : []),
            ...(input.glob
              ? [{ label: "File glob", value: asString(input.glob) }]
              : []),
            ...(input.type
              ? [{ label: "File type", value: asString(input.type) }]
              : []),
            ...(input["-i"]
              ? [{ label: "Case", value: "insensitive" }]
              : []),
          ]}
        />
      );
    case "WebFetch":
      return (
        <KeyValue
          rows={[
            { label: "URL", value: asString(input.url) },
            ...(input.prompt
              ? [{ label: "Prompt", value: asString(input.prompt) }]
              : []),
          ]}
        />
      );
    case "WebSearch":
      return (
        <KeyValue
          rows={[{ label: "Query", value: asString(input.query) }]}
        />
      );
    case "Task":
    case "Agent": {
      return (
        <div className="space-y-2">
          <KeyValue
            rows={[
              ...(input.subagent_type
                ? [
                    {
                      label: "Subagent",
                      value: asString(input.subagent_type),
                      mono: true,
                    },
                  ]
                : []),
              ...(input.description
                ? [{ label: "Goal", value: asString(input.description) }]
                : []),
            ]}
          />
          {Boolean(input.prompt) && (
            <CodePreview
              label="Prompt"
              source={asString(input.prompt)}
              language="markdown"
              maxLines={20}
            />
          )}
        </div>
      );
    }
    default:
      // Generic fallback: render a flat key→value table for whatever
      // shape the input has, so the user at least sees something
      // structured even for tools we haven't curated.
      return <GenericInput input={input} />;
  }
}

function PathRow({
  label,
  path,
  extras,
}: {
  label: string;
  path: string;
  extras?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm" title={path}>
        {shortenPath(path)}
      </span>
      {extras && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {extras}
        </span>
      )}
    </div>
  );
}

function KeyValue({
  rows,
}: {
  rows: { label: string; value: string; mono?: boolean }[];
}) {
  if (rows.length === 0) return null;
  return (
    <dl className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <dt className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {r.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 flex-1 break-words",
              r.mono && "font-mono text-[13px]",
            )}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CodePreview({
  label,
  source,
  language,
  maxLines = 16,
}: {
  label: string;
  source: string;
  language?: string;
  maxLines?: number;
}) {
  const lines = source.split("\n");
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines).join("\n") : source;
  return (
    <div className="overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
        <span>{label}</span>
        {language && <span className="font-mono normal-case">{language}</span>}
      </div>
      {/* whitespace-pre-wrap: keep newlines but wrap long lines.
          break-all: even unbroken tokens (URLs, base64, no-space bash)
          wrap inside the dialog instead of overflowing it. */}
      <pre className="max-h-56 overflow-auto p-3 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap">
        {visible}
        {truncated && (
          <span className="block pt-1 text-[11px] italic text-muted-foreground">
            … {lines.length - maxLines} more line
            {lines.length - maxLines === 1 ? "" : "s"}
          </span>
        )}
      </pre>
    </div>
  );
}

function DiffPreview({
  oldStr,
  newStr,
}: {
  oldStr: string;
  newStr: string;
}) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  return (
    <div className="min-w-0 overflow-hidden rounded-md border">
      {/* min-w-0 on each diff column so a long unwrapped line in one
          half doesn't blow out the dialog; the inner divs handle wrap. */}
      <div className="grid min-w-0 grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0 *:min-w-0">
        <div>
          <div className="border-b bg-destructive/10 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase text-destructive">
            − Remove
          </div>
          <pre className="max-h-56 overflow-auto bg-destructive/[0.04] p-2 font-mono text-[12px] leading-relaxed">
            {oldLines.map((l, i) => (
              <div key={i} className="break-all whitespace-pre-wrap">
                <span className="select-none pr-2 text-destructive/70">−</span>
                {l || " "}
              </div>
            ))}
          </pre>
        </div>
        <div>
          <div className="border-b bg-emerald-500/10 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase text-emerald-700 dark:text-emerald-400">
            + Add
          </div>
          <pre className="max-h-56 overflow-auto bg-emerald-500/[0.04] p-2 font-mono text-[12px] leading-relaxed">
            {newLines.map((l, i) => (
              <div key={i} className="break-all whitespace-pre-wrap">
                <span className="select-none pr-2 text-emerald-600/80">+</span>
                {l || " "}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}

function GenericInput({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        Tool was called with no arguments.
      </p>
    );
  }
  return (
    <dl className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="w-32 shrink-0 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {k}
          </dt>
          <dd className="min-w-0 flex-1 break-words font-mono text-[13px]">
            {typeof v === "string" ? v : JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function shortenPath(p: string): string {
  if (!p) return "";
  if (typeof window === "undefined") return p;
  // Best-effort homedir compression: matches /Users/<name>/ or
  // /home/<name>/ and replaces with ~/.
  return p
    .replace(/^\/Users\/[^/]+\//, "~/")
    .replace(/^\/home\/[^/]+\//, "~/");
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
};

function languageFromPath(p: string): string | undefined {
  const m = /\.([^./]+)$/.exec(p);
  if (!m) return undefined;
  return LANG_BY_EXT[m[1].toLowerCase()];
}
