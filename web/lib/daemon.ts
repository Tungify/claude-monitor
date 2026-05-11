// Types mirror the Go shapes in claude-monitor/internal/server. When the
// daemon evolves its wire format, update both sides together — the daemon
// is the source of truth and there's no codegen step.

export interface Window {
  utilization: number;
  resets_at: string | null;
}

// Provider matches the Go `account.Provider` enum. Codex/ChatGPT
// subscription accounts are tagged "openai"; Anthropic-side accounts
// either tag "anthropic" or leave provider empty (the zero value
// pre-dates the multi-provider rewrite). Treat empty as Anthropic.
export type AccountProvider = "anthropic" | "openai" | "";

export interface AccountState {
  name: string;
  config_dir: string;
  email?: string;
  account_uuid?: string;
  /** Empty / missing means Anthropic — see AccountProvider comment. */
  provider?: AccountProvider;
  active: boolean;
  five_hour?: Window;
  weekly?: Window;
  weekly_sonnet?: Window;
  weekly_opus?: Window;
  kicked?: boolean;
  kick_error?: string;
  error?: string;
  /**
   * OpenAI-only. `chatgpt_plan_type` claim from the Codex id_token
   * (plus/pro/team/business/enterprise/edu). Empty for Anthropic rows
   * — clients can use field presence as a provider check too.
   */
  plan_type?: string;
  /**
   * OpenAI-only. JWT `exp` claim of the id_token as RFC3339. Used to
   * show "refresh in Nd" badges; the daemon also drives proactive
   * refresh from this same value.
   */
  token_expires_at?: string;
}

export interface Snapshot {
  accounts: AccountState[];
  active_dir: string;
  fetched_at: string;
}

export interface SwapEvent {
  from_name: string;
  to_name: string;
  from_util: number;
  to_util: number;
  reason: string;
}

export interface DaemonError {
  message: string;
}

// Discriminated union matching server.envelope { type, data }.
export type DaemonEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "swap"; data: SwapEvent }
  | { type: "error"; data: DaemonError };

// Browser hits the Next.js /daemon proxy (rewrite in next.config.ts)
// so EventSource stays same-origin — cross-port SSE hits browser
// anti-tracking even when CORS allows *. Server-side (API routes)
// reaches the daemon directly; relative URLs would have no base in
// Node fetch.
export const DAEMON_URL =
  typeof window === "undefined"
    ? process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:8788"
    : process.env.NEXT_PUBLIC_DAEMON_URL ?? "/daemon";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchHealth(signal?: AbortSignal): Promise<{
  status: string;
  uptime_seconds: number;
}> {
  const res = await fetch(`${DAEMON_URL}/api/health`, { signal });
  return jsonOrThrow(res);
}

export async function fetchAccounts(signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetch(`${DAEMON_URL}/api/accounts`, { signal });
  return jsonOrThrow(res);
}

export async function swapTo(
  ident: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; active_dir: string }> {
  const res = await fetch(`${DAEMON_URL}/api/swap-to`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ident }),
    signal,
  });
  return jsonOrThrow(res);
}

