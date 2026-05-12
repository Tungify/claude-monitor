"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { reloginAccount } from "@/lib/daemon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { DbMcpSection } from "./db-mcp-section";
import { IntegrationsSection } from "./integrations-section";

// MCPServer mirrors the /cli-info?topic=mcp shape. We don't import from
// the server-only module — the type is small enough to duplicate.
interface MCPServer {
  name: string;
  scope: string;
  type?: string;
  target?: string;
  authStatus?: "ready" | "needs_auth";
  // claude.ai connector ID (mcprs_…); used to build the per-connector
  // auth deep-link.
  id?: string;
}

interface McpResponse {
  servers: MCPServer[];
  claudeAiNeedsAuth?: boolean;
  // OAuth account organization UUID, required to deep-link to a
  // specific claude.ai connector's auth flow.
  organizationUuid?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  // Display name of the account (for the banner heading) and an
  // unambiguous identifier the daemon can resolve. We prefer
  // configDirIdent because `account_name` can be "default" (Codex's
  // ~/.codex shorthand) or otherwise non-matchable by the daemon's
  // snapshot lookup — config_dir is always unique.
  accountName?: string;
  configDirIdent?: string;
}

type Scope = "local" | "user" | "project";
type Transport = "stdio" | "sse" | "http";

// Scope order matches the CLI's MCP panel: builtin first (orchestrator
// tools, always available), then file-scoped registrations, then the
// claude.ai dynamic integrations.
const SCOPE_ORDER = [
  "builtin",
  "project",
  "user",
  "local",
  "enterprise",
  "dynamic",
  "claudeai",
];
const SCOPE_LABEL: Record<string, string> = {
  builtin: "Built-in",
  project: "Project",
  user: "User",
  local: "Local",
  enterprise: "Enterprise",
  dynamic: "Dynamic",
  claudeai: "claude.ai integrations",
};

