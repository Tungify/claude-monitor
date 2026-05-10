import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PhaseNote, PhaseSession, PlanRecord } from "@/lib/plan-types";
import type { SessionSummary } from "@/lib/chat-types";
import { findPlanById } from "@/lib/server/plans";

const exec = promisify(execFile);

// MCP server name. Owner sessions see the tools as
//   mcp__leader__read_plan_state
//   mcp__leader__list_phase_notes
//   mcp__leader__read_phase_diff
// All three are read-only and auto-allowed in canUseTool — they never
// mutate plan.json or any worktree.
//
// "Leader" because the owner session that submit_plan'd is now the
// natural place to ask cross-phase questions: "what's blocking phase
// X?", "did B's API rename land?", "show me what auth/ touched today
// across phases". Phase agents have peer-broadcast notes; this is the
// other half — the planner can read every phase's progress without
// leaving its session.
export const LEADER_MCP_SERVER_NAME = "leader";
export const READ_PLAN_STATE_TOOL_NAME = "read_plan_state";
export const LEADER_LIST_NOTES_TOOL_NAME = "list_phase_notes";
export const READ_PHASE_DIFF_TOOL_NAME = "read_phase_diff";
export const READ_PLAN_STATE_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${READ_PLAN_STATE_TOOL_NAME}`;
export const LEADER_LIST_NOTES_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${LEADER_LIST_NOTES_TOOL_NAME}`;
export const READ_PHASE_DIFF_FQN = `mcp__${LEADER_MCP_SERVER_NAME}__${READ_PHASE_DIFF_TOOL_NAME}`;

export interface LeaderMcpContext {
  // Owner session id. Used purely for diagnostics today; reserved so
  // future tools can scope by ownership without the caller threading it.
  sessionId: string;
  // Resolves the plan_id when the caller omits it. Pulled from the
  // session's latestPlan at call time so the tool follows whatever
  // submit_plan most recently wrote — owners often run with one plan in
  // flight, and forcing them to thread plan_id through every tool call
  // would just be ceremony.
  resolveCurrentPlanId: () => string | undefined;
  // Snapshots a phase session's live status (thinking/idle/errored/
  // rate_limited/...). Wired to sessions.snapshotSession at call site
  // so we don't take a circular import on this module.
  snapshotPhaseSession: (sessionId: string) => SessionSummary | undefined;
}

// Cap on diff body. The SDK ships every tool result through the model
// context; a 5MB diff would torch the budget. 32KB covers most slice-
// sized phase diffs and gives the model a useful preview; for bigger
// changes the leader can call read_phase_diff with stat-only or ask
// the human to bring up the kanban view.
const DIFF_BYTE_CAP = 32 * 1024;

