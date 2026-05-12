import "server-only";

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Bridges the Go daemon's persisted DB MCP connection registry into
// the orchestrator's Claude Agent SDK sessions. Each named connection
// (postgres or clickhouse driver) becomes one entry in the spawned
// session's `mcpServers` map keyed by the user-supplied name — same
// name the daemon-side injection uses in each managed account's
// .claude.json.
//
// We re-read the envelope synchronously here rather than going
// through the daemon's HTTP surface because attachSDKQuery is sync
// and rippling async through every spawn caller would touch a lot of
// unrelated code.
//
// Filename is "postgres-mcp.ts" for historical reasons — kept stable
// because sessions.ts imports it. The module is driver-agnostic.

type StdioStanza = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

type ConnectionDisk = {
  id?: string;
  name?: string;
  driver?: "postgres" | "clickhouse" | "redis";
  // Postgres
  uri?: string;
  // ClickHouse + Redis (overlapping field set — both protocols carry
  // host/port/user/pwd plus an optional TLS toggle).
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  secure?: boolean | null;
  // Redis-only: integer DB index (null/undefined = upstream default).
  redis_db?: number | null;
};

type Envelope = {
  connections?: {
    connections?: ConnectionDisk[];
  };
};

function configPath(): string {
  return path.join(os.homedir(), ".claude-monitor", "mcp.json");
}

// uvx is the shared launcher for both drivers — checking it once is
// enough. TTL-cached so a user who installs uvx mid-session doesn't
// have to restart the orchestrator. The daemon-side handler re-probes
// on every /api/mcp/connections list anyway; this cache exists for
// the SDK-spawn hot path where attachSDKQuery runs per turn.
const UVX_CACHE_TTL_MS = 30_000;
let uvxCache: { checkedAt: number; available: boolean } | null = null;

function uvxAvailable(): boolean {
  const now = Date.now();
  if (uvxCache && now - uvxCache.checkedAt < UVX_CACHE_TTL_MS) {
    return uvxCache.available;
  }
  try {
    execFileSync("uvx", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 3000,
    });
    uvxCache = { checkedAt: now, available: true };
  } catch {
    uvxCache = { checkedAt: now, available: false };
  }
  return uvxCache.available;
}

function readEnvelope(): Envelope | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Envelope;
  } catch {
    return null;
  }
}

function readConnections(): ConnectionDisk[] {
  const env = readEnvelope();
  return env?.connections?.connections ?? [];
}

function postgresStanza(c: ConnectionDisk): StdioStanza | null {
  const uri = c.uri?.trim();
  if (!uri) return null;
  return {
    type: "stdio",
    command: "uvx",
    args: ["postgres-mcp", "--access-mode=restricted"],
    env: { DATABASE_URI: uri },
  };
}

function clickhouseStanza(c: ConnectionDisk): StdioStanza | null {
  if (!c.host || !c.user) return null;
  const env: Record<string, string> = {
    CLICKHOUSE_HOST: c.host,
    CLICKHOUSE_USER: c.user,
    CLICKHOUSE_SECURE: String(c.secure ?? true),
  };
  if (c.password) env.CLICKHOUSE_PASSWORD = c.password;
  if (c.port) env.CLICKHOUSE_PORT = String(c.port);
  if (c.database) env.CLICKHOUSE_DATABASE = c.database;
  return {
    type: "stdio",
    command: "uvx",
    args: ["mcp-clickhouse"],
    env,
  };
}

function redisStanza(c: ConnectionDisk): StdioStanza | null {
  if (!c.host) return null;
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-redis", buildRedisURL(c)],
    env: {},
  };
}

// buildRedisURL mirrors the Go side's Connection.RedisURL — both must
// produce byte-identical URLs so the daemon-injected stanza (read by
// Claude Code) and the orchestrator-spawned stanza (read by SDK
// sessions) point at the same server.
//
// We can't use encodeURIComponent directly because it leaves `!`,
// `*`, `'`, `(`, `)` unencoded — these are RFC 3986 "sub-delims" that
// Go's net/url.URL percent-encodes inside userinfo. A password
// containing those characters would resolve to two different strings
// on the two sides and authenticate against one server but not the
// other.
function buildRedisURL(c: ConnectionDisk): string {
  const scheme = (c.secure ?? true) ? "rediss" : "redis";
  const portPart = c.port ? `:${c.port}` : "";
  const dbPart = c.redis_db != null ? `/${c.redis_db}` : "";
  let userinfo = "";
  if (c.password) {
    const userPart = c.user ? encodeUserInfo(c.user) : "";
    userinfo = `${userPart}:${encodeUserInfo(c.password)}@`;
  } else if (c.user) {
    userinfo = `${encodeUserInfo(c.user)}@`;
  }
  return `${scheme}://${userinfo}${c.host}${portPart}${dbPart}`;
}

// encodeUserInfo is encodeURIComponent + the sub-delims Go's url
// package escapes. Verified equivalence: a password of "p@ss:wd!*'()"
// produces "p%40ss%3Awd%21%2A%27%28%29" on both sides.
function encodeUserInfo(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// getDbMcpEntries returns every configured DB connection's mcpServers
// stanza keyed by its user-supplied name. Tools surface to the model
// as `mcp__<connection_name>__execute_sql` (postgres) /
// `mcp__<connection_name>__run_query` (clickhouse).
//
// Returns {} when no connections are configured OR when uvx is
// missing from PATH. Safe to spread into a session's mcpServers map
// unconditionally.
export function getDbMcpEntries(): Record<string, StdioStanza> {
  const conns = readConnections();
  if (conns.length === 0 || !uvxAvailable()) return {};
  const out: Record<string, StdioStanza> = {};
  for (const c of conns) {
    if (!c.name) continue;
    const stanza = stanzaFor(c);
    if (stanza) out[c.name] = stanza;
  }
  return out;
}

function stanzaFor(c: ConnectionDisk): StdioStanza | null {
  switch (c.driver) {
    case "postgres":
      return postgresStanza(c);
    case "clickhouse":
      return clickhouseStanza(c);
    case "redis":
      return redisStanza(c);
    default:
      return null;
  }
}

// ConnectionLookup is the minimal view callers need to spawn an
// ad-hoc MCP client (e.g. the /api/mcp/db/execute route): the raw
// secrets and the driver to know which tool to invoke. Returns null
// when no connection by that name exists.
export interface ConnectionLookup {
  name: string;
  driver: "postgres" | "clickhouse" | "redis";
  // Pre-built stdio params for spawning the upstream MCP server.
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function findConnectionByName(name: string): ConnectionLookup | null {
  for (const c of readConnections()) {
    if (c.name !== name || !c.driver) continue;
    const stanza = stanzaFor(c);
    if (!stanza) return null;
    return {
      name: c.name,
      driver: c.driver,
      command: stanza.command,
      args: stanza.args,
      env: stanza.env,
    };
  }
  return null;
}

export function invalidateUvxCache() {
  uvxCache = null;
}