// MCPDialog mirrors the CLI's /mcp panel with action surface added.
// Servers are listed grouped by scope; each row exposes "View tools"
// (claude mcp get) and "Remove" (claude mcp remove). claude.ai
// integrations get a "Re-authenticate" hint that opens the integrations
// settings page rather than re-implementing the OAuth dance.
//
// Add form supports stdio (command + args + env) and remote (SSE /
// streamable HTTP with optional auth headers). Anything more exotic
// — OAuth-registered clients, JSON import — keeps the user on a
// terminal.
export function McpDialog({
  open,
  onOpenChange,
  sessionId,
  accountName,
  configDirIdent,
}: Props) {
  const [data, setData] = useState<McpResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ key: string; label: string } | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const [details, setDetails] = useState<{
    name: string;
    body: string;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/chat/${encodeURIComponent(sessionId)}/cli-info?topic=mcp`,
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const body = (await res.json()) as McpResponse;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      await refresh();
      if (cancelled) setData(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refresh]);

  // Reset transient state on close so the next open feels clean.
  // The cascading-render concern doesn't apply here because these
  // resets only fire on dialog close — nothing's rendered against
  // the stale state at that moment.
  useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToast(null);
    setDetails(null);
    setAddOpen(false);
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(t);
  }, [toast]);

  // doAction posts to /mcp; busyKey lets one row's spinner render
  // independently while the global lock still serializes writes (the
  // CLI's settings-write isn't reentrant, same constraint as plugins).
  const doAction = useCallback(
    async (
      body: Record<string, unknown>,
      busyKey: string,
      busyLabel: string,
      onOk?: (resp: { stdout: string; stderr: string }) => void,
    ) => {
      if (busy) return;
      setBusy({ key: busyKey, label: busyLabel });
      try {
        const res = await fetch(
          `/api/chat/${encodeURIComponent(sessionId)}/mcp`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          stdout?: string;
          stderr?: string;
        };
        if (!res.ok || !json.ok) {
          const reason =
            (json.stderr ?? "").trim() ||
            json.error ||
            `failed (${res.status})`;
          setToast({ kind: "err", text: firstLine(reason) });
        } else {
          onOk?.({ stdout: json.stdout ?? "", stderr: json.stderr ?? "" });
          setToast({ kind: "ok", text: `${busyLabel} succeeded` });
        }
      } catch (err) {
        setToast({
          kind: "err",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [busy, sessionId],
  );

  const viewTools = (s: MCPServer) =>
    doAction(
      { kind: "details", name: s.name },
      `details:${s.name}`,
      `Inspect ${s.name}`,
      ({ stdout }) => {
        // `claude mcp get` is allowed to print to stderr too (the
        // "skipped trust dialog" notice goes there) — the body the
        // user cares about is stdout. Fall back to stderr if stdout
        // is empty so we still show something.
        setDetails({ name: s.name, body: stdout.trim() || "_(no output)_" });
      },
    );

  const removeServer = (s: MCPServer) => {
    if (!confirm(`Remove MCP server "${s.name}"? This is reversible only by re-adding.`)) return;
    void doAction(
      { kind: "remove", name: s.name, scope: s.scope },
      `remove:${s.name}`,
      `Remove ${s.name}`,
      () => void refresh(),
    );
  };

  const grouped = useMemo(() => {
    const out = new Map<string, MCPServer[]>();
    for (const s of data?.servers ?? []) {
      const list = out.get(s.scope) ?? [];
      list.push(s);
      out.set(s.scope, list);
    }
    return out;
  }, [data]);

  const ordered = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<[string, MCPServer[]]> = [];
    for (const scope of SCOPE_ORDER) {
      const list = grouped.get(scope);
      if (list && list.length > 0) {
        out.push([scope, list]);
        seen.add(scope);
      }
    }
    for (const [scope, list] of grouped) {
      if (!seen.has(scope)) out.push([scope, list]);
    }
    return out;
  }, [grouped]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[min(96vw,52rem)] !max-w-[min(96vw,52rem)] flex-col gap-3 overflow-hidden p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Plug className="size-4" />
            MCP servers
          </DialogTitle>
          <DialogDescription className="pr-8">
            Manage MCP servers visible to this chat session. Actions run via
            the local <code className="rounded bg-muted px-1 py-0.5 text-[11px]">claude mcp</code> binary against{" "}
            this session&apos;s account config directory.
          </DialogDescription>
        </DialogHeader>

        {toast && (
          <div
            className={cn(
              "rounded-md px-3 py-2 text-xs",
              toast.kind === "ok"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {toast.text}
          </div>
        )}

        {data?.claudeAiNeedsAuth && (
          <ReloginBanner
            ident={configDirIdent ?? accountName}
            onError={(msg) => setToast({ kind: "err", text: msg })}
            onLaunched={() =>
              setToast({
                kind: "ok",
                text: "Opened Terminal — finish `claude auth login` there, then refresh.",
              })
            }
          />
        )}

        {/* Database integrations live above the generic MCP server
            list because they're the most common reason a user opens
            this dialog from a query session. */}
        <DbMcpSection />

        {/* Service integrations (Slack, …) sit below DB because most
            sessions in this app are code/DB work — putting service
            connectors above would push the more common surface below
            the fold on small dialogs. */}
        <IntegrationsSection />

        {/* Add-server toggle. Collapsed by default so the list isn't
            pushed below the fold on small dialogs. */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {addOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <Plus className="size-3" />
            Add server
          </button>
          <span className="text-[11px] text-muted-foreground">
            {data
              ? `${data.servers.length} total · ${ordered.length} scope${ordered.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>

        {addOpen && (
          <AddServerForm
            busy={busy}
            onAdd={(body) =>
              doAction(body, `add:${String(body.name)}`, `Add ${String(body.name)}`, () => {
                setAddOpen(false);
                void refresh();
              })
            }
          />
        )}

        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md">
          {loading && !data && (
            <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading MCP servers…
            </div>
          )}
          {error && (
            <div className="px-3 py-8 text-sm text-destructive">
              Failed to load MCP servers: {error}
            </div>
          )}
          {!loading && !error && ordered.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No MCP servers configured. Use{" "}
              <span className="font-mono">Add server</span> above to wire one
              up.
            </div>
          )}
          {ordered.map(([scope, list]) => (
            <div key={scope} className="mb-3 min-w-0">
              <div className="sticky top-0 z-10 bg-background/95 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                {SCOPE_LABEL[scope] ?? scope.toUpperCase()}{" "}
                <span className="ml-1 text-muted-foreground/70">({list.length})</span>
              </div>
              {list.map((s) => (
                <McpRow
                  key={`${s.scope}:${s.name}`}
                  server={s}
                  busy={busy}
                  organizationUuid={data?.organizationUuid}
                  onViewTools={viewTools}
                  onRemove={removeServer}
                />
              ))}
            </div>
          ))}
        </div>

        {details && (
          <DetailsOverlay
            title={details.name}
            body={details.body}
            onClose={() => setDetails(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReloginBanner({
  ident,
  onError,
  onLaunched,
}: {
  // Anything the daemon can resolve against snapshot.Accounts: either
  // the account.Name (stripped-dot dir basename) or the absolute
  // config_dir. We prefer config_dir at the call site because
  // account_name can collide ("default" for Codex's ~/.codex slot)
  // and Anthropic's default ~/.claude resolves to name="claude", not
  // "default" — the daemon would 404 on either.
  ident?: string;
  onError: (msg: string) => void;
  onLaunched: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const relogin = async () => {
    if (!ident) {
      onError("No account bound to this session.");
      return;
    }
    setBusy(true);
    try {
      // Daemon spawns Terminal.app running `claude auth login` for
      // this account. The OAuth dance happens in the terminal/browser;
      // the orchestrator's next refresh picks up the new creds.
      const res = await reloginAccount(ident);
      if (!res.ok) throw new Error("daemon returned ok=false");
      onLaunched();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Your claude.ai login is missing the{" "}
        <code className="rounded bg-amber-500/20 px-1 py-0.5">
          user:mcp_servers
        </code>{" "}
        scope, so the claude.ai integrations all read as &ldquo;needs
        authentication.&rdquo; Re-login this account to refresh the scope —{" "}
        the daemon will open Terminal with{" "}
        <code className="rounded bg-amber-500/20 px-1 py-0.5">
          claude auth login
        </code>
        .
      </span>
      <button
        type="button"
        onClick={() => void relogin()}
        disabled={busy || !ident}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
      >
        {busy ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <KeyRound className="size-3" />
        )}
        Re-login{ident ? " account" : ""}
      </button>
    </div>
  );
}

function McpRow({
  server,
  busy,
  organizationUuid,
  onViewTools,
  onRemove,
}: {
  server: MCPServer;
  busy: { key: string; label: string } | null;
  organizationUuid?: string;
  onViewTools: (s: MCPServer) => void;
  onRemove: (s: MCPServer) => void;
}) {
  const isBuiltin = server.scope === "builtin";
  const isClaudeAi = server.scope === "claudeai";
  const needsAuth = server.authStatus === "needs_auth";
  // Per-connector auth deep-link mirrors Claude Code's
  // MCPRemoteServerMenu: `claude.ai/api/organizations/<uuid>/mcp/
  // start-auth/<serverId>?product_surface=cli`. The serverId carries
  // an `mcprs_…` prefix from the listing API; the auth endpoint wants
  // it rewritten to `mcpsrv_…`. When we lack either the org uuid or
  // the connector id, we fall back to the generic management page so
  // clicking still lands the user somewhere useful.
  const claudeAiAuthUrl =
    isClaudeAi && server.id && organizationUuid
      ? `https://claude.ai/api/organizations/${encodeURIComponent(
          organizationUuid,
        )}/mcp/start-auth/${encodeURIComponent(
          server.id.startsWith("mcprs") ? `mcpsrv${server.id.slice(5)}` : server.id,
        )}?product_surface=cli`
      : isClaudeAi
        ? "https://claude.ai/settings/connectors"
        : null;

  return (
    <div className="group flex items-start gap-2 border-l-2 border-transparent px-3 py-2 transition-colors hover:bg-muted/60">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-sm font-semibold">{server.name}</span>
          {server.type && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {server.type}
            </span>
          )}
          {needsAuth && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              <ShieldAlert className="size-3" /> needs authentication
            </span>
          )}
        </div>
        {server.target && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {server.target}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!isBuiltin && !isClaudeAi && (
          <RowButton
            label="View tools"
            icon={<Eye className="size-3" />}
            busy={busy?.key === `details:${server.name}`}
            disabled={!!busy}
            onClick={() => onViewTools(server)}
          />
        )}
        {isClaudeAi && claudeAiAuthUrl && (
          <a
            href={claudeAiAuthUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium hover:bg-muted"
            title={
              server.id && organizationUuid
                ? "Open this connector's OAuth flow on claude.ai"
                : "Open claude.ai's connector management page"
            }
          >
            {needsAuth ? (
              <KeyRound className="size-3" />
            ) : (
              <ExternalLink className="size-3" />
            )}
            {needsAuth ? "Authenticate" : "Manage"}
          </a>
        )}
        {!isBuiltin && !isClaudeAi && (
          <RowButton
            label="Remove"
            icon={<Trash2 className="size-3" />}
            busy={busy?.key === `remove:${server.name}`}
            disabled={!!busy}
            destructive
            onClick={() => onRemove(server)}
          />
        )}
      </div>
    </div>
  );
}

function RowButton({
  label,
  icon,
  busy,
  disabled,
  destructive,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  busy: boolean;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
        destructive
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-muted",
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : icon}
      {label}
    </button>
  );
}

function DetailsOverlay({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Eye className="size-3.5" />
          {title}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close details"
        >
          <X className="size-4" />
        </button>
      </div>
      <pre
        onClick={(e) => e.stopPropagation()}
        className="flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-foreground"
      >
        {body}
      </pre>
    </div>
  );
}

// AddServerForm groups the two CLI shapes (`claude mcp add` for stdio,
// `--transport sse|http` for remote) under one toggleable form. We
// keep advanced bits like OAuth client IDs out — the user can drop
// to a terminal for those.
function AddServerForm({
  busy,
  onAdd,
}: {
  busy: { key: string; label: string } | null;
  onAdd: (body: Record<string, unknown>) => void;
}) {
  const [transport, setTransport] = useState<Transport>("stdio");
  const [scope, setScope] = useState<Scope>("local");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [headerText, setHeaderText] = useState("");

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (transport === "stdio") {
      if (!command.trim()) return;
      onAdd({
        kind: "add_stdio",
        name: trimmedName,
        command: command.trim(),
        args: parseArgsLine(args),
        env: parseKvLines(envText),
        scope,
      });
    } else {
      if (!url.trim()) return;
      onAdd({
        kind: "add_remote",
        transport,
        name: trimmedName,
        url: url.trim(),
        headers: parseKvLines(headerText),
        scope,
      });
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </Field>
        <Field label="Transport">
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="stdio">stdio (subprocess)</option>
            <option value="http">http (streamable)</option>
            <option value="sse">sse</option>
          </select>
        </Field>
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="local">local (this config dir)</option>
            <option value="user">user</option>
            <option value="project">project (.mcp.json)</option>
          </select>
        </Field>
      </div>

      {transport === "stdio" ? (
        <>
          <Field label="Command" className="mt-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
          <Field label="Args (space-separated)" className="mt-2">
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @scope/package"
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
          <Field label="Environment (KEY=value per line)" className="mt-2">
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={2}
              placeholder="API_KEY=…"
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" className="mt-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
          <Field label="Headers (Name: value per line)" className="mt-2">
            <textarea
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              rows={2}
              placeholder="Authorization: Bearer …"
              className="w-full resize-y rounded-md border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </Field>
        </>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={
            !!busy ||
            !name.trim() ||
            (transport === "stdio" ? !command.trim() : !url.trim())
          }
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy?.key.startsWith("add:") ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Plus className="size-3" />
          )}
          Add server
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

// Crude args parser: splits on whitespace, respecting double-quoted
// substrings. Good enough for the common npx/uvx pattern; users with
// truly hairy args can drop to a terminal.
function parseArgsLine(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? m[1] : (m[2] ?? ""));
  }
  return out;
}

// Each non-empty line is KEY=value (for env) or "Header: value" (for
// http headers). We auto-detect by splitter — first '=' wins for env,
// first ':' wins for headers. Lines without the splitter are dropped
// silently to avoid the CLI rejecting a half-typed entry.
function parseKvLines(s: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of s.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Prefer '=' (env), fall back to ':' (header).
    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    let key = "";
    let value = "";
    if (eq !== -1 && (colon === -1 || eq < colon)) {
      key = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
    } else if (colon !== -1) {
      key = line.slice(0, colon).trim();
      value = line.slice(colon + 1).trim();
    } else {
      continue;
    }
    if (key) out.push({ key, value });
  }
  return out;
}

function firstLine(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "Action failed";
  const first = trimmed.split("\n", 1)[0]!.trim();
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}