export function createLeaderMcpServer(ctx: LeaderMcpContext) {
  // resolvePlan — small helper used by all three tools to load the
  // plan record. Centralises the "explicit id wins, else fall back to
  // latestPlan" rule and the on-disk reload via findPlanById so the
  // leader always sees the current state, not a stale in-memory copy.
  async function resolvePlan(
    explicit: string | undefined,
  ): Promise<{ plan: PlanRecord } | { error: string }> {
    const planId = explicit ?? ctx.resolveCurrentPlanId();
    if (!planId) {
      return {
        error:
          "No plan_id provided and the owner session has not submitted a plan yet. Call submit_plan first or pass plan_id.",
      };
    }
    const plan = await findPlanById(planId);
    if (!plan) {
      return { error: `Plan ${planId} not found on disk.` };
    }
    return { plan };
  }

  const readPlanState = tool(
    READ_PLAN_STATE_TOOL_NAME,
    "Snapshot the full state of a plan: per-phase status (live SDK status + commit/scope/review badges), pending phases waiting on deps, merge state, integration-review findings, and notes counts. Use this when the user asks about progress, blockers, or wants a cross-phase summary. Read-only — does not affect any session or worktree.",
    {
      plan_id: z
        .string()
        .optional()
        .describe(
          "Plan id to snapshot. Defaults to the current owner session's latest submitted plan when omitted.",
        ),
    },
    async ({ plan_id }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const text = formatPlanState(r.plan, ctx.snapshotPhaseSession);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const listNotes = tool(
    LEADER_LIST_NOTES_TOOL_NAME,
    "List every phase note broadcast on a plan. Notes are siblings' inter-phase broadcasts (API renames, schema changes, contracts established). As the leader you read these to spot cross-phase coordination issues — e.g. phase A renamed something B and C still rely on. Filter by tag and dismissal state.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner session's latest plan."),
      tag: z
        .string()
        .optional()
        .describe(
          "Optional tag filter (case-insensitive). Common tags: 'api-change', 'schema', 'lib-swap', 'contract', 'gotcha'.",
        ),
      include_dismissed: z
        .boolean()
        .optional()
        .describe(
          "When true, include notes the human dismissed in the orchestrator UI. Default false — dismissed notes are usually already addressed.",
        ),
    },
    async ({ plan_id, tag, include_dismissed }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const text = formatNotes(r.plan, {
        tag: tag?.toLowerCase(),
        includeDismissed: !!include_dismissed,
      });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const readDiff = tool(
    READ_PHASE_DIFF_TOOL_NAME,
    "Show what a phase changed against an integration base. Returns `git diff --stat` plus a truncated unified diff (capped at 32KB) so the leader can spot conflicts and contract changes without leaving its session. Use this after a phase commits to see *what* the badge represents — diff against the merge_branch, fall back to 'main'.",
    {
      plan_id: z
        .string()
        .optional()
        .describe("Plan id. Defaults to the owner session's latest plan."),
      phase_slug: z
        .string()
        .min(1)
        .describe("Slug of the phase whose worktree to diff."),
      base: z
        .string()
        .optional()
        .describe(
          "Branch or ref to diff against. Defaults to plan.merge_branch ?? 'main'. Use 'HEAD~1' for the last commit only.",
        ),
      stat_only: z
        .boolean()
        .optional()
        .describe(
          "When true, return only the file/line summary (--stat) and skip the patch body. Use for very large diffs.",
        ),
    },
    async ({ plan_id, phase_slug, base, stat_only }) => {
      const r = await resolvePlan(plan_id);
      if ("error" in r) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: r.error }],
        };
      }
      const worktree = r.plan.worktrees?.find(
        (w) => w.phase_slug === phase_slug,
      );
      if (!worktree) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Phase ${phase_slug} has no worktree on plan ${r.plan.id}.`,
            },
          ],
        };
      }
      const baseRef = base ?? r.plan.merge_branch ?? "main";
      const diffText = await readPhaseDiff(
        worktree.path,
        baseRef,
        !!stat_only,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# Phase \`${phase_slug}\` diff against \`${baseRef}\``,
              `Worktree: \`${worktree.path}\` · branch \`${worktree.branch}\``,
              "",
              diffText,
            ].join("\n"),
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: LEADER_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [readPlanState, listNotes, readDiff],
  });
}

