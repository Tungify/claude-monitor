import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Reads stuff out of the user's Claude config directory + project
// directory so the web orchestrator's slash commands (/mcp, /agents,
// /skills, /hooks, /config, /permissions) can surface real data
// instead of placeholder text. Each helper is best-effort: missing
// files / unreadable JSON / a missing directory all degrade to "0
// entries" rather than throwing — the chat panel renders an empty
// section rather than an error.

interface SettingsFile {
  mcpServers?: Record<string, McpServerEntry>;
  hooks?: Record<string, unknown>;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
    defaultMode?: string;
  };
  // Anything else passes through; we don't validate the full shape
  // because the binary's accepted schema drifts and we only surface
  // fields the user asked for.
  [key: string]: unknown;
}

// Loose typing — the binary accepts both stdio and http server entries
// with different fields. We pull the discriminant + a couple of shared
// fields and forward everything else as raw JSON for display.
export interface McpServerEntry {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  // unknown extras kept out of the typed surface; consumers stringify
  // the whole entry for the "raw" detail view if they want it.
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const text = await fs.readFile(file, "utf-8");
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`[cli-introspect] read ${file} failed:`, err);
    return undefined;
  }
}

// Pulls from both the global settings.json + the local override (which
// the binary layers on top). Local entries shadow global ones with the
// same key. settings.local.json is the personal-machine copy that the
// binary ignores in CI; we still merge it so /config reflects what the
// session actually sees.
export async function loadSettings(configDir: string): Promise<{
  global?: SettingsFile;
  local?: SettingsFile;
  merged: SettingsFile;
}> {
  const global = await readJson<SettingsFile>(
    path.join(configDir, "settings.json"),
  );
  const local = await readJson<SettingsFile>(
    path.join(configDir, "settings.local.json"),
  );
  // Shallow-merge top-level keys, then deep-merge the dictionaries we
  // surface (mcpServers, permissions). Hooks stays shallow because the
  // binary itself overrides per-event without merging the event's
  // command list — local replaces global for any hook event present.
  const merged: SettingsFile = { ...global, ...local };
  if (global?.mcpServers || local?.mcpServers) {
    merged.mcpServers = { ...global?.mcpServers, ...local?.mcpServers };
  }
  if (global?.permissions || local?.permissions) {
    merged.permissions = {
      ...global?.permissions,
      ...local?.permissions,
      // Concat arrays; the binary appends rather than replacing.
      allow: [
        ...(global?.permissions?.allow ?? []),
        ...(local?.permissions?.allow ?? []),
      ],
      deny: [
        ...(global?.permissions?.deny ?? []),
        ...(local?.permissions?.deny ?? []),
      ],
      ask: [
        ...(global?.permissions?.ask ?? []),
        ...(local?.permissions?.ask ?? []),
      ],
      additionalDirectories: [
        ...(global?.permissions?.additionalDirectories ?? []),
        ...(local?.permissions?.additionalDirectories ?? []),
      ],
    };
  }
  return { global, local, merged };
}

export interface McpServerInfo {
  name: string;
  scope: "user" | "project" | "claudeai";
  type?: string;
  // Display-friendly target: command for stdio, url for http/sse, or the
  // remote integration URL for claude.ai connectors.
  target?: string;
  raw?: McpServerEntry;
  // Authentication status for claude.ai-managed integrations:
  //   "ready"    → OAuth token has user:mcp_servers scope, integration listed
  //   "needs_auth" → token missing scope, or integration not yet authorized
  // File-configured servers leave this undefined (status would need a live
  // probe through the SDK which the chat thread can't afford to block on).
  authStatus?: "ready" | "needs_auth";
}

interface CredsEnvelope {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
}

interface ClaudeAiMcpResponse {
  data: Array<{
    type: "mcp_server";
    id: string;
    display_name: string;
    url: string;
    created_at: string;
  }>;
  has_more?: boolean;
}

const CLAUDE_AI_API_BASE = "https://api.anthropic.com";
const MCP_SERVERS_BETA = "mcp-servers-2025-12-04";
const CLAUDE_AI_MCP_FETCH_TIMEOUT_MS = 5000;

