import "server-only";

import { listAllPlans } from "@/lib/server/plans";
import { restartPhaseSession } from "@/lib/server/plan-scheduler";
import { snapshotSession } from "@/lib/server/sessions";
import type { RateLimitInfo } from "@/lib/chat-types";

// rl-watchdog auto-restarts phase sessions that hit a rate-limit ceiling
// hard enough to drop out of the SDK's internal retry loop. Without
// this, an errored phase sits idle until the human notices and clicks
// the manual restart button — which defeats the unattended-overnight
// scheduling the orchestrator is built for.
//
// The SDK retries up to CLAUDE_CODE_MAX_RETRIES (default 10) on every
// rate_limit_event. If those retries exhaust we surface SessionStatus
// "errored" with the last RateLimitInfo still pinned to the session.
// Once `resetsAt` falls into the past we know a fresh attempt has
// budget again — we restart the phase using the same code path the
// manual button uses.
//
// Cooldown: skip phases whose `spawned_at` is within the last
// COOLDOWN_MS. spawnPhaseSession bumps spawned_at on each restart, so
// this naturally throttles loops where a freshly-spawned session
// immediately re-errors (e.g. account is wedged in a different way and
// the RL info we trust is stale).

const TICK_MS = 60_000;
const COOLDOWN_MS = 90_000;
// resetsAt has second precision and clocks drift; wait a small grace
// window past the reset before assuming the bucket is open. Anthropic's
// own dashboards do something similar.
const RESET_GRACE_MS = 15_000;
// rate_limited (not errored) sessions usually clear themselves via the
// SDK's internal retry. Only nudge them if they've been past resetsAt
// for a while, suggesting the retry never landed (network drop, binary
// wedged, …).
const STUCK_RATE_LIMITED_MS = 5 * 60_000;

const WATCHDOG_KEY = Symbol.for("claude-monitor.web.rl-watchdog");
type WatchdogGlobal = typeof globalThis & {
  [WATCHDOG_KEY]?: ReturnType<typeof setInterval>;
};
const g = globalThis as WatchdogGlobal;

export function startRlResetWatchdog(): void {
  if (g[WATCHDOG_KEY]) return; // already armed (HMR / repeated import)
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Don't keep the Node process alive just for the watchdog — when
  // every other handle is closed we want a clean exit.
  if (typeof timer.unref === "function") timer.unref();
  g[WATCHDOG_KEY] = timer;
}

export function stopRlResetWatchdog(): void {
  const timer = g[WATCHDOG_KEY];
  if (!timer) return;
  clearInterval(timer);
  delete g[WATCHDOG_KEY];
}

async function tick(): Promise<void> {
  let plans;
  try {
    plans = await listAllPlans();
  } catch (err) {
    console.warn("[rl-watchdog] listAllPlans failed:", err);
    return;
  }
  const now = Date.now();
  for (const plan of plans) {
    if (plan.status !== "approved") continue;
    const phaseBySlug = new Map(plan.phases.map((p) => [p.slug, p]));
    for (const link of plan.phase_sessions ?? []) {
      try {
        if (
          link.commit_status === "clean" ||
          link.commit_status === "committed"
        ) {
          continue;
        }
        const spawnedAt = Date.parse(link.spawned_at);
        if (Number.isFinite(spawnedAt) && now - spawnedAt < COOLDOWN_MS) {
          continue;
        }
        const phase = phaseBySlug.get(link.phase_slug);
        if (!phase) continue;
        const worktree = plan.worktrees?.find(
          (w) => w.phase_slug === link.phase_slug,
        );
        if (!worktree) continue;

        const snap = snapshotSession(link.session_id);
        if (!snap) continue;
        if (!shouldRestart(snap.summary.status, snap.summary.rate_limit, now)) {
          continue;
        }

        console.log(
          `[rl-watchdog] restarting phase ${plan.id}/${link.phase_slug} (status=${snap.summary.status}, resetsAt=${snap.summary.rate_limit?.resetsAt})`,
        );
        await restartPhaseSession({ plan, phase, link, worktree });
      } catch (err) {
        // One bad entry shouldn't kill the sweep.
        console.warn(
          `[rl-watchdog] sweep failed for ${plan.id}/${link.phase_slug}:`,
          err,
        );
      }
    }
  }
}

// shouldRestart encodes the policy. Exported only for unit-style tests
// (none yet) — runtime callers go through tick().
export function shouldRestart(
  status: string,
  rl: RateLimitInfo | undefined,
  now: number,
): boolean {
  if (!rl?.resetsAt) return false;
  const resetMs = rl.resetsAt * 1000;
  if (status === "errored") {
    // SDK gave up — restart as soon as the bucket has plausibly opened.
    return now >= resetMs + RESET_GRACE_MS;
  }
  if (status === "rate_limited") {
    // SDK is supposedly retrying internally. Only intervene if the
    // window has been open long enough that a healthy retry should
    // already have moved us out of this state.
    return now >= resetMs + STUCK_RATE_LIMITED_MS;
  }
  return false;
}
