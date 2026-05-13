"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Timer,
} from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import {
  addAccount,
  fetchSwapConfig,
  reloginAccount,
  swapTo,
  updateSwapConfig,
  type AccountState,
  type SwapConfig,
  type Window,
} from "@/lib/daemon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress, quotaTone } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ConnectionStatus } from "@/hooks/use-daemon";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "busy"; ident: string; what: "swap" | "relogin" };

// AccountsDialog is the rebuild of the previous full-page Dashboard.
// Each account renders as a card so name/status/swap-button stay on one
// line and the two util bars (5h, weekly) get full row width below — the
// earlier 3-column row collided once status badges grew (long error text
// like "refresh rate limited (retry in 1m49s)" overlapped util columns).
export function AccountsDialog({ open, onOpenChange }: Props) {
  const { snapshot, swapEvents, errors, status } = useDaemonContext();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Tick every second so countdown labels ("resets in 1h 30m") stay live
  // while the dialog is open. The daemon snapshot itself only refreshes
  // every ~5s; this hook is what makes the seconds visibly tick down.
  const now = useNowTick(open ? 1000 : null);

  const onSwap = (ident: string) => {
    setAction({ kind: "busy", ident, what: "swap" });
    setActionErr(null);
    startTransition(async () => {
      try {
        await swapTo(ident);
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAction({ kind: "idle" });
      }
    });
  };

  const onRelogin = (ident: string) => {
    setAction({ kind: "busy", ident, what: "relogin" });
    setActionErr(null);
    startTransition(async () => {
      try {
        await reloginAccount(ident);
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAction({ kind: "idle" });
      }
    });
  };

  const accounts = snapshot?.accounts ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Cap the dialog inside the dynamic viewport so phone users
        // can scroll the whole stack (account list + LAN section +
        // activity log) instead of having tail content clipped off
        // the bottom edge. p-3 on mobile gives the dense inner
        // content a touch more breathing room.
        className="max-h-[calc(100dvh-1rem)] max-w-3xl gap-3 overflow-y-auto p-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:max-w-3xl sm:gap-4 sm:p-4"
      >
        <DialogHeader>
          {/* pr-8 keeps the dialog's absolute close-X (top-right) from
              overlapping the description. We split title + description
              vertically rather than flexing them into the close zone. */}
          <DialogTitle className="pr-8">Accounts</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8">
            <span>
              {accounts.length} account{accounts.length === 1 ? "" : "s"} ·
              managed by claude-monitor
            </span>
            <ConnectionPill
              status={status}
              fetchedAt={snapshot?.fetched_at}
              now={now}
            />
          </DialogDescription>
        </DialogHeader>

        {actionErr && (
          <Alert variant="destructive">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{actionErr}</AlertDescription>
          </Alert>
        )}

        {adding ? (
          <AddAccountForm
            onClose={() => setAdding(false)}
            onError={(msg) => setActionErr(msg)}
          />
        ) : (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              <Plus className="mr-1 size-3.5" />
              Add account
            </Button>
          </div>
        )}

        <div className="space-y-2 sm:max-h-[55vh] sm:overflow-y-auto sm:pr-1">
          {accounts.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              {status === "connecting"
                ? "Connecting to daemon…"
                : status === "error"
                  ? "Daemon unreachable. Run `claude-monitor --serve 127.0.0.1:8788`."
                  : "No accounts yet."}
            </div>
          ) : (
            accounts.map((a) => {
              const busy =
                pending &&
                action.kind === "busy" &&
                action.ident === a.name;
              return (
                <AccountCard
                  key={a.config_dir}
                  account={a}
                  busy={busy}
                  busyKind={busy ? action.what : undefined}
                  now={now}
                  onSwap={() => onSwap(a.name)}
                  onRelogin={() => onRelogin(a.name)}
                />
              );
            })
          )}
        </div>

        <SwapSettingsSection open={open} />

        {(swapEvents.length > 0 || errors.length > 0) && (
          <section className="space-y-1.5">
            <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              Recent activity
            </h3>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
              {swapEvents.map((e, i) => (
                <li key={`s${i}`} className="text-muted-foreground">
                  <span className="font-mono text-[10px]">swap</span>{" "}
                  {e.from_name} ({pct(e.from_util)}) → {e.to_name} (
                  {pct(e.to_util)}) ·{" "}
                  <span className="italic">{e.reason}</span>
                </li>
              ))}
              {errors.map((e, i) => (
                <li key={`e${i}`} className="text-destructive">
                  <span className="font-mono text-[10px]">error</span>{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountCard({
  account,
  busy,
  busyKind,
  now,
  onSwap,
  onRelogin,
}: {
  account: AccountState;
  busy: boolean;
  busyKind?: "swap" | "relogin";
  now: number;
  onSwap: () => void;
  onRelogin: () => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        account.active ? "border-primary/30 bg-primary/[0.03]" : "bg-card"
      }`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
          {account.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 basis-[60%]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.name}</span>
            <ProviderBadge a={account} />
            {!account.error && <ShortStatus a={account} />}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {account.email ?? "—"}
          </div>
        </div>
        {/* Buttons sit beside name/email on wide cards. On phones the
            flex-wrap above pushes them to a second row that takes the
            full card width, where they share space without crowding
            the email out of the picture. */}
        <div className="flex w-full shrink-0 justify-end gap-1 sm:w-auto">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onRelogin}
            title="Reopen `claude auth login` for this account in Terminal"
          >
            {busy && busyKind === "relogin" ? "Opening…" : "Relogin"}
          </Button>
          {!account.active && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onSwap}
            >
              {busy && busyKind === "swap" ? "Swapping…" : "Swap to"}
            </Button>
          )}
        </div>
      </div>
      {/* Long error strings ("refresh rate limited (retry in 2m29s)")
          get their own row so they don't wrap mid-card and push the
          action buttons into a weird offset. */}
      {account.error && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          title={account.error}
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{account.error}</span>
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <UtilBlock label="5h session" w={account.five_hour} now={now} />
        <UtilBlock label="weekly" w={account.weekly} now={now} />
      </div>
    </div>
  );
}

function AddAccountForm({
  onClose,
  onError,
}: {
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await addAccount({
        name: name.trim(),
        // codex ignores --email (its OAuth provider picks the account
        // interactively), but we still pass it so the Anthropic path
        // behavior is unchanged when the user starts typing then flips
        // provider.
        email: email.trim() || undefined,
        provider,
      });
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // dirHint mirrors the per-provider provisioning paths the daemon's
  // login.handleAccountAdd uses: ~/.claude-<name> for Anthropic vs
  // ~/.codex-<name> for Codex. Surfacing the real path makes it obvious
  // which terminal command to expect.
  const dirHint =
    provider === "openai"
      ? `~/.codex-${name || "<name>"}`
      : `~/.claude-${name || "<name>"}`;
  const loginCmd =
    provider === "openai" ? "codex login" : "claude auth login";

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        New account
      </div>
      {/* Provider tabs span the form width so the user sees both
          choices as the first decision in the flow — earlier this was
          a small segmented control in the header and people missed
          that Codex was even an option. */}
      <ProviderTabs value={provider} onChange={setProvider} />
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="short name (a-Z, 0-9, .-_)"
          className="rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={
            provider === "openai"
              ? "email (ignored — codex picks interactively)"
              : "email (optional)"
          }
          disabled={provider === "openai"}
          className="rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Provisions {dirHint} and opens Terminal for `{loginCmd}`.
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
            {submitting ? "Opening…" : "Create & login"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ProviderTabs is the full-width segmented control at the top of the
// add-account form. Two-tab layout — each tab gets equal width so the
// inactive Codex option is just as visually weighty as Claude. The
// active tab uses the primary fill so the choice is obvious, and a
// small caption underneath each label clarifies the provisioning
// behavior so users don't have to read the hint line to know what
// they're picking.
function ProviderTabs({
  value,
  onChange,
}: {
  value: "anthropic" | "openai";
  onChange: (v: "anthropic" | "openai") => void;
}) {
  const tabs: Array<{
    id: "anthropic" | "openai";
    label: string;
    caption: string;
  }> = [
    {
      id: "anthropic",
      label: "Claude",
      caption: "Anthropic · claude auth login",
    },
    {
      id: "openai",
      label: "Codex",
      caption: "ChatGPT · codex login",
    },
  ];
  return (
    <div
      role="tablist"
      aria-label="Account provider"
      className="grid grid-cols-2 gap-1.5"
    >
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`rounded-md border px-3 py-2 text-left transition-colors ${
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted/60"
            }`}
          >
            <div className="text-xs font-medium">{t.label}</div>
            <div className="text-[10px] text-muted-foreground">{t.caption}</div>
          </button>
        );
      })}
    </div>
  );
}

function UtilBlock({
  label,
  w,
  now,
}: {
  label: string;
  w?: Window;
  now: number;
}) {
  if (!w) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{label}</span>
          <span>—</span>
        </div>
        <Progress value={0} className="h-1.5" />
      </div>
    );
  }
  const v = Math.round(w.utilization);
  const reset = formatResetCountdown(w.resets_at, now);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{v}%</span>
      </div>
      <Progress
        value={Math.min(v, 100)}
        className="h-1.5"
        indicatorClassName={quotaTone(v)}
      />
      {/* Reset hint sits right under the bar so the eye reads:
          label · % → progress → "resets in 1h 30m". Title attr keeps the
          full ISO timestamp accessible on hover for power users. */}
      {reset && (
        <div
          className="flex items-center gap-1 text-[10px] text-muted-foreground/90"
          title={w.resets_at ?? undefined}
        >
          <Timer className="size-3" aria-hidden />
          <span className="tabular-nums">{reset}</span>
        </div>
      )}
    </div>
  );
}

// ShortStatus only renders the inline-safe states (active / kicked /
// idle). The error case is handled separately as a full-width strip
// below the row, since long messages used to wrap and break layout.
function ShortStatus({ a }: { a: AccountState }) {
  if (a.kicked) return <Badge variant="outline">kicked</Badge>;
  if (a.active) return <Badge>active</Badge>;
  return <Badge variant="secondary">idle</Badge>;
}

// ProviderBadge labels each row with its backend so users can tell
// Claude rows from Codex rows at a glance. Anthropic rows get a
// minimal "claude" tag; Codex rows fold in the ChatGPT plan tier
// (`codex:pro`, `codex:team`, …) because the plan is the user's
// primary mental model — "is this my Pro account or my Plus one?".
// The provider field on AccountState is optional/empty for older
// daemons; we treat missing as Anthropic per the AccountProvider doc.
function ProviderBadge({ a }: { a: AccountState }) {
  if (a.provider === "openai") {
    const label = a.plan_type ? `codex:${a.plan_type}` : "codex";
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
      >
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px]">
      claude
    </Badge>
  );
}

function ConnectionPill({
  status,
  fetchedAt,
  now,
}: {
  status: ConnectionStatus;
  fetchedAt?: string;
  now: number;
}) {
  const dot =
    status === "open"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500"
        : "bg-destructive";
  const age = fetchedAt ? formatAge(fetchedAt, now) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={`inline-block size-1.5 rounded-full ${dot}`}
        aria-hidden
      />
      <span className="capitalize">{status}</span>
      {fetchedAt && (
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          title={`Snapshot fetched at ${new Date(fetchedAt).toLocaleString()}`}
        >
          <RefreshCw className="size-3" aria-hidden />
          <span>refreshed {age}</span>
        </span>
      )}
    </span>
  );
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

// formatResetCountdown turns an OAuth-quota reset timestamp into a
// human-readable countdown. Negative deltas (already passed) read as
// "resets now" so the user sees that the daemon hasn't ticked yet —
// distinct from the missing-data case (handled by the empty UtilBlock).
function formatResetCountdown(
  iso: string | null | undefined,
  now: number,
): string | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  const ms = target - now;
  if (ms <= 0) return "resets now";

  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const days = Math.floor(hours / 24);

  // > 1 day: "resets in 2d 3h" — minutes drop because second-level
  // updates aren't useful at this scale. < 1h: "resets in 4m 30s" so the
  // user sees seconds count down on the most-imminent window.
  if (days >= 1) {
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours >= 1) {
    return `resets in ${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes >= 1) {
    return `resets in ${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `resets in ${seconds}s`;
}

// formatAge renders how long ago the daemon snapshot arrived. Stays
// terse so the connection pill doesn't grow past one line: "2s ago",
// "5m ago", "1h ago".
function formatAge(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// SwapSettingsSection exposes the auto-swap knobs the TUI's editor
// surfaces (auto-swap toggle, threshold cascade, pick order, auto-kick,
// rebalance-on-reset). Collapsed by default — the panel is dense and most
// users tune it once then forget. We fetch once on first expansion so the
// network roundtrip doesn't fire on every dialog open.
function SwapSettingsSection({ open }: { open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [cfg, setCfg] = useState<SwapConfig | null>(null);
  // Text mirror of the threshold list — we keep this as a string while
  // the user is editing (so "90, ," intermediate states don't trigger
  // re-sanitize) and only parse on save.
  const [thresholdsText, setThresholdsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await fetchSwapConfig();
      setCfg(c);
      setThresholdsText(thresholdsToText(c.swap_thresholds));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-load: fetch the first time the section expands while the dialog
  // is open. Re-collapse + re-expand reuses the cached state.
  useEffect(() => {
    if (!open || !expanded || cfg || loading) return;
    void load();
  }, [open, expanded, cfg, loading, load]);

  // Reset state when the dialog closes so a fresh open shows fresh data
  // rather than a stale snapshot from an earlier session.
  useEffect(() => {
    if (open) return;
    setExpanded(false);
    setCfg(null);
    setThresholdsText("");
    setError(null);
    setSavedAt(null);
  }, [open]);

  // Auto-dismiss the "Saved" pill so it doesn't pin to the row.
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2_500);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Toggles save immediately — boolean fields don't have an
  // intermediate-edit state, so deferring would be noise. Threshold and
  // pick-order edits go through onSave.
  const patchBool = async (
    field: keyof Pick<
      SwapConfig,
      "auto_swap" | "auto_kick" | "rebalance_on_reset"
    >,
    value: boolean,
  ) => {
    if (!cfg) return;
    // Optimistic update keeps the toggle responsive; we roll back on error.
    const prev = cfg;
    setCfg({ ...cfg, [field]: value });
    setError(null);
    try {
      const next = await updateSwapConfig({ [field]: value });
      setCfg(next);
      setSavedAt(Date.now());
    } catch (e) {
      setCfg(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const patchPickOrder = async (value: "lowest" | "highest") => {
    if (!cfg) return;
    const prev = cfg;
    setCfg({ ...cfg, pick_order: value });
    setError(null);
    try {
      const next = await updateSwapConfig({ pick_order: value });
      setCfg(next);
      setSavedAt(Date.now());
    } catch (e) {
      setCfg(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveThresholds = async () => {
    if (!cfg) return;
    const parsed = parseThresholds(thresholdsText);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await updateSwapConfig({ swap_thresholds: parsed.values });
      setCfg(next);
      // Reflect the sanitized form (sorted, dedup) back into the input so
      // the user sees what's actually persisted instead of their raw text.
      setThresholdsText(thresholdsToText(next.swap_thresholds));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/40"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2">
          <Settings2 className="size-3.5 text-muted-foreground" />
          Auto-swap settings
          {cfg && (
            <span className="text-[11px] font-normal text-muted-foreground">
              · {cfg.auto_swap ? "on" : "off"}
              {cfg.auto_swap && (
                <> · cascade {thresholdsToText(cfg.swap_thresholds)}%</>
              )}
            </span>
          )}
        </span>
        <ChevronDown
          className={`size-4 text-muted-foreground transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3 text-sm">
          {error && (
            <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </div>
          )}
          {loading && !cfg && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </div>
          )}
          {cfg && (
            <>
              <ToggleRow
                label="Auto-swap"
                hint="Rotate the active OAuth slot among accounts when the 5h window crosses a threshold."
                checked={cfg.auto_swap}
                onChange={(v) => void patchBool("auto_swap", v)}
              />
              {/* Threshold editor — keep it visible even when auto-swap is
                  off so users can prep the cascade before flipping the
                  toggle. The hint clarifies that values without auto-swap
                  on are inert. */}
              <div className="space-y-1">
                <label className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">Swap thresholds (%)</span>
                  {savedAt != null && (
                    <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      Saved
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={thresholdsText}
                    onChange={(e) => setThresholdsText(e.target.value)}
                    placeholder="90, 99, 100"
                    className="flex-1 rounded-md border bg-background px-2 py-1.5 text-xs font-mono outline-none focus:border-ring"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveThresholds();
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void saveThresholds()}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Ascending cascade. Daemon tries to swap at the first tier
                  the active account crosses, looking for a candidate
                  below that tier.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Pick order</label>
                <div className="flex gap-1.5">
                  <PickOrderButton
                    label="Lowest first"
                    active={cfg.pick_order === "lowest"}
                    onClick={() => void patchPickOrder("lowest")}
                    hint="Pick the freshest account · spreads load"
                  />
                  <PickOrderButton
                    label="Highest first"
                    active={cfg.pick_order === "highest"}
                    onClick={() => void patchPickOrder("highest")}
                    hint="Drain accounts one at a time"
                  />
                </div>
              </div>
              <ToggleRow
                label="Rebalance on reset"
                hint="Swap to any non-active account whose 5h window just rolled over, even if the active is well below the threshold."
                checked={cfg.rebalance_on_reset}
                onChange={(v) => void patchBool("rebalance_on_reset", v)}
              />
              <ToggleRow
                label="Auto-kick"
                hint="Force-evict the active account from its slot when its quota's exhausted, so a sibling account can take over without a manual swap."
                checked={cfg.auto_kick}
                onChange={(v) => void patchBool("auto_kick", v)}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

// Compact one-row toggle with inline hint underneath. Used for the
// boolean auto-swap knobs — distinct from the threshold editor which
// needs a save action.
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted"
        }`}
      >
        <span
          className={`inline-block size-4 transform rounded-full bg-background shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function PickOrderButton({
  label,
  active,
  onClick,
  hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`flex-1 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted/60"
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[10px] text-muted-foreground">{hint}</div>
    </button>
  );
}

function thresholdsToText(ts: number[]): string {
  return ts.map((n) => (Number.isInteger(n) ? String(n) : String(n))).join(", ");
}

// parseThresholds mirrors the TUI's parser: trims, splits on comma,
// drops empties, validates [0, 100]. Returns the parsed list or an
// error string for inline feedback before we even hit the daemon.
function parseThresholds(
  s: string,
): { values: number[] } | { error: string } {
  const trimmed = s.trim();
  if (!trimmed) return { error: "Enter at least one threshold" };
  const out: number[] = [];
  for (const part of trimmed.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const v = Number(p);
    if (!Number.isFinite(v)) return { error: `Not a number: ${p}` };
    if (v < 0 || v > 100)
      return { error: `Out of range 0-100: ${p}` };
    out.push(v);
  }
  if (out.length === 0) return { error: "Enter at least one threshold" };
  return { values: out };
}

// useNowTick re-renders on a fixed interval so countdown displays show
// live seconds. Pass null to pause the timer (we do this when the
// dialog is closed so a hidden modal doesn't churn React work).
function useNowTick(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    // No initial setNow: the interval fires within intervalMs (1s in
    // practice) and the staleness on first paint is sub-second, which
    // is below any user-perceptible threshold for countdown labels.
    // Avoiding the synchronous setNow keeps us clean of the
    // set-state-in-effect lint.
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