// reloginAccount asks the daemon to spawn Terminal.app running
// `claude auth login` for an existing account. The browser doesn't
// see the OAuth flow itself — the user completes it in the terminal
// and the next ticker refresh picks up the new credentials.
export async function reloginAccount(
  ident: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; config_dir: string }> {
  const res = await fetch(`${DAEMON_URL}/api/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ident }),
    signal,
  });
  return jsonOrThrow(res);
}

// addAccount provisions a fresh per-provider config dir on the daemon
// side and kicks off the matching terminal-based login flow:
//
//   - provider="anthropic" (default) → ~/.claude-<name> + `claude auth login`.
//     `email` is forwarded as `--email` so the OAuth browser pre-fills.
//   - provider="openai" → ~/.codex-<name> + `codex login`. `email` is
//     accepted for UI symmetry but ignored — codex's OAuth provider
//     prompts the user to pick the ChatGPT account interactively, so
//     pre-fill is impossible.
export async function addAccount(
  payload: { name: string; email?: string; provider?: "anthropic" | "openai" },
  signal?: AbortSignal,
): Promise<{ ok: boolean; config_dir: string; name: string }> {
  const res = await fetch(`${DAEMON_URL}/api/account/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return jsonOrThrow(res);
}

// SwapConfig mirrors server.SwapConfigView in Go. Wraps the writable
// auto-swap knobs the TUI's editor exposes — the web UI hits
// /api/swap-config so users don't need to drop into the terminal.
export interface SwapConfig {
  auto_swap: boolean;
  auto_kick: boolean;
  // Ascending tier cascade in percent, e.g. [90, 99, 100]. Daemon
  // sanitizes on write (sort, dedup, clamp 0-100) so the value the UI
  // re-reads after PATCH may differ from what it sent.
  swap_thresholds: number[];
  // "lowest" prefers the freshest account; "highest" drains accounts
  // one at a time.
  pick_order: "lowest" | "highest";
  rebalance_on_reset: boolean;
}

export interface SwapConfigUpdate {
  auto_swap?: boolean;
  auto_kick?: boolean;
  swap_thresholds?: number[];
  pick_order?: "lowest" | "highest";
  rebalance_on_reset?: boolean;
}

export async function fetchSwapConfig(
  signal?: AbortSignal,
): Promise<SwapConfig> {
  const res = await fetch(`${DAEMON_URL}/api/swap-config`, { signal });
  return jsonOrThrow(res);
}

// PATCH-style: omitted fields preserve their existing value, so a UI
// toggling auto_swap can send just that field without re-stating
// thresholds. The daemon returns the new effective view after sanitize
// — the UI should adopt it as the new source of truth so threshold
// edits like "100, 90" reflect their sorted form on the next render.
export async function updateSwapConfig(
  patch: SwapConfigUpdate,
  signal?: AbortSignal,
): Promise<SwapConfig> {
  const res = await fetch(`${DAEMON_URL}/api/swap-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  return jsonOrThrow(res);
}

// WorktreePhase + WorktreeResult mirror the Go shapes in
// internal/server/worktrees.go. The daemon expects branch names per
// phase; web picks the convention (currently `wo/<plan-short>/<slug>`).
export interface WorktreePhasePayload {
  slug: string;
  branch: string;
}

export interface WorktreeResult {
  phase_slug: string;
  path: string;
  branch: string;
}

export async function createWorktrees(
  payload: { plan_id: string; repo_path: string; phases: WorktreePhasePayload[] },
  signal?: AbortSignal,
): Promise<{ worktrees: WorktreeResult[] }> {
  const res = await fetch(`${DAEMON_URL}/api/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return jsonOrThrow(res);
}

// PhaseAssignment mirrors the Go shape in internal/server/phases.go.
// Daemon ranks accounts by 5h utilization (ascending) and round-robins
// when count exceeds the eligible pool, so callers always get exactly
// `count` entries back.
export interface PhaseAssignment {
  config_dir: string;
  account_name: string;
  account_uuid?: string;
  five_hour_utilization: number;
  weekly_utilization: number;
}

export async function assignPhaseAccounts(
  payload: { count: number; exclude?: string[] },
  signal?: AbortSignal,
): Promise<{ assignments: PhaseAssignment[] }> {
  const res = await fetch(`${DAEMON_URL}/api/phases/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return jsonOrThrow(res);
}

// LANStatus mirrors server.LANStatus in the Go side. Driven by
// /api/lan/{status,enable,disable} — see internal/server/lan.go.
//
// The token is sensitive (anyone holding it gets full access to the
// running daemon). It's transmitted over the same-origin proxy back to
// loopback browsers, never persisted in client storage.
export interface LANStatus {
  enabled: boolean;
  auth_enabled?: boolean; // gate is on (true whenever LAN or Public on)
  host: string;
  lan_ip?: string;
  port: number;
  token?: string;
  url?: string; // loopback URL
  lan_url?: string; // LAN URL with ?token= when enabled
  allow_ips?: string;
  pending?: boolean;
}

// PublicStatus mirrors server.PublicStatus. Independent of LANStatus —
// public tunnel can be on while LAN bind stays loopback.
export interface PublicStatus {
  enabled: boolean;
  url?: string; // public HTTPS URL via cloudflared
  pending?: boolean; // tunnel started but URL not yet captured
  allow_ips?: string;
  // Named-tunnel config. Both empty = quick tunnel mode (the default,
  // *.trycloudflare.com); both set = pre-created cloudflared named
  // tunnel. Required for SSE to stream — quick tunnels deliberately
  // buffer text/event-stream GET responses.
  cf_tunnel_name?: string;
  cf_hostname?: string;
  // setup_phase advertises which auto-setup step is currently running
  // ("logging_in" / "creating_tunnel" / "routing_dns"). Empty when no
  // setup is in flight. UI uses this to show step-specific copy.
  setup_phase?: "logging_in" | "creating_tunnel" | "routing_dns" | "";
  error?: string;
}

export async function fetchLANStatus(signal?: AbortSignal): Promise<LANStatus> {
  const res = await fetch(`${DAEMON_URL}/api/lan/status`, { signal });
  return jsonOrThrow(res);
}

// enableLAN toggles the Next.js bind to 0.0.0.0 with a token gate. The
// daemon waits for the new child to bind before returning, so this
// resolves only after the gate is live (~150-300ms typical).
//
// Caller should immediately navigate to `/?token=<status.token>` after
// success — the LAN gate just turned on, and the current cookie-less
// loopback session would otherwise 401 on its next fetch. The redirect
// re-enters proxy.ts's first-touch flow and gets the cookie set.
export async function enableLAN(
  token?: string,
  signal?: AbortSignal,
): Promise<LANStatus> {
  const res = await fetch(`${DAEMON_URL}/api/lan/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token ? { token } : {}),
    signal,
  });
  return jsonOrThrow(res);
}

