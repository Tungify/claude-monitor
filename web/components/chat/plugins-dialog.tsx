"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Loader2,
  Package,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Plugin shapes mirror the /cli-info?topic=plugins API response. We
// duplicate them here because the route is server-only and re-importing
// the types would drag "server-only" into a client bundle.

interface InstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  scope: "user" | "project";
  version?: string;
  gitCommitSha?: string;
  description?: string;
  capabilities: {
    agents: number;
    skills: number;
    commands: number;
    hooks: number;
    mcpServers: number;
  };
}

interface CatalogPlugin {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  category?: string;
  author?: string;
  homepage?: string;
  installs?: number;
  installed: boolean;
}

interface Marketplace {
  name: string;
  source?: string;
  repo?: string;
  installLocation?: string;
  lastUpdated?: string;
}

interface PluginsResponse {
  plugins: InstalledPlugin[];
  catalog: CatalogPlugin[];
  marketplaces: Marketplace[];
}

type Tab = "discover" | "installed" | "marketplaces";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

// Tracks the in-flight action so a row can render its own spinner +
// disable other rows from firing parallel installs against the same
// account dir (the CLI's settings-write isn't reentrant). Keyed by the
// row's stable identifier so re-renders don't lose the busy state.
interface BusyState {
  key: string;
  label: string;
}

