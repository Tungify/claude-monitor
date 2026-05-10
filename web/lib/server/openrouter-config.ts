import "server-only";

import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Single global config file for orchestrator-level settings the user
// edits in the UI (vs per-session state, which lives next to the
// transcript jsonl). Sits beside session-store's directory so a future
// `~/.claude-monitor/` cleanup wipes both.
const CONFIG_FILE = path.join(os.homedir(), ".claude-monitor", "config.json");

// OpenRouter routes Anthropic-shaped traffic through their gateway, so
// the SDK doesn't need a parallel client — we just point ANTHROPIC_BASE_URL
// at OpenRouter and override the per-tier model env vars. The SDK still
// runs the Claude binary, MCP servers, plan flow, permission prompts —
// only the model on the other end of the HTTP call changes.
//
// `models` maps the binary's three internal tiers (opus / sonnet / haiku)
// to OpenRouter model ids. The CLI picks one tier per request based on
// the `--model` flag; with these env vars set it sends the mapped OR id
// instead. Leave a tier blank to fall through to whatever the binary
// defaults to (which OpenRouter will reject if it's not a known id).
export interface OpenRouterConfig {
  api_key: string;
  models: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
}

interface ConfigFile {
  version: 1;
  openrouter?: OpenRouterConfig;
}

const EMPTY: ConfigFile = { version: 1 };

async function readFile(): Promise<ConfigFile> {
  try {
    const text = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(text) as Partial<ConfigFile>;
    if (parsed.version !== 1) return EMPTY;
    return { version: 1, openrouter: parsed.openrouter };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    console.warn("[openrouter-config] read failed:", err);
    return EMPTY;
  }
}

async function writeFile(file: ConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2));
  await fs.rename(tmp, CONFIG_FILE);
}

export async function loadOpenRouterConfig(): Promise<OpenRouterConfig | undefined> {
  const file = await readFile();
  return file.openrouter;
}

// Sync variant for the session spawn path. buildLiveSession is sync
// (it constructs the SDK Query before any await point) and ripping
// async up through every caller — createSession, resumeSession,
// rehydratePhaseSessions — would touch a lot of unrelated code. The
// config file is small JSON; reading it sync per spawn is cheap, and
// session spawns are rare relative to message turns.
export function loadOpenRouterConfigSync(): OpenRouterConfig | undefined {
  try {
    const text = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(text) as Partial<ConfigFile>;
    if (parsed.version !== 1) return undefined;
    return parsed.openrouter;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn("[openrouter-config] sync read failed:", err);
    return undefined;
  }
}

// Saves the OR block. Pass undefined to clear it (e.g. user wiped the
// API key in the dialog). All sessions read this fresh on each spawn,
// so changes take effect on the next session — existing sessions keep
// the env they were spawned with.
export async function saveOpenRouterConfig(
  config: OpenRouterConfig | undefined,
): Promise<void> {
  const file = await readFile();
  if (config === undefined) {
    delete file.openrouter;
  } else {
    file.openrouter = config;
  }
  await writeFile(file);
}

// Builds the env var block that buildLiveSession merges onto process.env
// when a session has provider === "openrouter". Returns undefined when
// OR isn't configured (caller should reject the spawn rather than
// silently fall back to native — that would route to the wrong provider
// without telling anyone).
//
// ANTHROPIC_API_KEY is set to "" explicitly: the SDK / binary picks it
// up before ANTHROPIC_AUTH_TOKEN, so leaving the user's real Anthropic
// key in the inherited env shadows the OR token and hits the wrong API.
export function openRouterEnv(
  config: OpenRouterConfig,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: config.api_key,
    ANTHROPIC_API_KEY: "",
  };
  if (config.models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.models.opus;
  if (config.models.sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.models.sonnet;
  }
  if (config.models.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.models.haiku;
  }
  return env;
}

// Public-safe view of the config: hides the API key behind a boolean so
// the browser can know whether OR is configured without the secret
// crossing the wire on every GET.
export interface OpenRouterStatus {
  configured: boolean;
  has_key: boolean;
  models: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
}

export function statusFor(config: OpenRouterConfig | undefined): OpenRouterStatus {
  if (!config) {
    return { configured: false, has_key: false, models: {} };
  }
  return {
    configured: true,
    has_key: config.api_key.length > 0,
    models: { ...config.models },
  };
}
