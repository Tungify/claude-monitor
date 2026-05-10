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
  scope: "user" | "project";
  type?: string;
  // Display-friendly target: command for stdio, url for http/sse.
  target?: string;
  raw: McpServerEntry;
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

// pluginRoots walks ~/.claude/plugins/marketplaces/<repo>/<plugin>
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
    const repoDir = path.join(base, repo);
    let plugins: string[];
    try {
      plugins = await fs.readdir(repoDir);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      out.push(path.join(repoDir, plugin));
    }
  }
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
