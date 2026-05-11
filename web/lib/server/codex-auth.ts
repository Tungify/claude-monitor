import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Codex stores ChatGPT-subscription tokens in plaintext at
// $CODEX_HOME/auth.json (default ~/.codex/auth.json). This module is
// the TypeScript twin of internal/codex/auth.go + internal/api/openai_refresh.go
// — duplicated here so the orchestrator can read tokens + refresh them
// without round-tripping through the Go daemon's HTTP surface (which
// intentionally doesn't expose raw access_tokens). Keep the two sides
// in sync if either ever rotates the on-disk schema.

// AuthJSON mirrors the on-disk auth.json shape Codex writes. We only
// surface fields we need to consume; round-tripping unknown keys
// through `_extra` keeps a write from dropping fields a newer codex
// version added. (See keychain_envelope_drift memory for the same
// discipline on the Anthropic side.)
export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface CodexAuthJSON {
  OPENAI_API_KEY?: string;
  tokens?: CodexTokens;
  last_refresh?: string;
  auth_mode?: string;
  _extra?: Record<string, unknown>;
}

// CodexIDTokenClaims is the subset of the id_token JWT payload we
// surface. ChatGPT-specific claims live under the
// `https://api.openai.com/auth` namespace — we hoist the ones we care
// about (account_id, plan_type) to top-level for ergonomic access.
export interface CodexIDTokenClaims {
  email?: string;
  subject?: string;
  exp?: number; // Unix seconds
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
}

// ResolvedCodexAuth bundles everything the codex client needs to make
// a Responses API call: a fresh access_token, the chatgpt_account_id
// header value, and metadata for UI surfacing (email, plan_type). The
// configDir round-trip is so the caller can persist a token-refresh
// outcome back to the right file.
export interface ResolvedCodexAuth {
  config_dir: string;
  access_token: string;
  chatgpt_account_id: string;
  email?: string;
  plan_type?: string;
  expires_at?: Date;
}

// codexDefaultDir resolves ~/.codex per Codex's no-CODEX_HOME default.
// $CODEX_HOME is honored if set so the orchestrator respects the same
// env override the codex CLI does. Empty string when home isn't
// resolvable (mirrors the Go side's DefaultDir contract).
export function codexDefaultDir(): string {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const home = os.homedir();
  if (!home) return "";
  return path.join(home, ".codex");
}

const AUTH_FILE = "auth.json";

// CLIENT_ID is the public OAuth client id codex bakes into its
// binaries (codex-rs/login/src/auth/manager.rs). Same trust model as
// Anthropic's: loopback PKCE; no secret to leak. Mirrored from
// internal/api/openai_refresh.go.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";

// REFRESH_SKEW_MS is how early before expiry we proactively refresh.
// 60s matches the Go side's refreshSkew and gives us comfortable
// headroom against a long-running codex turn that drifts past expiry.
const REFRESH_SKEW_MS = 60_000;

export class CodexAuthError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "missing_file"
      | "missing_refresh_token"
      | "refresh_failed"
      | "rate_limited"
      | "expired",
  ) {
    super(message);
    this.name = "CodexAuthError";
  }
}

// readAuthJSON reads + parses a codex config dir's auth.json. Returns
// undefined when the file is missing — callers map that to "not
// authenticated" UX rather than treating it as a hard error.
async function readAuthJSON(
  configDir: string,
): Promise<CodexAuthJSON | undefined> {
  const p = path.join(configDir, AUTH_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  // Preserve unknown keys via _extra so a write doesn't drop fields a
  // newer codex version introduced.
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const auth: CodexAuthJSON = {
    OPENAI_API_KEY: parsed.OPENAI_API_KEY as string | undefined,
    tokens: parsed.tokens as CodexTokens | undefined,
    last_refresh: parsed.last_refresh as string | undefined,
    auth_mode: parsed.auth_mode as string | undefined,
  };
  const known = new Set([
    "OPENAI_API_KEY",
    "tokens",
    "last_refresh",
    "auth_mode",
  ]);
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const k of Object.keys(parsed)) {
    if (!known.has(k)) {
      extra[k] = parsed[k];
      hasExtra = true;
    }
  }
  if (hasExtra) auth._extra = extra;
  return auth;
}