// formatPlanState renders a markdown digest of the plan record. Kept
// dense so the model gets one screenful of state per call; tables make
// per-phase scanning easy. Live SDK status is fused with on-disk plan
// fields so the snapshot matches what the user sees in PhaseBoard.
function formatPlanState(
  plan: PlanRecord,
  snapshotPhase: (sessionId: string) => SessionSummary | undefined,
): string {
  const linkBySlug = new Map<string, PhaseSession>(
    (plan.phase_sessions ?? []).map((p) => [p.phase_slug, p]),
  );
  const pendingSet = new Set(
    (plan.pending_phases ?? []).map((p) => p.phase_slug),
  );

  const lines: string[] = [
    `# Plan: ${plan.title}`,
    `id: \`${plan.id}\` · status: \`${plan.status}\` · cwd: \`${plan.cwd}\``,
    `phases: ${plan.phases.length} · sessions: ${plan.phase_sessions?.length ?? 0} · pending: ${plan.pending_phases?.length ?? 0}`,
    "",
    "## Phases",
    "",
    "| slug | title | run | ctx | commit | scope | review | depends_on |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const phase of plan.phases) {
    const link = linkBySlug.get(phase.slug);
    const live = link ? snapshotPhase(link.session_id) : undefined;
    const runStatus = pendingSet.has(phase.slug)
      ? "pending"
      : (live?.status ?? (link ? "unknown" : "—"));
    // Context window usage from the SDK's /context channel. Surface as
    // "n%" so the leader can spot a phase that's about to blow past
    // the model's effective reasoning window — by the time a session
    // pushes ~80% the user typically wants to summarize/restart it
    // instead of letting it limp on degraded output.
    const ctx = live?.context_usage?.percentage;
    const ctxCell =
      ctx === undefined ? "—" : `${Math.round(ctx)}%${ctx >= 80 ? " ⚠" : ""}`;
    const commit = link?.commit_status
      ? link.commit_status === "committed"
        ? `committed ${link.commit_sha?.slice(0, 7) ?? ""}`
        : link.commit_status
      : "—";
    const scope =
      link?.scope_violations === undefined
        ? phase.scope?.files
          ? "declared"
          : "—"
        : link.scope_violations.length === 0
          ? "ok"
          : `${link.scope_violations.length} violations`;
    const review =
      link?.review_status === undefined
        ? "—"
        : link.review_status === "complete"
          ? `${link.review_findings?.length ?? 0} findings`
          : link.review_status;
    const deps =
      phase.depends_on && phase.depends_on.length > 0
        ? phase.depends_on.map((d) => `\`${d}\``).join(", ")
        : "—";
    lines.push(
      `| \`${phase.slug}\` | ${escapeCell(phase.title)} | ${runStatus} | ${ctxCell} | ${commit} | ${scope} | ${review} | ${deps} |`,
    );
  }

  if ((plan.pending_phases?.length ?? 0) > 0) {
    lines.push("", "## Pending phases (blocked on deps)");
    for (const p of plan.pending_phases ?? []) {
      lines.push(`- \`${p.phase_slug}\` (worktree \`${p.worktree_branch}\`)`);
    }
  }

  if (plan.merge_status) {
    lines.push(
      "",
      `## Merge state — ${plan.merge_status}`,
      `branch: \`${plan.merge_branch ?? "main"}\`${plan.merge_head_sha ? ` · head ${plan.merge_head_sha.slice(0, 7)}` : ""}`,
    );
    if (plan.merge_results && plan.merge_results.length > 0) {
      for (const r of plan.merge_results) {
        const sha = r.sha ? ` ${r.sha.slice(0, 7)}` : "";
        const err = r.error ? ` — ${r.error}` : "";
        lines.push(`- \`${r.phase_slug}\` → ${r.status}${sha}${err}`);
      }
    }
    if (plan.merge_error) {
      lines.push("", `Merge error: \`${plan.merge_error}\``);
    }
  }

  if (plan.integration_review_status) {
    lines.push(
      "",
      `## Integration review — ${plan.integration_review_status}`,
    );
    if (plan.integration_review_summary) {
      lines.push("", plan.integration_review_summary);
    }
    const findings = plan.integration_review_findings ?? [];
    if (findings.length > 0) {
      lines.push("", `${findings.length} finding(s):`);
      for (const f of findings) {
        const loc =
          f.file && f.line ? ` (${f.file}:${f.line})` : f.file ? ` (${f.file})` : "";
        lines.push(`- **${f.severity}** ${f.title}${loc}`);
      }
    }
  }

  const notes = plan.notes ?? [];
  const active = notes.filter((n) => !n.dismissed_at).length;
  lines.push(
    "",
    `## Notes — ${active} active / ${notes.length} total`,
    "Use `list_phase_notes` to read the bodies.",
  );

  return lines.join("\n");
}

