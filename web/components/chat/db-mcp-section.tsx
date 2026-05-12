"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Pencil,
  Plus,
  Power,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// DbMcpSection is the /mcp panel's "Database integrations" group: a
// list of N named connections (postgres / clickhouse) the user has
// registered with the daemon. Each row exposes Edit / Delete; an
// inline Add form below the list registers a new one.
//
// All CRUD hits the Go daemon's /api/mcp/connections surface. The
// daemon owns the secret store + per-account .claude.json injection;
// this UI is just a thin form.
//
// Read-only enforcement is delegated entirely to the upstream MCP
// servers — postgres-mcp with --access-mode=restricted and
// mcp-clickhouse with its default CLICKHOUSE_ALLOW_WRITE_ACCESS=false.

interface UvxStatus {
  available: boolean;
  version?: string;
  install_hint?: string;
}

type Driver = "postgres" | "clickhouse" | "redis";

interface Connection {
  id: string;
  name: string;
  driver: Driver;
  // disabled = parked; daemon strips its stanza from every account
  // so the LLM doesn't see the tool surface.
  disabled?: boolean;
  // Postgres
  uri?: string; // redacted on the wire
  // ClickHouse + Redis
  host?: string;
  port?: number;
  user?: string;
  password?: string; // "***" when set
  database?: string;
  secure?: boolean | null;
  // Redis-only
  redis_db?: number | null;
}

interface ListResponse {
  connections: Connection[];
  uvx: UvxStatus;
}