// Reads the orchestrator-scoped credentials envelope. The launcher
// either mirrors a keychain entry here or — on systems without a
// keychain — keeps the only copy in this file. Schema mirrors the
// Claude binary's own claudeAiOauth shape; see internal/keychain.
async function readCredsEnvelope(
  configDir: string,
): Promise<CredsEnvelope["claudeAiOauth"] | undefined> {
  const env = await readJson<CredsEnvelope>(
    path.join(configDir, ".credentials.json"),
  );
  return env?.claudeAiOauth;
}

// Lists claude.ai-managed MCP integrations (the connectors a user
// authorizes on claude.ai/settings/connectors — Asana, Atlassian, Box,
// etc.). The CLI's /mcp panel groups these under a "claude.ai" section;
// see leaked source's services/mcp/claudeai.ts.
//
// On macOS the OAuth token lives in the keychain (not .credentials.json)
// and Node can't read it. We delegate the API call to the Go daemon,
// which has the keychain plumbing and proxies the response. The token
// never crosses to Node — daemon returns just the parsed server list.
//
// Falls back to reading .credentials.json directly when the daemon is
// unreachable, so Linux setups (where the binary stores creds in the
// file) keep working even if the daemon is down. Either path returns
// {servers: [], needsAuth: bool} so /mcp degrades gracefully on failure.
export async function fetchClaudeAiMcpServers(
  configDir: string,
): Promise<{ servers: McpServerInfo[]; needsAuth: boolean }> {
  const viaDaemon = await fetchClaudeAiMcpViaDaemon(configDir);
  if (viaDaemon !== null) return viaDaemon;
  return fetchClaudeAiMcpFromFile(configDir);
}

