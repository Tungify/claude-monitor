import "server-only";

import { promises as fs } from "node:fs";
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

// Lists MCP servers visible to the session. User-scope entries come
// from <configDir>/settings.{,local.}json; project-scope from
// <cwd>/.claude/settings.{,local.}json. We label each with its scope so
// the user sees whether a server is "always on" vs "only here".
export async function listMcpServers(
  configDir: string,
  cwd: string,
): Promise<McpServerInfo[]> {
  const out: McpServerInfo[] = [];
  const userSettings = await loadSettings(configDir);
  for (const [name, raw] of Object.entries(userSettings.merged.mcpServers ?? {})) {
    out.push(infoFor(name, "user", raw));
  }
  const projectSettings = await loadSettings(path.join(cwd, ".claude"));
  for (const [name, raw] of Object.entries(
    projectSettings.merged.mcpServers ?? {},
  )) {
    out.push(infoFor(name, "project", raw));
  }
  return out;
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
// definitions. Each file's leading frontmatter description (if any) is
// surfaced; we don't parse the YAML rigorously, just the first
// `description:` line.
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
// holds a SKILL.md, picking up the description from its frontmatter.
export async function listSkills(
  configDir: string,
  cwd: string,
): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  for (const [dir, scope] of [
    [path.join(configDir, "skills"), "user"],
    [path.join(cwd, ".claude", "skills"), "project"],
  ] as const) {
    let children: string[];
    try {
      children = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const child of children) {
      const skillFile = path.join(dir, child, "SKILL.md");
      const meta = await readMarkdownFrontmatter(skillFile);
      if (!meta) continue;
      out.push({
        name: child,
        scope,
        description: meta.description,
        path: skillFile,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