// writeAuthJSON re-serializes the AuthJSON atomically (tmp + rename)
// and chmods to 0600 — same protocol the Go side enforces. We merge
// _extra back so unknown keys round-trip intact.
async function writeAuthJSON(
  configDir: string,
  auth: CodexAuthJSON,
): Promise<void> {
  const final = path.join(configDir, AUTH_FILE);
  const tmp = path.join(configDir, `.${AUTH_FILE}.tmp.${process.pid}`);
  const obj: Record<string, unknown> = { ...(auth._extra ?? {}) };
  if (auth.OPENAI_API_KEY !== undefined)
    obj.OPENAI_API_KEY = auth.OPENAI_API_KEY;
  if (auth.tokens !== undefined) obj.tokens = auth.tokens;
  if (auth.last_refresh !== undefined) obj.last_refresh = auth.last_refresh;
  if (auth.auth_mode !== undefined) obj.auth_mode = auth.auth_mode;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fs.rename(tmp, final);
}

// parseIDTokenClaims decodes a JWT payload without verifying the
// signature — codex itself doesn't verify; the token is trusted by
// virtue of having come through the loopback OAuth flow. Returns
// undefined when the input isn't a JWT or the payload doesn't parse.
export function parseIDTokenClaims(
  idToken: string | undefined,
): CodexIDTokenClaims | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2) return undefined;
  let payload: string;
  try {
    payload = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  } catch {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const claims: CodexIDTokenClaims = {
    email: raw.email as string | undefined,
    subject: raw.sub as string | undefined,
    exp: raw.exp as number | undefined,
  };
  const ns = raw["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  if (ns) {
    claims.chatgpt_account_id = ns.chatgpt_account_id as string | undefined;
    claims.chatgpt_plan_type = ns.chatgpt_plan_type as string | undefined;
    claims.chatgpt_user_id = ns.chatgpt_user_id as string | undefined;
  }
  return claims;
}

// resolveCodexAuth is the high-level entry point: load auth.json for a
// given codex config dir, refresh tokens if within REFRESH_SKEW_MS of
// expiry, persist the refresh outcome back to disk, and return the
// fresh access_token + account_id ready to drop into Responses API
// headers. Throws CodexAuthError on terminal failures so the caller
// can surface a specific error code to the UI.
export async function resolveCodexAuth(
  configDir: string,
): Promise<ResolvedCodexAuth> {
  const auth = await readAuthJSON(configDir);
  if (!auth || !auth.tokens) {
    throw new CodexAuthError(
      `no codex auth.json at ${configDir} (run codex login)`,
      "missing_file",
    );
  }
  if (!auth.tokens.refresh_token) {
    throw new CodexAuthError(
      `auth.json at ${configDir} has no refresh_token (re-run codex login)`,
      "missing_refresh_token",
    );
  }

  let accessToken = auth.tokens.access_token ?? "";
  let claims = parseIDTokenClaims(auth.tokens.id_token);
  const expiresAtMs =
    claims?.exp !== undefined ? claims.exp * 1000 : undefined;
  const needsRefresh =
    expiresAtMs !== undefined &&
    expiresAtMs - Date.now() < REFRESH_SKEW_MS;

  if (needsRefresh) {
    const refreshed = await refreshCodexTokens(auth.tokens.refresh_token);
    auth.tokens.access_token = refreshed.access_token;
    auth.tokens.refresh_token = refreshed.refresh_token;
    if (refreshed.id_token) auth.tokens.id_token = refreshed.id_token;
    auth.last_refresh = new Date().toISOString();
    await writeAuthJSON(configDir, auth);
    accessToken = refreshed.access_token;
    claims = parseIDTokenClaims(auth.tokens.id_token);
  }

  if (!accessToken) {
    throw new CodexAuthError(
      `auth.json at ${configDir} has no access_token after refresh`,
      "expired",
    );
  }

  const accountId =
    claims?.chatgpt_account_id ?? auth.tokens.account_id ?? "";
  if (!accountId) {
    throw new CodexAuthError(
      `id_token at ${configDir} missing chatgpt_account_id claim`,
      "expired",
    );
  }

  return {
    config_dir: configDir,
    access_token: accessToken,
    chatgpt_account_id: accountId,
    email: claims?.email,
    plan_type: claims?.chatgpt_plan_type,
    expires_at: claims?.exp ? new Date(claims.exp * 1000) : undefined,
  };
}