// fetchClaudeAiMcpViaDaemon hits /api/account/mcp-servers on the Go
// daemon. Returns null when the daemon itself can't be reached (so the
// caller falls back to the local file path); otherwise returns the
// daemon's parsed response — including the needs_auth signal.
async function fetchClaudeAiMcpViaDaemon(
  configDir: string,
): Promise<{ servers: McpServerInfo[]; needsAuth: boolean } | null> {
  const base = process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:8788";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLAUDE_AI_MCP_FETCH_TIMEOUT_MS,
  );
  try {
    const url = `${base}/api/account/mcp-servers?config_dir=${encodeURIComponent(configDir)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // Daemon reachable but returned an error code — treat as
      // "no integrations" rather than retrying. The daemon already
      // collapses upstream 401/403 into a 200 with needs_auth=true,
      // so a 500 here is a daemon bug we don't want to mask.
      console.warn(
        `[cli-introspect] daemon /api/account/mcp-servers ${res.status}`,
      );
      return { servers: [], needsAuth: false };
    }
    const body = (await res.json()) as {
      servers: Array<{ id: string; display_name: string; url: string }>;
      needs_auth: boolean;
    };
    const out: McpServerInfo[] = [];
    for (const s of body.servers ?? []) {
      out.push({
        name: `claude.ai ${s.display_name}`,
        scope: "claudeai",
        type: "http",
        target: s.url,
        // Listed integrations always render with the "needs auth"
        // hint — the CLI does the same, since per-connector auth
        // lives on Claude's side and we can't probe it from here.
        authStatus: "needs_auth",
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { servers: out, needsAuth: body.needs_auth };
  } catch {
    // ECONNREFUSED / abort / DNS — daemon isn't running. Tell the
    // caller to try the file fallback.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// fetchClaudeAiMcpFromFile is the pre-daemon implementation, retained
// as a fallback for environments where the binary persists creds to
// .credentials.json (headless Linux, WSL, CI). Macs and most desktop
// Linuxes go through the daemon path above.
async function fetchClaudeAiMcpFromFile(
  configDir: string,
): Promise<{ servers: McpServerInfo[]; needsAuth: boolean }> {
  const creds = await readCredsEnvelope(configDir);
  if (!creds?.accessToken) {
    return { servers: [], needsAuth: false };
  }
  const hasScope = (creds.scopes ?? []).includes("user:mcp_servers");
  if (!hasScope) {
    return { servers: [], needsAuth: true };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CLAUDE_AI_MCP_FETCH_TIMEOUT_MS,
  );
  let body: ClaudeAiMcpResponse | undefined;
  try {
    const res = await fetch(
      `${CLAUDE_AI_API_BASE}/v1/mcp_servers?limit=1000`,
      {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
          "anthropic-beta": MCP_SERVERS_BETA,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return {
        servers: [],
        needsAuth: res.status === 401 || res.status === 403,
      };
    }
    body = (await res.json()) as ClaudeAiMcpResponse;
  } catch (err) {
    console.warn("[cli-introspect] claude.ai /v1/mcp_servers failed:", err);
    return { servers: [], needsAuth: false };
  } finally {
    clearTimeout(timeout);
  }
  const out: McpServerInfo[] = [];
  for (const s of body?.data ?? []) {
    out.push({
      name: `claude.ai ${s.display_name}`,
      scope: "claudeai",
      type: "http",
      target: s.url,
      authStatus: "needs_auth",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { servers: out, needsAuth: false };
}

// Lists MCP servers visible to the session. The Claude binary itself
// resolves MCP config from a fan of files; we walk all of them so the
// /mcp output matches what the CLI would show:
//
//   1. <configDir>/settings.json + settings.local.json    (claude-monitor scope)
//   2. <configDir>/.claude.json                            (per-account binary state)
//   3. ~/.claude.json                                       (global binary state — *the* default location)
//   4. ~/.claude.json projects[<cwd>].mcpServers            (project-scoped, written by `claude mcp add --scope project`)
//   5. <cwd>/.mcp.json                                      (committed-to-repo project servers)
//   6. <cwd>/.claude/settings.{,local.}json mcpServers
//
// Duplicates by name resolve to the latest occurrence (later sources
// win) — same precedence the binary uses.
export async function listMcpServers(
  configDir: string,
  cwd: string,
): Promise<McpServerInfo[]> {
  // Use a Map<name, info> to dedupe; insertion order tracks first sight,
  // and we overwrite entries as we walk later sources.
  const byName = new Map<string, McpServerInfo>();

  const userSettings = await loadSettings(configDir);
  for (const [name, raw] of Object.entries(userSettings.merged.mcpServers ?? {})) {
    byName.set(name, infoFor(name, "user", raw));
  }

  // <configDir>/.claude.json — present when the binary was invoked
  // with CLAUDE_CONFIG_DIR=<configDir>; this is where `claude mcp add`
  // writes user-scope servers when running under our per-account dirs.
  const accountClaudeJson = await readJson<ClaudeJsonShape>(
    path.join(configDir, ".claude.json"),
  );
  for (const [name, raw] of Object.entries(
    accountClaudeJson?.mcpServers ?? {},
  )) {
    byName.set(name, infoFor(name, "user", raw));
  }

  // ~/.claude.json — the binary's global config file. Even when
  // CLAUDE_CONFIG_DIR points elsewhere, the binary still falls back
  // to this for session memory + project records, so MCPs configured
  // there will be visible to the session unless explicitly shadowed.
  const homeClaudeJson = await readJson<ClaudeJsonShape>(
    path.join(os.homedir(), ".claude.json"),
  );
  for (const [name, raw] of Object.entries(homeClaudeJson?.mcpServers ?? {})) {
    if (!byName.has(name)) byName.set(name, infoFor(name, "user", raw));
  }
  // Project-scoped MCPs recorded in the global config under projects[<cwd>].
  const projectFromHome = homeClaudeJson?.projects?.[cwd]?.mcpServers ?? {};
  for (const [name, raw] of Object.entries(projectFromHome)) {
    byName.set(name, infoFor(name, "project", raw));
  }
  const projectFromAccount =
    accountClaudeJson?.projects?.[cwd]?.mcpServers ?? {};
  for (const [name, raw] of Object.entries(projectFromAccount)) {
    byName.set(name, infoFor(name, "project", raw));
  }

  // <cwd>/.mcp.json — dedicated file the user commits to a repo so
  // collaborators get the same MCP servers. Shape matches the
  // mcpServers object directly (no settings wrapper).
  const dotMcp = await readJson<{ mcpServers?: Record<string, McpServerEntry> }>(
    path.join(cwd, ".mcp.json"),
  );
  for (const [name, raw] of Object.entries(dotMcp?.mcpServers ?? {})) {
    byName.set(name, infoFor(name, "project", raw));
  }

  const projectSettings = await loadSettings(path.join(cwd, ".claude"));
  for (const [name, raw] of Object.entries(
    projectSettings.merged.mcpServers ?? {},
  )) {
    byName.set(name, infoFor(name, "project", raw));
  }

  return Array.from(byName.values());
}

interface ClaudeJsonShape {
  mcpServers?: Record<string, McpServerEntry>;
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, McpServerEntry>;
    }
  >;
  // The Claude binary writes the active OAuth account's profile here
  // after login — Status pane reads it for "Login method / Org / Email".
  // Field names mirror the binary; do not rename without the CLI
  // updating in lockstep.
  oauthAccount?: {
    organizationName?: string;
    organizationUuid?: string;
    organizationRole?: string;
    emailAddress?: string;
    accountUuid?: string;
  };
}

// Subscription label rendered as "Login method: <X> Account" — taken
// from the OAuth token's subscriptionType, which the binary stores in
// .credentials.json (or keychain). We map the binary's raw lowercase
// tokens to the same title-case display the CLI uses; unknown values
// fall through verbatim so a new tier doesn't crash the panel.
function subscriptionLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  const map: Record<string, string> = {
    pro: "Claude Pro",
    max: "Claude Max",
    team: "Claude Team",
    enterprise: "Claude Enterprise",
  };
  return map[raw.toLowerCase()] ?? raw;
}

export interface StatusInfo {
  version?: string;
  loginMethod?: string;
  organization?: string;
  email?: string;
  // Counts mirror the CLI's "X connected, Y need auth, Z failed" pill.
  // configured = file-based (project/user/enterprise) — those don't
  // probe live, so we report them as a single "configured" bucket.
  mcp: {
    builtin: number;
    configured: number;
    claudeAi: number;
    claudeAiNeedsAuth: boolean;
  };
  // Setting sources that actually contributed something to the merged
  // settings view, in CLI order. Same labels the binary uses so a user
  // toggling between CLI and orchestrator doesn't relearn names.
  settingSources: string[];
}

// Builds the Status payload — everything the CLI's Status pane shows
// minus the diagnostics block, which would need live MCP probes /
// install checks that don't belong on a chat-panel command. Best-
// effort throughout: missing files / keychain-only tokens degrade
// individual fields to undefined rather than failing the whole call.
export async function buildStatusInfo(
  configDir: string,
  cwd: string,
): Promise<StatusInfo> {
  // OAuth account profile — written by the binary after /login. Lives
  // in the per-account config dir; the home ~/.claude.json fallback
  // is only relevant when CLAUDE_CONFIG_DIR isn't set, which our
  // sessions always set.
  const accountClaudeJson = await readJson<ClaudeJsonShape>(
    path.join(configDir, ".claude.json"),
  );
  const oauth = accountClaudeJson?.oauthAccount;

  // Subscription type lives on the OAuth token (creds envelope).
  // Reading the file is best-effort: on macOS the token is in the
  // keychain by default and the creds file is absent. In that case
  // we just omit "Login method" rather than guessing.
  const creds = await readCredsEnvelope(configDir);
  // SubscriptionType isn't part of the creds shape we already
  // declared, so cast through unknown for the extra field.
  const subscription = subscriptionLabel(
    (creds as { subscriptionType?: string } | undefined)?.subscriptionType,
  );

  // MCP counts. listMcpServers walks every config file; the count is
  // "configured user/project servers" — the CLI's "X connected" pill
  // would need live probes we don't run from the chat thread.
  const [configured, claudeAi] = await Promise.all([
    listMcpServers(configDir, cwd),
    fetchClaudeAiMcpServers(configDir),
  ]);
  // Plan is always wired; notes/leader come and go with the session
  // shape, but we don't have that here — caller (route) decides the
  // builtin count. Hard-code "1" as a floor; route can override.
  const builtin = 1;

  // Setting sources — only count the ones that actually produced
  // a non-empty merged file, mirroring the CLI's "actually loaded"
  // filter. We treat global+local+project as separate sources so a
  // user can see if local overrides are landing.
  const sources: string[] = [];
  const userSettings = await loadSettings(configDir);
  if (userSettings.global && Object.keys(userSettings.global).length > 0) {
    sources.push("User settings");
  }
  if (userSettings.local && Object.keys(userSettings.local).length > 0) {
    sources.push("User local settings");
  }
  const projectSettings = await loadSettings(path.join(cwd, ".claude"));
  if (
    projectSettings.global &&
    Object.keys(projectSettings.global).length > 0
  ) {
    sources.push("Project settings");
  }
  if (
    projectSettings.local &&
    Object.keys(projectSettings.local).length > 0
  ) {
    sources.push("Project local settings");
  }

  return {
    loginMethod: subscription,
    organization: oauth?.organizationName,
    email: oauth?.emailAddress,
    mcp: {
      builtin,
      configured: configured.length,
      claudeAi: claudeAi.servers.length,
      claudeAiNeedsAuth: claudeAi.needsAuth,
    },
    settingSources: sources,
  };
}

function infoFor(
  name: string,
  scope: "user" | "project",
  raw: McpServerEntry,
): McpServerInfo {
  const target =
    raw.type === "stdio" || !raw.type
      ? [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ")
      : raw.url;
  return { name, scope, type: raw.type ?? "stdio", target, raw };
}

export interface AgentEntry {
  name: string;
  scope: "user" | "project";
  description?: string;
  // Path relative to the home directory for display compactness.
  path: string;
}

// Walks <configDir>/agents and <cwd>/.claude/agents for *.md agent
// definitions, plus every installed plugin's agents/ folder
// (~/.claude/plugins/marketplaces/<repo>/<plugin>/agents/*.md). Each
// file's leading frontmatter `description` (if any) is surfaced; we
// don't parse the YAML rigorously, just the first `description:` line.
export async function listAgents(
  configDir: string,
  cwd: string,
): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = [];
  for (const [dir, scope] of [
    [path.join(configDir, "agents"), "user"],
    [path.join(cwd, ".claude", "agents"), "project"],
  ] as const) {
    for (const e of await listMarkdown(dir)) {
      entries.push({
        name: e.name,
        scope,
        description: e.description,
        path: e.path,
      });
    }
  }
  for (const e of await listPluginMarkdown("agents")) {
    entries.push({
      name: e.name,
      scope: "user",
      description: e.description,
      path: e.path,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SkillEntry {
  name: string;
  scope: "user" | "project";
  description?: string;
  path: string;
}

// Skills live as directories with a SKILL.md inside. We list any
// subdirectory of <configDir>/skills and <cwd>/.claude/skills that
// holds a SKILL.md, plus every plugin's skills/ folder. Description
// comes from each SKILL.md's frontmatter — same shape Claude Code
// surfaces when it triggers a skill.
export async function listSkills(
  configDir: string,
  cwd: string,
): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  for (const [dir, scope] of [
    [path.join(configDir, "skills"), "user"],
    [path.join(cwd, ".claude", "skills"), "project"],
  ] as const) {
    for (const s of await listSkillsDir(dir)) {
      out.push({ ...s, scope, path: path.join(dir, s.name, "SKILL.md") });
    }
  }
  // Plugin-supplied skills. Plugins live under
  // ~/.claude/plugins/marketplaces/<repo>/<plugin>/skills/<name>/SKILL.md.
  for (const root of await pluginRoots()) {
    const skillsDir = path.join(root, "skills");
    for (const s of await listSkillsDir(skillsDir)) {
      out.push({
        name: s.name,
        scope: "user",
        description: s.description,
        path: path.join(skillsDir, s.name, "SKILL.md"),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkillsDir(
  dir: string,
): Promise<Array<{ name: string; description?: string }>> {
  let children: string[];
  try {
    children = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; description?: string }> = [];
  for (const child of children) {
    const meta = await readMarkdownFrontmatter(
      path.join(dir, child, "SKILL.md"),
    );
    if (!meta) continue;
    out.push({ name: child, description: meta.description });
  }
  return out;
}

// pluginRoots walks ~/.claude/plugins/marketplaces/<repo>/plugins/<name>
// directories. Each plugin can ship agents/ + skills/ subdirs that
// the binary surfaces alongside user/project ones; we mirror that
// behavior so /agents and /skills don't underreport against the CLI.
async function pluginRoots(): Promise<string[]> {
  const base = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  let repos: string[];
  try {
    repos = await fs.readdir(base);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const repo of repos) {
    // Marketplace layout: <repo>/plugins/<name>. Older versions of
    // this walker treated the repo dir itself as a plugin container
    // and picked up README/LICENSE as fake plugins — keep it scoped
    // to the actual /plugins subdir so listings don't lie.
    const repoPluginsDir = path.join(base, repo, "plugins");
    let plugins: string[];
    try {
      plugins = await fs.readdir(repoPluginsDir);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      out.push(path.join(repoPluginsDir, plugin));
    }
  }
  return out;
}

export interface PluginEntry {
  // "<plugin>@<marketplace>" — same fully-qualified id the binary uses
  // in installed_plugins.json. Lets the user copy/paste it into a CLI
  // `claude plugins ...` invocation without translation.
  id: string;
  name: string;
  marketplace: string;
  scope: "user" | "project";
  version?: string;
  // Commit SHA the install was last synced to. Useful for spotting
  // a stale plugin against an updated upstream.
  gitCommitSha?: string;
  description?: string;
  // Capabilities walked off-disk: which subdirs the plugin actually
  // populates. Mirrors what shows up in the CLI's "(N tools / N agents
  // / N skills / N commands / N hooks)" tail per row.
  capabilities: {
    agents: number;
    skills: number;
    commands: number;
    hooks: number;
    mcpServers: number;
  };
}

export interface MarketplaceEntry {
  name: string;
  source?: string;
  repo?: string;
  installLocation?: string;
  lastUpdated?: string;
}

// One row of the Discover tab — the merged catalog view: name +
// marketplace + author + description + install count + whether
// this user has it installed already. Built by joining the
// marketplaces' .claude-plugin/marketplace.json catalogs with
// install-counts-cache.json and installed_plugins.json.
export interface CatalogPluginEntry {
  // "<plugin>@<marketplace>" — same id installed_plugins.json uses.
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  category?: string;
  author?: string;
  homepage?: string;
  // unique install count from install-counts-cache.json; missing for
  // plugins added since the cache was last refreshed.
  installs?: number;
  // True when this exact plugin@marketplace shows up in
  // installed_plugins.json. We don't distinguish scope here — the
  // Discover tab cares about "is it installed somewhere" not where.
  installed: boolean;
}

// installedPluginsShape mirrors ~/.claude/plugins/installed_plugins.json.
// "plugins" is keyed by "<plugin>@<marketplace>"; each entry is the
// list of scoped install records (a plugin can be installed at user +
// project scope independently — both records show up here). We only
// care about scope/version/installPath/gitCommitSha for the listing.
interface InstalledPluginsShape {
  version?: number;
  plugins?: Record<
    string,
    Array<{
      scope?: "user" | "project";
      installPath?: string;
      version?: string;
      installedAt?: string;
      lastUpdated?: string;
      gitCommitSha?: string;
    }>
  >;
}

interface KnownMarketplacesShape {
  [name: string]: {
    source?: { source?: string; repo?: string };
    installLocation?: string;
    lastUpdated?: string;
  };
}

interface PluginJsonShape {
  name?: string;
  description?: string;
  author?: { name?: string; email?: string };
}

// Counts how many *.md files in a directory the binary would surface
// as agents/skills/commands. Tolerant of missing dirs — those just
// score 0 and never throw.
async function countMarkdown(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    let n = 0;
    for (const e of entries) {
      if (e.endsWith(".md")) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

// Skills are directories (each holding a SKILL.md), not flat files.
// Count subdirs that actually contain a SKILL.md so unfinished
// scaffolds don't inflate the number.
async function countSkillsDir(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    let n = 0;
    for (const e of entries) {
      const skillFile = path.join(dir, e, "SKILL.md");
      try {
        await fs.stat(skillFile);
        n += 1;
      } catch {
        // missing SKILL.md — skip
      }
    }
    return n;
  } catch {
    return 0;
  }
}

// Lists installed plugins as the CLI's /plugin command would, including
// the marketplace they came from, their version + commit, and a per-
// plugin capability count (agents/skills/commands/hooks/mcp). Source of
// truth is installed_plugins.json — the marketplaces/ subtree is just
// where the file lookups land. Plugins that exist on disk but aren't in
// installed_plugins.json (rare: orphaned cache from an aborted install)
// are skipped, matching CLI behavior.
export async function listPlugins(): Promise<PluginEntry[]> {
  const base = path.join(os.homedir(), ".claude", "plugins");
  const installed = await readJson<InstalledPluginsShape>(
    path.join(base, "installed_plugins.json"),
  );
  if (!installed?.plugins) return [];

  const out: PluginEntry[] = [];
  for (const [id, records] of Object.entries(installed.plugins)) {
    // id shape: "<plugin>@<marketplace>"; bail out on malformed
    // entries rather than rendering "(undefined)" rows.
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    const name = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    for (const r of records ?? []) {
      const installPath = r.installPath;
      let description: string | undefined;
      let capabilities = {
        agents: 0,
        skills: 0,
        commands: 0,
        hooks: 0,
        mcpServers: 0,
      };
      if (installPath) {
        const meta = await readJson<PluginJsonShape>(
          path.join(installPath, ".claude-plugin", "plugin.json"),
        );
        description = meta?.description;
        capabilities = {
          agents: await countMarkdown(path.join(installPath, "agents")),
          skills: await countSkillsDir(path.join(installPath, "skills")),
          commands: await countMarkdown(path.join(installPath, "commands")),
          hooks: await countMarkdown(path.join(installPath, "hooks")),
          mcpServers: 0, // populated below if .mcp.json exists
        };
        // MCP servers ship as a single .mcp.json with mcpServers map
        // — count entries rather than treating presence as binary.
        const mcp = await readJson<{
          mcpServers?: Record<string, unknown>;
        }>(path.join(installPath, ".mcp.json"));
        if (mcp?.mcpServers)
          capabilities.mcpServers = Object.keys(mcp.mcpServers).length;
      }
      out.push({
        id,
        name,
        marketplace,
        scope: r.scope ?? "user",
        version: r.version,
        gitCommitSha: r.gitCommitSha,
        description,
        capabilities,
      });
    }
  }
  // Sort by marketplace first, then plugin name — keeps groups
  // visually stable across reloads.
  out.sort((a, b) => {
    const m = a.marketplace.localeCompare(b.marketplace);
    return m !== 0 ? m : a.name.localeCompare(b.name);
  });
  return out;
}

// Reads the full plugin catalog the user could install — every
// marketplace's .claude-plugin/marketplace.json joined with the
// install-count cache and the installed_plugins.json file. Powers
// the "Discover" tab the CLI shows.
//
// Best-effort throughout: a marketplace whose marketplace.json is
// missing or malformed simply contributes 0 plugins to the catalog
// rather than failing the whole call.
export async function listCatalogPlugins(): Promise<CatalogPluginEntry[]> {
  const base = path.join(os.homedir(), ".claude", "plugins");

  // Install counts — one fetched-at-a-time cache the binary writes;
  // we read it as a static snapshot. Missing file = 0 counts.
  const countsFile = await readJson<{
    counts?: Array<{ plugin?: string; unique_installs?: number }>;
  }>(path.join(base, "install-counts-cache.json"));
  const countsById = new Map<string, number>();
  for (const c of countsFile?.counts ?? []) {
    if (c.plugin && typeof c.unique_installs === "number") {
      countsById.set(c.plugin, c.unique_installs);
    }
  }

  // Installed set — same key the catalog uses, so we just check
  // membership when rendering the Discover row's "installed" badge.
  const installed = await readJson<InstalledPluginsShape>(
    path.join(base, "installed_plugins.json"),
  );
  const installedIds = new Set<string>(
    Object.keys(installed?.plugins ?? {}),
  );

  // Walk each marketplace's catalog file.
  const known = await readJson<KnownMarketplacesShape>(
    path.join(base, "known_marketplaces.json"),
  );
  const out: CatalogPluginEntry[] = [];
  for (const [marketplaceName, info] of Object.entries(known ?? {})) {
    const installLocation = info.installLocation;
    if (!installLocation) continue;
    const catalog = await readJson<{
      plugins?: Array<{
        name?: string;
        description?: string;
        category?: string;
        author?: { name?: string };
        homepage?: string;
      }>;
    }>(path.join(installLocation, ".claude-plugin", "marketplace.json"));
    for (const p of catalog?.plugins ?? []) {
      if (!p.name) continue;
      const id = `${p.name}@${marketplaceName}`;
      out.push({
        id,
        name: p.name,
        marketplace: marketplaceName,
        description: p.description,
        category: p.category,
        author: p.author?.name,
        homepage: p.homepage,
        installs: countsById.get(id),
        installed: installedIds.has(id),
      });
    }
  }

  // Sort by install count desc — same default order the CLI's
  // Discover tab uses (so "frontend-design (721K)" floats to the
  // top). Plugins missing install counts fall to the bottom.
  out.sort((a, b) => {
    const ai = a.installs ?? -1;
    const bi = b.installs ?? -1;
    if (ai !== bi) return bi - ai;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// Lists the marketplaces the binary knows about. Read straight from
// known_marketplaces.json so we surface the same set the user would
// see in `claude plugins marketplace list`.
export async function listMarketplaces(): Promise<MarketplaceEntry[]> {
  const base = path.join(os.homedir(), ".claude", "plugins");
  const known = await readJson<KnownMarketplacesShape>(
    path.join(base, "known_marketplaces.json"),
  );
  if (!known) return [];
  const out: MarketplaceEntry[] = [];
  for (const [name, entry] of Object.entries(known)) {
    out.push({
      name,
      source: entry.source?.source,
      repo: entry.source?.repo,
      installLocation: entry.installLocation,
      lastUpdated: entry.lastUpdated,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function listPluginMarkdown(
  subdir: "agents",
): Promise<Array<{ name: string; description?: string; path: string }>> {
  const out: Array<{ name: string; description?: string; path: string }> = [];
  for (const root of await pluginRoots()) {
    for (const m of await listMarkdown(path.join(root, subdir))) {
      out.push(m);
    }
  }
  return out;
}

interface MarkdownFile {
  name: string;
  description?: string;
  path: string;
}

async function listMarkdown(dir: string): Promise<MarkdownFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: MarkdownFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(dir, entry);
    const meta = await readMarkdownFrontmatter(full);
    out.push({
      name: entry.replace(/\.md$/, ""),
      description: meta?.description,
      path: full,
    });
  }
  return out;
}

// Pulls a YAML-frontmatter `description:` (and optional `name:`) out of
// a markdown file. Tolerant: a file without frontmatter just returns
// undefined — agents/skills without metadata still show up by filename.
async function readMarkdownFrontmatter(
  file: string,
): Promise<{ name?: string; description?: string } | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return undefined;
  }
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] as "name" | "description";
    out[key] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export interface HookEntry {
  event: string;
  // Number of matchers / commands configured for this event. The
  // shape varies (PreToolUse uses matchers, others are flat lists),
  // so we just count whatever array we find.
  count: number;
}

export async function listHooks(configDir: string): Promise<HookEntry[]> {
  const settings = await loadSettings(configDir);
  const hooks = settings.merged.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  return Object.entries(hooks).map(([event, value]) => ({
    event,
    count: Array.isArray(value) ? value.length : 1,
  }));
}

export interface PermissionsView {
  default_mode?: string;
  allow: string[];
  deny: string[];
  ask: string[];
  additional_directories: string[];
}

export async function readPermissions(
  configDir: string,
): Promise<PermissionsView> {
  const settings = await loadSettings(configDir);
  const p = settings.merged.permissions ?? {};
  return {
    default_mode: p.defaultMode,
    allow: p.allow ?? [],
    deny: p.deny ?? [],
    ask: p.ask ?? [],
    additional_directories: p.additionalDirectories ?? [],
  };
}