// PluginsDialog mirrors the CLI's /plugin panel: Discover / Installed /
// Marketplaces tabs, search, keyboard navigation, plus install / uninstall
// / marketplace add+remove actions that shell out to the `claude` binary
// against the session's CLAUDE_CONFIG_DIR. We pin the action endpoint to
// the session so multi-account setups land plugins in the right ~/.claude.
export function PluginsDialog({ open, onOpenChange, sessionId }: Props) {
  const [tab, setTab] = useState<Tab>("discover");
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // selectedIndex is scoped per-tab so switching tabs doesn't strand
  // the highlight on a row that no longer exists. Resets to 0 when
  // tabs or queries change.
  const [selectedIndex, setSelectedIndex] = useState(0);
  // One global busy slot — the CLI's settings-write isn't reentrant,
  // so we serialize actions even across rows.
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  // Inline form for adding a marketplace by repo / URL / path.
  const [marketSource, setMarketSource] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // refresh re-fetches the panel data. We expose it via useCallback so
  // the action handler can call it after a successful install/uninstall
  // without re-creating the function on every render.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/chat/${encodeURIComponent(sessionId)}/cli-info?topic=plugins`,
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const body = (await res.json()) as PluginsResponse;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Lazy-load on open. The endpoint is fast (just JSON file reads)
  // but the request still costs a roundtrip — we don't want it firing
  // on every parent re-render.
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

  // Reset transient state when the dialog closes so the next open
  // doesn't briefly flash stale data + the previous query.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelectedIndex(0);
    setTab("discover");
    setMarketSource("");
    setToast(null);
  }, [open]);

  // Auto-dismiss the success/error toast so it doesn't pin to the top
  // of the dialog forever. 4s is long enough to read a one-line message.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(t);
  }, [toast]);

  // Reset highlight whenever the filtered list shape changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [tab, query]);

  // Auto-focus the search field on open so the user can start typing
  // immediately. Refocus on tab change too — keeps the typing flow
  // working across tab switches.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => searchRef.current?.focus());
  }, [open, tab]);

  // doAction posts to /plugins, surfaces a toast on success/failure,
  // and refreshes the panel data so install state flips immediately.
  // We disable all action buttons while one is in flight (busy != null)
  // so the user can't pile up writes against the settings file.
  const doAction = useCallback(
    async (
      body: Record<string, unknown>,
      busyKey: string,
      busyLabel: string,
    ) => {
      if (busy) return;
      setBusy({ key: busyKey, label: busyLabel });
      try {
        const res = await fetch(
          `/api/chat/${encodeURIComponent(sessionId)}/plugins`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          stderr?: string;
          stdout?: string;
        };
        if (!res.ok || !json.ok) {
          // The CLI's own error message lives on stderr; prefer it over
          // the generic "exit code N" wrapper when present.
          const reason =
            (json.stderr ?? "").trim() ||
            json.error ||
            `failed (${res.status})`;
          setToast({ kind: "err", text: firstLine(reason) });
        } else {
          setToast({ kind: "ok", text: `${busyLabel} succeeded` });
          await refresh();
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
    [busy, refresh, sessionId],
  );

  // Build the visible row list for the current tab, filtered by query.
  // We use simple substring matching against name / description /
  // marketplace — fuzzy ranking would be nice but the CLI's prefix
  // match is the pattern users learned, so we mirror it.
  const rows = useMemo(() => {
    if (!data) return [] as Array<DiscoverRow | InstalledRow | MarketplaceRow>;
    const q = query.trim().toLowerCase();
    const match = (s?: string) =>
      s ? s.toLowerCase().includes(q) : false;

    if (tab === "discover") {
      const list: DiscoverRow[] = data.catalog.map((p) => ({
        kind: "discover",
        plugin: p,
      }));
      if (!q) return list;
      return list.filter(
        ({ plugin: p }) =>
          match(p.name) ||
          match(p.description) ||
          match(p.marketplace) ||
          match(p.category),
      );
    }
    if (tab === "installed") {
      const list: InstalledRow[] = data.plugins.map((p) => ({
        kind: "installed",
        plugin: p,
      }));
      if (!q) return list;
      return list.filter(
        ({ plugin: p }) =>
          match(p.name) ||
          match(p.description) ||
          match(p.marketplace),
      );
    }
    const list: MarketplaceRow[] = data.marketplaces.map((m) => ({
      kind: "marketplace",
      marketplace: m,
    }));
    if (!q) return list;
    return list.filter(
      ({ marketplace: m }) => match(m.name) || match(m.repo),
    );
  }, [data, tab, query]);

  // Tab counts shown on the tab bar. Discover floats the total catalog
  // size to mirror the CLI's "(1/163)" header; installed/marketplaces
  // show their own counts so the user knows whether to expect an
  // empty tab before clicking.
  const counts = useMemo(() => {
    if (!data) return { discover: 0, installed: 0, marketplaces: 0 };
    return {
      discover: data.catalog.length,
      installed: data.plugins.length,
      marketplaces: data.marketplaces.length,
    };
  }, [data]);

  // Keep the highlighted row in view on arrow-key navigation. Same
  // pattern the SlashCommandMenu uses — instant scroll feels snappier
  // than smooth for a short list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    if (!item) return;
    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemTop < list.scrollTop) list.scrollTop = itemTop;
    else if (itemBottom > list.scrollTop + list.clientHeight)
      list.scrollTop = itemBottom - list.clientHeight;
  }, [selectedIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % Math.max(rows.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(
        (i) => (i - 1 + rows.length) % Math.max(rows.length, 1),
      );
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const order: Tab[] = ["discover", "installed", "marketplaces"];
      const idx = order.indexOf(tab);
      const next = e.shiftKey
        ? order[(idx - 1 + order.length) % order.length]
        : order[(idx + 1) % order.length];
      setTab(next);
      return;
    }
  };

  // Handler factory for row actions — closes over the action verb and
  // a busy-key derived from the plugin id so each row's spinner is
  // independent visually.
  const installPlugin = (p: CatalogPlugin) =>
    doAction(
      { kind: "install", pluginId: p.id, scope: "user" },
      `install:${p.id}`,
      `Install ${p.name}`,
    );
  const uninstallPlugin = (p: InstalledPlugin) =>
    doAction(
      { kind: "uninstall", pluginId: p.id, scope: p.scope },
      `uninstall:${p.id}@${p.scope}`,
      `Uninstall ${p.name}`,
    );
  const removeMarketplace = (m: Marketplace) =>
    doAction(
      { kind: "marketplace_remove", name: m.name },
      `marketplace_remove:${m.name}`,
      `Remove ${m.name}`,
    );
  const addMarketplaceFromForm = () => {
    const src = marketSource.trim();
    if (!src) return;
    void doAction(
      { kind: "marketplace_add", source: src, scope: "user" },
      `marketplace_add:${src}`,
      `Add ${src}`,
    ).then(() => setMarketSource(""));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={onKeyDown}
        className="flex max-h-[calc(100dvh-1rem)] w-[min(96vw,52rem)] !max-w-[min(96vw,52rem)] flex-col gap-3 overflow-hidden p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-4"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Package className="size-4" />
            Plugins
          </DialogTitle>
          <DialogDescription className="pr-8">
            Browse and install Claude Code plugins from configured
            marketplaces. Actions run via the local{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              claude plugin
            </code>{" "}
            binary against this session&apos;s account directory.
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

        {/* Tab bar — mirrors the CLI's "Plugins · Discover · Installed
            · Marketplaces · Errors" row. We drop Errors for now (rare,
            needs separate data) but keep the same ordering for muscle
            memory across CLI and orchestrator. */}
        <div className="-mx-1 flex items-center gap-1 border-b px-1">
          <TabButton
            label="Discover"
            count={counts.discover}
            active={tab === "discover"}
            onClick={() => setTab("discover")}
          />
          <TabButton
            label="Installed"
            count={counts.installed}
            active={tab === "installed"}
            onClick={() => setTab("installed")}
          />
          <TabButton
            label="Marketplaces"
            count={counts.marketplaces}
            active={tab === "marketplaces"}
            onClick={() => setTab("marketplaces")}
          />
        </div>

        {/* Add-marketplace form — shown only on the Marketplaces tab so
            it doesn't clutter Discover/Installed. The CLI uses a guided
            wizard here, but a single input is enough for the common case
            (paste an org/repo or a git URL). */}
        {tab === "marketplaces" && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={marketSource}
              onChange={(e) => setMarketSource(e.target.value)}
              placeholder="owner/repo, https://… or local path"
              className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMarketplaceFromForm();
                }
              }}
              disabled={!!busy}
            />
            <button
              type="button"
              onClick={addMarketplaceFromForm}
              disabled={!marketSource.trim() || !!busy}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy?.key.startsWith("marketplace_add:") ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Add
            </button>
          </div>
        )}

        {/* Search — disabled on marketplaces tab because filtering 2
            entries by substring is silly; still rendered so the chrome
            doesn't shift between tab switches. */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "marketplaces"
                ? "Search marketplaces…"
                : "Search plugins…"
            }
            className="w-full rounded-md border bg-background py-1.5 pl-8 pr-7 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* List body */}
        <div
          ref={listRef}
          className="-mx-1 flex-1 overflow-y-auto rounded-md"
        >
          {loading && !data && (
            <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading
              plugins…
            </div>
          )}
          {error && (
            <div className="px-3 py-8 text-sm text-destructive">
              Failed to load plugins: {error}
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <EmptyTab tab={tab} hasQuery={!!query.trim()} />
          )}
          {!error &&
            rows.map((r, i) => (
              <PluginRow
                key={r.kind === "marketplace" ? r.marketplace.name : r.plugin.id}
                row={r}
                active={i === selectedIndex}
                onHover={() => setSelectedIndex(i)}
                busy={busy}
                onInstall={installPlugin}
                onUninstall={uninstallPlugin}
                onRemoveMarketplace={removeMarketplace}
              />
            ))}
        </div>

        {/* Keyboard hint row */}
        <div className="-mb-1 -mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
          ↑↓ navigate · Tab switch section · Type to search · Esc close
        </div>
      </DialogContent>
    </Dialog>
  );
}