// refreshCodexTokens POSTs to auth.openai.com/oauth/token. Mirrors
// RefreshOpenAI in internal/api/openai_refresh.go — same client_id,
// same grant_type, same scope. Unlike Anthropic's refresh, OpenAI's
// response doesn't carry expires_in; the expiry lives in the new
// id_token's JWT exp claim.
//
// 429 surfaces as CodexAuthError(kind="rate_limited") so the UI can
// distinguish "wait then retry" from "re-auth required." Other
// non-200s are wrapped as kind="refresh_failed" with a body preview.
async function refreshCodexTokens(oldRefresh: string): Promise<{
  access_token: string;
  refresh_token: string;
  id_token: string;
}> {
  const res = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: oldRefresh,
      scope: "openid profile email",
    }),
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new CodexAuthError(
      `codex refresh rate-limited (retry-after=${retryAfter ?? "?"})`,
      "rate_limited",
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new CodexAuthError(
      `codex refresh HTTP ${res.status}: ${body.slice(0, 200)}`,
      "refresh_failed",
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new CodexAuthError(
      "codex refresh response missing tokens",
      "refresh_failed",
    );
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token ?? "",
  };
}

// listCodexConfigDirs scans the home directory for ~/.codex* entries
// containing auth.json. Mirrors the Go side's account discovery (see
// internal/codex/auth.go LooksLikeCodexDir) but narrowed to what the
// orchestrator needs: a list of authenticated codex slots the UI can
// offer when prompting "which codex account to hand off to?".
export interface CodexAccountModel {
  slug: string;
  display_name: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: string[];
}

export interface CodexSlot {
  config_dir: string;
  name: string;
  email?: string;
  plan_type?: string;
  // Per-account model list lifted from <configDir>/models_cache.json.
  // Filtered to {visibility:"list", supported_in_api:true}. Undefined
  // when the cache is missing (account was authed but the user hasn't
  // run a codex command that triggers the cache refresh yet) — UI
  // falls back to the static CODEX_MODELS list in that case.
  models?: CodexAccountModel[];
}

export async function listCodexConfigDirs(): Promise<CodexSlot[]> {
  const home = os.homedir();
  if (!home) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(home);
  } catch {
    return [];
  }
  const out: CodexSlot[] = [];
  for (const name of entries) {
    if (!name.startsWith(".codex")) continue;
    const dir = path.join(home, name);
    const stat = await fs.stat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) continue;
    const auth = await readAuthJSON(dir).catch(() => undefined);
    if (!auth?.tokens?.refresh_token) continue;
    const claims = parseIDTokenClaims(auth.tokens.id_token);
    const models = await readModelsCache(dir).catch(() => undefined);
    // Display name strips the leading ".codex" prefix so the dropdown
    // shows "default" for ~/.codex and the account suffix for siblings
    // (~/.codex-work → "work").
    const displayName =
      name === ".codex" ? "default" : name.replace(/^\.codex[-_]?/, "");
    out.push({
      config_dir: dir,
      name: displayName,
      email: claims?.email,
      plan_type: claims?.chatgpt_plan_type,
      models,
    });
  }
  return out;
}

// readModelsCache loads <configDir>/models_cache.json (codex CLI's
// per-account cache of the /models endpoint response) and returns the
// listable+API-supported subset. Schema shape lifted from a live
// codex install:
//   { fetched_at, etag, client_version, models: [{ slug, display_name,
//     description, default_reasoning_level, supported_reasoning_levels:
//     [{effort, description}], visibility, supported_in_api, ... }] }
// We surface only what the picker needs and silently ignore unknown
// fields. Missing file → undefined (callers fall back to the static
// CODEX_MODELS list).
async function readModelsCache(
  configDir: string,
): Promise<CodexAccountModel[] | undefined> {
  const p = path.join(configDir, "models_cache.json");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
  type CacheEntry = {
    slug?: string;
    display_name?: string;
    description?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{ effort?: string }>;
    visibility?: string;
    supported_in_api?: boolean;
  };
  let parsed: { models?: CacheEntry[] };
  try {
    parsed = JSON.parse(raw) as { models?: CacheEntry[] };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.models)) return undefined;
  const out: CodexAccountModel[] = [];
  for (const m of parsed.models) {
    if (!m.slug) continue;
    if (m.visibility && m.visibility !== "list") continue;
    if (m.supported_in_api === false) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((r) => r?.effort)
          .filter((s): s is string => Boolean(s))
      : undefined;
    out.push({
      slug: m.slug,
      display_name: m.display_name ?? m.slug,
      description: m.description,
      default_reasoning_level: m.default_reasoning_level,
      supported_reasoning_levels: efforts,
    });
  }
  return out;
}