export function DbMcpSection() {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [uvx, setUvx] = useState<UvxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/daemon/api/mcp/connections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setConns(body.connections);
      setUvx(body.uvx);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // Initial fetch on mount. The cascading-render warning doesn't
    // apply here because refresh only fires once per panel open —
    // there's no loop. Matches the same pattern used in mcp-dialog.tsx.
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
        <Database className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Database integrations</span>
        <span className="text-[11px] text-muted-foreground">
          (read-only)
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {conns ? `${conns.length} configured` : ""}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {uvx && !uvx.available && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs">
              <div className="font-medium text-amber-700 dark:text-amber-300">
                uvx not found
              </div>
              <div className="text-muted-foreground">
                Install with:{" "}
                <code className="rounded bg-background px-1 py-0.5">
                  {uvx.install_hint ?? "curl -LsSf https://astral.sh/uv/install.sh | sh"}
                </code>
              </div>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}

          {conns && conns.length === 0 && !adding && (
            <div className="rounded border bg-background px-2.5 py-2 text-xs text-muted-foreground">
              No DB connections yet. Use{" "}
              <span className="font-mono">Add connection</span> below to
              register a Postgres or ClickHouse server.
            </div>
          )}

          {conns?.map((c) => (
            <ConnectionRow
              key={c.id}
              conn={c}
              editing={editingId === c.id}
              onToggleEdit={() => {
                setAdding(false);
                setEditingId(editingId === c.id ? null : c.id);
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
                Add connection
              </div>
              <ConnectionForm
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
              Add connection
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  conn,
  editing,
  onToggleEdit,
  onDone,
  onError,
}: {
  conn: Connection;
  editing: boolean;
  onToggleEdit: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<"toggle" | "delete" | null>(null);
  const summary = summarise(conn);

  const remove = async () => {
    if (!confirm(`Delete connection "${conn.name}"?`)) return;
    setBusy("delete");
    try {
      const res = await fetch(
        `/daemon/api/mcp/connections/${encodeURIComponent(conn.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        onError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    setBusy("toggle");
    try {
      const res = await fetch(
        `/daemon/api/mcp/connections/${encodeURIComponent(conn.id)}/toggle`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        onError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { warning?: string };
      if (body.warning) onError(`toggled with warning: ${body.warning}`);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disabled = conn.disabled ?? false;

  return (
    <div
      className={cn(
        "rounded border bg-background px-2.5 py-2",
        disabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <DriverBadge driver={conn.driver} />
        <span
          className={cn(
            "font-medium",
            disabled && "line-through decoration-muted-foreground/60",
          )}
        >
          {conn.name}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {disabled ? "disabled" : summary}
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={busy !== null}
          title={disabled ? "Enable connection" : "Disable connection"}
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50",
            disabled
              ? "text-muted-foreground"
              : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {busy === "toggle" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Power className="size-3" />
          )}
        </button>
        <button
          type="button"
          onClick={onToggleEdit}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
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
          disabled={busy !== null}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {busy === "delete" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Trash2 className="size-3" />
          )}
        </button>
      </div>
      {editing && (
        <div className="mt-2 border-t pt-2">
          <ConnectionForm
            mode="update"
            initial={conn}
            onDone={onDone}
            onCancel={onToggleEdit}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
}

function summarise(conn: Connection): string {
  if (conn.driver === "postgres") return conn.uri ?? "";
  if (!conn.host) return "";
  const userPart = conn.user ? `${conn.user}@` : "";
  const portPart = conn.port ? `:${conn.port}` : "";
  if (conn.driver === "redis") {
    const dbPart =
      conn.redis_db != null && conn.redis_db !== 0 ? `/${conn.redis_db}` : "";
    return `${userPart}${conn.host}${portPart}${dbPart}`;
  }
  // clickhouse
  const dbName = conn.database ? `/${conn.database}` : "";
  return `${userPart}${conn.host}${portPart}${dbName}`;
}

const DRIVER_BADGE: Record<Driver, { label: string; cls: string }> = {
  postgres: {
    label: "pg",
    cls: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  },
  clickhouse: {
    label: "ch",
    cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  },
  redis: {
    label: "redis",
    cls: "bg-red-500/15 text-red-700 dark:text-red-300",
  },
};

function DriverBadge({ driver }: { driver: Driver }) {
  const meta = DRIVER_BADGE[driver];
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.cls,
      )}
    >
      {meta.label}
    </span>
  );
}

// TestState tracks the most recent test attempt for the *current*
// form fingerprint. The Save button is gated on `passed` with a
// matching fingerprint so users can't persist a config they haven't
// proven can boot. Editing any field implicitly invalidates the
// gate because the fingerprint changes (computed from buildBody).
type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "passed"; fingerprint: string; output?: string }
  | { status: "failed"; fingerprint: string; message: string; output?: string };

// ConnectionForm covers both create and update across all three
// drivers (postgres / clickhouse / redis). The driver picker is
// locked on update so a connection can't switch types mid-life
// (which would invalidate the per-driver field set on disk).
//
// Save is disabled until the user runs Test successfully against the
// *current* form values — the upstream MCP server is spawned via
// uvx, so a typo'd host or wrong port should fail fast in Test
// rather than land on disk and break the next account swap.
function ConnectionForm({
  mode,
  initial,
  onDone,
  onCancel,
  onError,
}: {
  mode: "create" | "update";
  initial?: Connection;
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [driver, setDriver] = useState<Driver>(initial?.driver ?? "postgres");
  const [uri, setUri] = useState("");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState<string>(
    initial?.port ? String(initial.port) : "",
  );
  const [user, setUser] = useState(
    initial?.user ?? (initial?.driver === "redis" ? "" : "default"),
  );
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [redisDb, setRedisDb] = useState<string>(
    initial?.redis_db != null ? String(initial.redis_db) : "",
  );
  const [secure, setSecure] = useState<boolean>(initial?.secure ?? true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Plain function (not useCallback) — buildBody runs at most twice
  // per render (once for fingerprint, once on test/save click). The
  // React 19 compiler memoizes the surrounding component output
  // already; explicit useCallback here trips the
  // preserve-manual-memoization lint.
  function buildBody(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      name: name.trim(),
      driver,
    };
    if (mode === "update" && initial?.id) base.id = initial.id;
    if (driver === "postgres") {
      return { ...base, uri };
    }
    if (driver === "clickhouse") {
      return {
        ...base,
        host: host.trim(),
        port: port ? Number(port) : 0,
        user: user.trim(),
        password,
        database: database.trim(),
        secure,
      };
    }
    // redis
    return {
      ...base,
      host: host.trim(),
      port: port ? Number(port) : 0,
      user: user.trim(),
      password,
      redis_db: redisDb === "" ? null : Number(redisDb),
      secure,
    };
  }

  const fingerprint = JSON.stringify(buildBody());
  const testPassed =
    test.status === "passed" && test.fingerprint === fingerprint;

  const runTest = async () => {
    setBusy("test");
    setTest({ status: "testing" });
    try {
      const res = await fetch("/daemon/api/mcp/connections/test", {
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
      onError(""); // clear any previous panel-level error
      setTest({
        status: "passed",
        fingerprint,
        output: body.output,
      });
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
          ? "/daemon/api/mcp/connections"
          : `/daemon/api/mcp/connections/${encodeURIComponent(initial!.id)}`;
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

  const valid =
    name.trim().length > 0 &&
    (driver === "postgres"
      ? mode === "update" || uri.trim().length > 0
      : driver === "clickhouse"
        ? host.trim().length > 0 && user.trim().length > 0
        : host.trim().length > 0); // redis: user/password optional

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" hint="lowercase, [a-z0-9_]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="warehouse"
            className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
            autoComplete="off"
          />
        </Field>
        <Field label="Driver">
          <select
            value={driver}
            onChange={(e) => setDriver(e.target.value as Driver)}
            disabled={mode === "update"}
            className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-60"
          >
            <option value="postgres">PostgreSQL</option>
            <option value="clickhouse">ClickHouse</option>
            <option value="redis">Redis</option>
          </select>
        </Field>
      </div>

      {driver === "postgres" && (
        <Field
          label="Connection URI"
          hint={
            mode === "update"
              ? "leave empty to keep existing"
              : "stored chmod 0600; --access-mode=restricted"
          }
        >
          <input
            type="password"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder={
              mode === "update"
                ? initial?.uri ?? ""
                : "postgres://user:password@host:5432/dbname"
            }
            className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
            autoComplete="off"
          />
        </Field>
      )}

      {driver === "clickhouse" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Host">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="myhost.clickhouse.cloud"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="Port">
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="8443"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="User">
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="default"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Password"
            hint={mode === "update" ? "leave empty to keep" : ""}
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="Database (optional)">
            <input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <label className="flex items-center gap-2 pt-5 text-xs">
            <input
              type="checkbox"
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
            />
            Secure (HTTPS)
          </label>
        </div>
      )}

      {driver === "redis" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Host">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="redis.example.com"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="Port">
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="6379"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="Username (optional)" hint="ACL user, redis 6+">
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="default"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Password"
            hint={mode === "update" ? "leave empty to keep" : "optional"}
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <Field label="DB index (optional)" hint="default 0">
            <input
              value={redisDb}
              onChange={(e) => setRedisDb(e.target.value)}
              placeholder="0"
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <label className="flex items-center gap-2 pt-5 text-xs">
            <input
              type="checkbox"
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
            />
            TLS (rediss://)
          </label>
        </div>
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
          {busy === "save" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
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
        Test the connection to enable Save.
      </div>
    );
  }
  if (state.status === "testing") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Spawning uvx and probing the server…
      </div>
    );
  }
  // passed/failed states carry the fingerprint they were tested against;
  // a mismatch means the user has edited fields since.
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
              Connection booted cleanly. Save enabled.
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
  // failed
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