type DiscoverRow = { kind: "discover"; plugin: CatalogPlugin };
type InstalledRow = { kind: "installed"; plugin: InstalledPlugin };
type MarketplaceRow = { kind: "marketplace"; marketplace: Marketplace };

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative rounded-t-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted font-semibold text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {label}
      <span className="ml-1.5 text-[11px] text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function EmptyTab({ tab, hasQuery }: { tab: Tab; hasQuery: boolean }) {
  if (hasQuery) {
    return (
      <div className="px-3 py-8 text-center text-sm text-muted-foreground">
        No matches.
      </div>
    );
  }
  const messages: Record<Tab, string> = {
    discover:
      "No plugins available. Add a marketplace on the Marketplaces tab.",
    installed:
      "No plugins installed. Use the Discover tab to install one.",
    marketplaces:
      "No marketplaces configured. Default is `anthropics/claude-plugins-official`.",
  };
  return (
    <div className="px-3 py-8 text-center text-sm text-muted-foreground">
      {messages[tab]}
    </div>
  );
}

function PluginRow({
  row,
  active,
  onHover,
  busy,
  onInstall,
  onUninstall,
  onRemoveMarketplace,
}: {
  row: DiscoverRow | InstalledRow | MarketplaceRow;
  active: boolean;
  onHover: () => void;
  busy: BusyState | null;
  onInstall: (p: CatalogPlugin) => void;
  onUninstall: (p: InstalledPlugin) => void;
  onRemoveMarketplace: (m: Marketplace) => void;
}) {
  if (row.kind === "marketplace") {
    const m = row.marketplace;
    const busyKey = `marketplace_remove:${m.name}`;
    const isBusy = busy?.key === busyKey;
    return (
      <div
        onMouseEnter={onHover}
        className={cn(
          "group flex items-start gap-2 border-l-2 px-3 py-2 transition-colors",
          active
            ? "border-primary bg-muted"
            : "border-transparent hover:bg-muted/60",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{m.name}</span>
            {m.repo && (
              <span className="font-mono text-xs text-muted-foreground">
                {m.repo}
              </span>
            )}
          </div>
          {m.lastUpdated && (
            <div className="text-[11px] text-muted-foreground">
              Updated{" "}
              {new Date(m.lastUpdated).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </div>
          )}
        </div>
        <ActionButton
          onClick={() => onRemoveMarketplace(m)}
          disabled={!!busy}
          busy={isBusy}
          icon={<Trash2 className="size-3" />}
          label="Remove"
          variant="ghost"
        />
      </div>
    );
  }

  if (row.kind === "installed") {
    const p = row.plugin;
    const caps: string[] = [];
    if (p.capabilities.agents)
      caps.push(`${p.capabilities.agents} agent${p.capabilities.agents === 1 ? "" : "s"}`);
    if (p.capabilities.skills)
      caps.push(`${p.capabilities.skills} skill${p.capabilities.skills === 1 ? "" : "s"}`);
    if (p.capabilities.commands)
      caps.push(`${p.capabilities.commands} command${p.capabilities.commands === 1 ? "" : "s"}`);
    if (p.capabilities.hooks)
      caps.push(`${p.capabilities.hooks} hook${p.capabilities.hooks === 1 ? "" : "s"}`);
    if (p.capabilities.mcpServers)
      caps.push(`${p.capabilities.mcpServers} mcp`);
    const busyKey = `uninstall:${p.id}@${p.scope}`;
    const isBusy = busy?.key === busyKey;
    return (
      <div
        onMouseEnter={onHover}
        className={cn(
          "group flex items-start gap-2 border-l-2 px-3 py-2 transition-colors",
          active
            ? "border-primary bg-muted"
            : "border-transparent hover:bg-muted/60",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
            <span className="text-sm font-semibold">{p.name}</span>
            <span className="text-xs text-muted-foreground">
              · {p.marketplace}
            </span>
            {p.version && (
              <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                v{p.version}
              </span>
            )}
            {p.scope === "project" && (
              <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                project
              </span>
            )}
          </div>
          {caps.length > 0 && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {caps.join(" · ")}
            </div>
          )}
          {p.description && (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {p.description}
            </div>
          )}
        </div>
        <ActionButton
          onClick={() => onUninstall(p)}
          disabled={!!busy}
          busy={isBusy}
          icon={<Trash2 className="size-3" />}
          label="Uninstall"
          variant="ghost"
        />
      </div>
    );
  }

  // Discover row
  const p = row.plugin;
  const busyKey = `install:${p.id}`;
  const isBusy = busy?.key === busyKey;
  return (
    <div
      onMouseEnter={onHover}
      className={cn(
        "group flex items-start gap-2 border-l-2 px-3 py-2 transition-colors",
        active
          ? "border-primary bg-muted"
          : "border-transparent hover:bg-muted/60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {p.installed ? (
            <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
          ) : (
            <span className="size-3 shrink-0 rounded-full border border-muted-foreground/40" />
          )}
          <span className="text-sm font-semibold">{p.name}</span>
          <span className="text-xs text-muted-foreground">
            · {p.marketplace}
          </span>
          {typeof p.installs === "number" && (
            <span className="ml-1 text-[11px] text-muted-foreground">
              {formatInstallCount(p.installs)} installs
            </span>
          )}
        </div>
        {p.description && (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {p.description}
          </div>
        )}
      </div>
      {p.installed ? (
        <span className="rounded bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
          Installed
        </span>
      ) : (
        <ActionButton
          onClick={() => onInstall(p)}
          disabled={!!busy}
          busy={isBusy}
          icon={<Download className="size-3" />}
          label="Install"
          variant="primary"
        />
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  busy,
  icon,
  label,
  variant,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  icon: React.ReactNode;
  label: string;
  variant: "primary" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
        variant === "primary"
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : icon}
      {label}
    </button>
  );
}

// firstLine takes a multi-line CLI error and returns the most useful
// chunk to show in a toast. The CLI's plugin commands often print a
// stack-trace tail under a one-line summary; we prefer the summary.
function firstLine(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "Action failed";
  const first = trimmed.split("\n", 1)[0]!.trim();
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}

// Compact install-count display: 640940 → "640.9K", 1234567 → "1.2M".
// Matches what the CLI screenshot shows so the magnitudes feel
// familiar to a user switching between the two views.
function formatInstallCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
