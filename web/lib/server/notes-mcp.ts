import "server-only";

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PhaseNote, PlanRecord } from "@/lib/plan-types";
import { findPlanById, writePlan } from "@/lib/server/plans";

// MCP server name. Phase agents see the tools as
//   mcp__phase_notes__submit_phase_note
//   mcp__phase_notes__list_phase_notes
// Both auto-allowed in canUseTool — they only read/append plan.notes,
// no shell, no fs outside the plan record.
export const NOTES_MCP_SERVER_NAME = "phase_notes";
export const SUBMIT_NOTE_TOOL_NAME = "submit_phase_note";
export const LIST_NOTES_TOOL_NAME = "list_phase_notes";
export const SUBMIT_NOTE_FQN = `mcp__${NOTES_MCP_SERVER_NAME}__${SUBMIT_NOTE_TOOL_NAME}`;
export const LIST_NOTES_FQN = `mcp__${NOTES_MCP_SERVER_NAME}__${LIST_NOTES_TOOL_NAME}`;

export interface NotesMcpContext {
  planId: string;
  phaseSlug: string;
  // Called after a note is appended to the plan record on disk. Used by
  // sessions.ts to nudge any open SSE subscribers / poll watchers.
  onNoteAppended?: (note: PhaseNote, plan: PlanRecord) => void;
}

// Per-plan async lock. Prevents two concurrent submit_phase_note calls
// from racing read-modify-write on plan.json. The window is small but
// real — phases run in parallel and may broadcast at the same instant.
// We store the sentinel (same identity used for cleanup) so the tail
// caller correctly clears the map entry instead of leaking it.
const planLocks = new Map<string, Promise<void>>();

async function withPlanLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
  const prev = planLocks.get(planId) ?? Promise.resolve();
  // Run fn after prev settles regardless of prev's outcome — a previous
  // failure on this plan must not poison subsequent submissions.
  const result = prev.then(fn, fn);
  const sentinel: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  planLocks.set(planId, sentinel);
  try {
    return await result;
  } finally {
    if (planLocks.get(planId) === sentinel) planLocks.delete(planId);
  }
}

function formatNotesAsText(plan: PlanRecord, viewerSlug: string): string {
  const notes = plan.notes ?? [];
  if (notes.length === 0) {
    return "_(no phase notes yet — be the first to broadcast)_";
  }
  const sorted = [...notes].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  const lines: string[] = [
    `## Phase notes (${sorted.length}, latest first)`,
    "",
  ];
  for (const note of sorted) {
    const yours = note.phase_slug === viewerSlug ? " (yours)" : "";
    const tags =
      note.tags && note.tags.length > 0 ? ` [${note.tags.join(", ")}]` : "";
    lines.push(`### ${note.created_at} — ${note.phase_slug}${yours}${tags}`);
    lines.push(note.body);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function createNotesMcpServer(ctx: NotesMcpContext) {
  const submit = tool(
    SUBMIT_NOTE_TOOL_NAME,
    "Broadcast a short note to your sibling phases. Use this when you make a decision they should know about: an API rename, a schema change, a library swap, a contract you established for them to follow. Keep notes terse — 1-3 sentences. Do NOT use this for status updates or progress reports; the orchestrator already tracks those. Notes are append-only and visible to every phase via list_phase_notes.",
    {
      body: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "1-3 sentence broadcast. State what changed or what you committed to, in a way a sibling phase can act on. Example: 'Renamed getUser() to getCurrentUser() in lib/auth/index.ts — update call sites if you rely on it.'",
        ),
      tags: z
        .array(z.string().min(1).max(40))
        .max(8)
        .optional()
        .describe(
          "Optional thematic tags so siblings can scan. Free-form but conventional values: 'api-change', 'schema', 'lib-swap', 'contract', 'gotcha'.",
        ),
    },
    async ({ body, tags }) => {
      const note: PhaseNote = {
        id: randomUUID(),
        phase_slug: ctx.phaseSlug,
        body,
        created_at: new Date().toISOString(),
        ...(tags && tags.length > 0 ? { tags } : {}),
      };
      const plan = await withPlanLock(ctx.planId, async () => {
        const fresh = await findPlanById(ctx.planId);
        if (!fresh) {
          throw new Error(`plan ${ctx.planId} not found on disk`);
        }
        const next = [...(fresh.notes ?? []), note];
        fresh.notes = next;
        await writePlan(fresh);
        return fresh;
      });
      ctx.onNoteAppended?.(note, plan);
      return {
        content: [
          {
            type: "text" as const,
            text: `Note broadcast to ${plan.phases.length - 1} sibling phase(s). Notes count: ${plan.notes?.length ?? 0}.`,
          },
        ],
      };
    },
  );

  const list = tool(
    LIST_NOTES_TOOL_NAME,
    "Read every phase note broadcast on this plan, latest first. Call this at the start of your phase to see what siblings have already established, and any time you suspect a sibling may have changed something you depend on.",
    {},
    async () => {
      const plan = await findPlanById(ctx.planId);
      if (!plan) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Plan ${ctx.planId} not found on disk.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: formatNotesAsText(plan, ctx.phaseSlug),
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: NOTES_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [submit, list],
  });
}
