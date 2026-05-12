"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hash,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// IntegrationsSection is the /mcp panel's "Service integrations"
// group — sibling to DbMcpSection. Each row is one configured
// third-party service (Slack today, more later) the user has
// registered with the daemon. CRUD hits /api/mcp/integrations on
// the Go side.
//
// Architecture mirrors DbMcpSection deliberately: the form is
// service-specific but the list/edit/delete surface is shared. To
// add a new service, extend the Service union, the renderer in
// ServiceForm, and the Stanza branch on the Go side.

type Service = "slack";

interface Integration {
  id: string;
  name: string;
  service: Service;
  // Slack — token is redacted on the wire ("xoxp-***" / "xoxb-***")
  // so the form can render "token is set" without exposing it.
  slack_token?: string;
  slack_add_message_tool?: boolean;
}

interface ListResponse {
  integrations: Integration[];
}

export function IntegrationsSection() {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/daemon/api/mcp/integrations");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setItems(body.integrations);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // Mirrors DbMcpSection: a single fetch on mount, no loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <div className="rounded-md border bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        {open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <Plug className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Service integrations</span>
        <span className="text-[11px] text-muted-foreground">
          (local stdio MCP)
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {items ? `${items.length} configured` : ""}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {error && <div className="text-xs text-destructive">{error}</div>}

          {items && items.length === 0 && !adding && (
            <div className="rounded border bg-background px-2.5 py-2 text-xs text-muted-foreground">
              No integrations yet. Use{" "}
              <span className="font-mono">Add integration</span> below to wire
              up Slack (more services soon).
            </div>
          )}

          {items?.map((i) => (
            <IntegrationRow
              key={i.id}
              integration={i}
              editing={editingId === i.id}
              onToggleEdit={() => {
                setAdding(false);
                setEditingId(editingId === i.id ? null : i.id);
              }}
              onDone={() => {
                setEditingId(null);
                void refresh();
              }}
              onError={setError}
            />
          ))}

          {adding ? (
            <div className="rounded border bg-background px-2.5 py-2">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                Add integration
              </div>
              <IntegrationForm
                mode="create"
                onDone={() => {
                  setAdding(false);
                  void refresh();
                }}
                onCancel={() => setAdding(false)}
                onError={setError}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setAdding(true);
              }}
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
            >
              <Plus className="size-3" />
              Add integration
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IntegrationRow({
  integration,
  editing,
  onToggleEdit,
  onDone,
  onError,
}: {
  integration: Integration;
  editing: boolean;
  onToggleEdit: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const summary = summarise(integration);

  const remove = async () => {
    if (!confirm(`Delete integration "${integration.name}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/daemon/api/mcp/integrations/${encodeURIComponent(integration.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        onError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border bg-background px-2.5 py-2">
      <div className="flex items-center gap-2 text-sm">
        <ServiceBadge service={integration.service} />
        <span className="font-medium">{integration.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {summary}
        </span>
        <button
          type="button"
          onClick={onToggleEdit}
          className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
        >
          {editing ? (
            "Close"
          ) : (
            <>
              <Pencil className="size-3" /> Edit
            </>
          )}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Trash2 className="size-3" />
          )}
        </button>
      </div>
      {editing && (
        <div className="mt-2 border-t pt-2">
          <IntegrationForm
            mode="update"
            initial={integration}
            onDone={onDone}
            onCancel={onToggleEdit}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
}

function summarise(i: Integration): string {
  if (i.service === "slack") {
    // slack_token comes back redacted ("xoxp-***" / "xoxb-***") so we
    // can show *which* token mode is set without exposing the secret.
    const tok = i.slack_token ?? "";
    const mode = tok.startsWith("xoxp")
      ? "user OAuth"
      : tok.startsWith("xoxb")
        ? "bot"
        : "no token";
    const post = i.slack_add_message_tool ? " · post: on" : "";
    return `${mode}${post}`;
  }
  return "";
}

const SERVICE_BADGE: Record<Service, { label: string; cls: string; Icon: typeof Hash }> = {
  slack: {
    label: "slack",
    cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    // Lucide doesn't ship a Slack glyph, but Hash (#) is the
    // universally legible "Slack channel" symbol.
    Icon: Hash,
  },
};

function ServiceBadge({ service }: { service: Service }) {
  const meta = SERVICE_BADGE[service];
  const Icon = meta.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.cls,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

// TestState gates Save on a successful Test for the *current* form
// fingerprint — mirrors DbMcpSection. Editing any field invalidates
// the gate because the fingerprint changes.
type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "passed"; fingerprint: string; output?: string }
  | { status: "failed"; fingerprint: string; message: string; output?: string };

function IntegrationForm({
  mode,
  initial,
  onDone,
  onCancel,
  onError,
}: {
  mode: "create" | "update";
  initial?: Integration;
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [service, setService] = useState<Service>(initial?.service ?? "slack");
  const [slackToken, setSlackToken] = useState("");
  const [slackAddMessage, setSlackAddMessage] = useState(
    initial?.slack_add_message_tool ?? false,
  );
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  function buildBody(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: name.trim(),
      service,
    };
    if (mode === "update" && initial?.id) base.id = initial.id;
    if (service === "slack") {
      return {
        ...base,
        slack_token: slackToken,
        slack_add_message_tool: slackAddMessage,
      };
    }
    return base;
  }

  const fingerprint = JSON.stringify(buildBody());
  const testPassed =
    test.status === "passed" && test.fingerprint === fingerprint;

  const runTest = async () => {
    setBusy("test");
    setTest({ status: "testing" });
    try {
      const res = await fetch("/daemon/api/mcp/integrations/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        output?: string;
      };
      if (!res.ok || body.ok === false) {
        setTest({
          status: "failed",
          fingerprint,
          message: body.error ?? `test failed (HTTP ${res.status})`,
          output: body.output,
        });
        return;
      }
      onError("");
      setTest({ status: "passed", fingerprint, output: body.output });
    } catch (err) {
      setTest({
        status: "failed",
        fingerprint,
        message: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!testPassed) return;
    setBusy("save");
    try {
      const url =
        mode === "create"
          ? "/daemon/api/mcp/integrations"
          : `/daemon/api/mcp/integrations/${encodeURIComponent(initial!.id)}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const body = (await res.json()) as { error?: string; warning?: string };
      if (!res.ok) {
        onError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      if (body.warning) onError(`saved with warning: ${body.warning}`);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Slack-specific validity. When editing, the existing token is
  // preserved server-side on empty input, so an update-mode form is
  // valid with just a name + the existing token (which we never see
  // in cleartext).
  const slackValid =
    mode === "update" || slackToken.trim().startsWith("xoxp-") || slackToken.trim().startsWith("xoxb-");
  const valid = name.trim().length > 0 && (service === "slack" ? slackValid : false);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" hint="lowercase, [a-z0-9_]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="team_slack"
            className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
            autoComplete="off"
          />
        </Field>
        <Field label="Service">
          <select
            value={service}
            onChange={(e) => setService(e.target.value as Service)}
            disabled={mode === "update"}
            className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-60"
          >
            <option value="slack">Slack</option>
          </select>
        </Field>
      </div>

      {service === "slack" && (
        <SlackFields
          mode={mode}
          existingTokenRedacted={initial?.slack_token}
          token={slackToken}
          setToken={setSlackToken}
          addMessage={slackAddMessage}
          setAddMessage={setSlackAddMessage}
        />
      )}

      <TestResultBanner state={test} fingerprint={fingerprint} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runTest}
          disabled={busy !== null || !valid}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {busy === "test" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <CheckCircle2 className="size-3" />
          )}
          Test connection
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy !== null || !valid || !testPassed}
          title={
            testPassed
              ? undefined
              : "Run Test connection successfully before saving"
          }
          className="inline-flex items-center gap-1 rounded-md border bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {busy === "save" ? <Loader2 className="size-3 animate-spin" /> : null}
          {mode === "create" ? "Create" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy !== null}
          className="ml-auto rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SlackFields({
  mode,
  existingTokenRedacted,
  token,
  setToken,
  addMessage,
  setAddMessage,
}: {
  mode: "create" | "update";
  existingTokenRedacted?: string;
  token: string;
  setToken: (v: string) => void;
  addMessage: boolean;
  setAddMessage: (v: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <Field
        label="Slack token"
        hint={
          mode === "update"
            ? `leave empty to keep existing (${existingTokenRedacted ?? "set"})`
            : "xoxp-… (user OAuth) or xoxb-… (bot)"
        }
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={mode === "update" ? existingTokenRedacted ?? "" : "xoxp-… or xoxb-…"}
          className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
          autoComplete="off"
        />
      </Field>

      <label className="flex items-start gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
        <input
          type="checkbox"
          checked={addMessage}
          onChange={(e) => setAddMessage(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Enable message posting</span>
          <span className="ml-1 text-muted-foreground">
            (off by default — Slack MCP is read-only unless you opt in)
          </span>
        </span>
      </label>

      <div className="rounded-md border border-dashed bg-muted/10 px-2 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">How to get a token:</span>{" "}
        <span className="font-mono">xoxp-</span> = user OAuth from a Slack app
        you installed to your workspace.{" "}
        <span className="font-mono">xoxb-</span> = bot token (workspace admin
        approval required, bot must be invited to channels). The token never
        leaves your machine — only the model running on this account&apos;s
        session sees the resulting tool surface.
      </div>
    </div>
  );
}

function TestResultBanner({
  state,
  fingerprint,
}: {
  state: TestState;
  fingerprint: string;
}) {
  if (state.status === "idle") {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
        Test the connection to enable Save. First-run npx fetches the package —
        this can take 5–15s on a cold cache.
      </div>
    );
  }
  if (state.status === "testing") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Spawning npx slack-mcp-server and probing the server…
      </div>
    );
  }
  const stale = state.fingerprint !== fingerprint;
  if (state.status === "passed") {
    return (
      <div
        className={cn(
          "rounded-md border px-2 py-1.5 text-[11px]",
          stale
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        )}
      >
        <div className="flex items-center gap-1.5 font-medium">
          {stale ? (
            <>Configuration changed since last test — re-run Test.</>
          ) : (
            <>
              <CheckCircle2 className="size-3" />
              Server booted cleanly. Save enabled.
            </>
          )}
        </div>
        {state.output && (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-foreground/70">
            {state.output}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
      <div className="flex items-center gap-1.5 font-medium">
        <XCircle className="size-3" />
        {state.message}
      </div>
      {state.output && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-destructive/80">
          {state.output}
        </pre>
      )}
      {stale && (
        <div className="mt-1 text-muted-foreground">
          (config has changed since this error — re-run Test.)
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground">
        {label}
        {hint && (
          <span className="ml-1 font-normal text-muted-foreground/70">
            ({hint})
          </span>
        )}
      </label>
      {children}
    </div>
  );
}