export async function disableLAN(signal?: AbortSignal): Promise<LANStatus> {
  const res = await fetch(`${DAEMON_URL}/api/lan/disable`, {
    method: "POST",
    signal,
  });
  return jsonOrThrow(res);
}

// QR endpoint is a same-origin SVG asset; using the URL string directly
// in <img src> avoids a fetch+blob dance. The path lives behind the
// daemon proxy so the auth gate covers it the same as everything else.
export function lanQRURL(): string {
  // Cache-bust by status: same QR data ⇒ same URL ⇒ browser caches.
  // Re-rendered after enable/disable because token may rotate.
  return `${DAEMON_URL}/api/lan/qr.svg`;
}

export async function fetchPublicStatus(
  signal?: AbortSignal,
): Promise<PublicStatus> {
  const res = await fetch(`${DAEMON_URL}/api/public/status`, { signal });
  return jsonOrThrow(res);
}

// enablePublic spawns / keeps a `cloudflared tunnel` subprocess + flips
// the auth gate on. allowIPs is the comma-separated list (IPs / CIDRs)
// — empty string = no IP filter (token-only). cfTunnelName/cfHostname
// switch from quick tunnel to a pre-created named tunnel (required for
// SSE to stream). Daemon may take 5-15s for the tunnel to publish a
// URL on cold cloudflared starts; the returned status's `pending: true`
// means "tunnel up but URL not yet captured", and the caller should
// poll fetchPublicStatus().
export async function enablePublic(
  args: { allowIPs: string; cfTunnelName?: string; cfHostname?: string },
  signal?: AbortSignal,
): Promise<PublicStatus> {
  const res = await fetch(`${DAEMON_URL}/api/public/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      allow_ips: args.allowIPs,
      cf_tunnel_name: args.cfTunnelName ?? "",
      cf_hostname: args.cfHostname ?? "",
    }),
    signal,
  });
  return jsonOrThrow(res);
}

export async function disablePublic(signal?: AbortSignal): Promise<PublicStatus> {
  const res = await fetch(`${DAEMON_URL}/api/public/disable`, {
    method: "POST",
    signal,
  });
  return jsonOrThrow(res);
}
