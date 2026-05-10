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
// `models` is the user's saved favorites — each entry is a full OR
// model id (e.g. "openai/gpt-oss-120b"). The composer's model picker
// lists these directly so the user picks an OR model the same way they
// would pick "Opus" or "Sonnet" on the native provider. `default_model`
// is the fallback OR id used at session-spawn time when the user hasn't
// already chosen one — it also seeds the in-chat picker on a fresh
// session.
export interface OpenRouterConfig {
  api_key: string;
  models: string[];
  default_model?: string;
}

interface ConfigFile {
  version: 1;
  openrouter?: OpenRouterConfig | LegacyOpenRouterConfig;
}

// Old shape — favored Anthropic tiers (opus/sonnet/haiku) as the
// switching axis. Kept around so existing config files migrate
// transparently on first read; we never write this shape back.
interface LegacyOpenRouterConfig {
  api_key: string;
  models: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
  default_model?: string;
}

const EMPTY: ConfigFile = { version: 1 };

function migrate(
  raw: OpenRouterConfig | LegacyOpenRouterConfig | undefined,
): OpenRouterConfig | undefined {
  if (!raw) return undefined;
  if (Array.isArray((raw as OpenRouterConfig).models)) {
    const cur = raw as OpenRouterConfig;
    return {
      api_key: cur.api_key,
      models: [...cur.models],
      default_model: cur.default_model,
    };
  }
  // Legacy tier shape — flatten the dict's values into a unique list,
  // keeping insertion order (opus → sonnet → haiku). The first
  // non-empty tier becomes the default since the legacy semantics
  // treated it as the headline mapping.
  const legacy = raw as LegacyOpenRouterConfig;
  const tiered = [legacy.models.opus, legacy.models.sonnet, legacy.models.haiku]
    .filter((s): s is string => Boolean(s && s.length > 0));
  const seen = new Set<string>();
  const models: string[] = [];
  for (const id of tiered) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return {
    api_key: legacy.api_key,
    models,
    default_model: legacy.default_model ?? models[0],
  };
}

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
  return migrate(file.openrouter);
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
    return migrate(parsed.openrouter);
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
// when a session has provider === "openrouter". `activeModel` is the
// session's chosen OR id (drives all three tier env vars); when omitted
// we fall back to config.default_model so the binary still has *some*
// id to send for any tier it requests.
//
// ANTHROPIC_API_KEY is set to "" explicitly: the SDK / binary picks it
// up before ANTHROPIC_AUTH_TOKEN, so leaving the user's real Anthropic
// key in the inherited env shadows the OR token and hits the wrong API.
//
// The three ANTHROPIC_DEFAULT_*_MODEL vars are all set to the SAME id:
// the binary still asks for an opus / sonnet / haiku tier per request,
// but with the user picking a single OR model we want every tier to
// resolve to that pick. OpenRouter sees the model id directly in the
// request body either way; the env vars are just the tier-resolution
// fallback when the SDK doesn't pass an explicit model.
export function openRouterEnv(
  config: OpenRouterConfig,
  activeModel?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: config.api_key,
    ANTHROPIC_API_KEY: "",
  };
  const id = activeModel || config.default_model || config.models[0];
  if (id) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = id;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = id;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = id;
  }
  return env;
}

// Public-safe view of the config: hides the API key behind a boolean so
// the browser can know whether OR is configured without the secret
// crossing the wire on every GET.
export interface OpenRouterStatus {
  configured: boolean;
  has_key: boolean;
  models: string[];
  default_model?: string;
}

export function statusFor(config: OpenRouterConfig | undefined): OpenRouterStatus {
  if (!config) {
    return { configured: false, has_key: false, models: [] };
  }
  return {
    configured: true,
    has_key: config.api_key.length > 0,
    models: [...config.models],
    default_model: config.default_model,
  };
}
