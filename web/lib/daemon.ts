// Types mirror the Go shapes in claude-monitor/internal/server. When the
// daemon evolves its wire format, update both sides together — the daemon
// is the source of truth and there's no codegen step.

export interface Window {
  utilization: number;
  resets_at: string | null;
}

export interface AccountState {
  name: string;
  config_dir: string;
  email?: string;
  account_uuid?: string;
  active: boolean;
  five_hour?: Window;
  weekly?: Window;
  weekly_sonnet?: Window;
  weekly_opus?: Window;
  kicked?: boolean;
  kick_error?: string;
  error?: string;
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