function formatNotes(
  plan: PlanRecord,
  opts: { tag?: string; includeDismissed: boolean },
): string {
  const all = plan.notes ?? [];
  let filtered: PhaseNote[] = opts.includeDismissed
    ? all
    : all.filter((n) => !n.dismissed_at);
  if (opts.tag) {
    filtered = filtered.filter((n) =>
      (n.tags ?? []).some((t) => t.toLowerCase() === opts.tag),
    );
  }
  if (filtered.length === 0) {
    return opts.tag
      ? `_(no notes match tag '${opts.tag}'${opts.includeDismissed ? "" : " — try include_dismissed=true"})_`
      : `_(no ${opts.includeDismissed ? "" : "active "}notes on this plan)_`;
  }
  const sorted = [...filtered].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  const lines: string[] = [
    `## Phase notes — ${sorted.length} (latest first)`,
    "",
  ];
  for (const note of sorted) {
    const tags =
      note.tags && note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
    const dismissed = note.dismissed_at ? " · dismissed" : "";
    lines.push(
      `### ${note.created_at} — \`${note.phase_slug}\`${tags}${dismissed}`,
    );
    lines.push(note.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function readPhaseDiff(
  worktreePath: string,
  baseRef: string,
  statOnly: boolean,
): Promise<string> {
  // Resolve the merge-base so the diff shows only what the phase
  // contributed, not unrelated commits on baseRef. If baseRef doesn't
  // exist locally (e.g. user typed a branch they didn't fetch), the
  // merge-base call surfaces the error and we bail.
  let base: string;
  try {
    const r = await exec("git", [
      "-C",
      worktreePath,
      "merge-base",
      "HEAD",
      baseRef,
    ]);
    base = r.stdout.trim();
  } catch (err) {
    return formatDiffError(`merge-base failed against ${baseRef}`, err);
  }
  if (base.length === 0) {
    return `_(no merge-base between HEAD and ${baseRef} — unrelated histories)_`;
  }

  let stat: string;
  try {
    const r = await exec("git", [
      "-C",
      worktreePath,
      "diff",
      "--stat",
      `${base}..HEAD`,
    ]);
    stat = r.stdout.trim();
  } catch (err) {
    return formatDiffError("git diff --stat", err);
  }
  if (stat.length === 0) {
    return "_(empty diff — phase has not committed any changes against the base)_";
  }

  if (statOnly) {
    return ["```", stat, "```"].join("\n");
  }

  let patch: string;
  try {
    const r = await exec(
      "git",
      ["-C", worktreePath, "diff", `${base}..HEAD`],
      // 8MB head-room — the slice we surface is capped at 32KB but git
      // emits the full diff before we truncate.
      { maxBuffer: 8 * 1024 * 1024 },
    );
    patch = r.stdout;
  } catch (err) {
    return formatDiffError("git diff (full)", err);
  }

  const truncated =
    patch.length > DIFF_BYTE_CAP
      ? patch.slice(0, DIFF_BYTE_CAP) +
        `\n…(truncated; original ${patch.length} bytes — call again with stat_only=true for the summary)`
      : patch;

  return ["```", stat, "```", "", "```diff", truncated, "```"].join("\n");
}

function formatDiffError(label: string, err: unknown): string {
  const stderr = (err as Error & { stderr?: string }).stderr;
  const msg =
    stderr && stderr.trim().length > 0
      ? stderr.trim()
      : err instanceof Error
        ? err.message
        : String(err);
  return `_${label} errored: ${msg}_`;
}

function escapeCell(s: string): string {
  // Pipe is the column separator in markdown tables; escape any literal
  // pipes in titles. Newlines also break the row, so collapse.
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
