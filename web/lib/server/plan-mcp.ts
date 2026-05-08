import "server-only";

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PlanRecord } from "@/lib/plan-types";
import { writePlan } from "./plans";

// MCP server name. The model sees the tool as `mcp__plans__submit_plan` —
// any allowedTools / canUseTool gating must use that fully-qualified name.
export const PLAN_MCP_SERVER_NAME = "plans";
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";
export const SUBMIT_PLAN_FQN = `mcp__${PLAN_MCP_SERVER_NAME}__${SUBMIT_PLAN_TOOL_NAME}`;

export interface PlanMcpContext {
  sessionId: string;
  cwd: string;
  onPlanSubmitted: (plan: PlanRecord) => void;
}

// Creates a per-session MCP server hosting the submit_plan tool. The
// handler closes over the calling session so persistence + SSE emission
// stay scoped to the right chat. Re-running this for each session is
// cheap — createSdkMcpServer is just an in-process registry.
export function createPlanMcpServer(ctx: PlanMcpContext) {
  const submitPlan = tool(
    SUBMIT_PLAN_TOOL_NAME,
    "Submit a structured plan dividing the work into phases that can be executed in parallel. Use this only when the user explicitly asks for a plan or asks you to split work across phases. Each phase becomes its own git worktree + Claude Code session.",
    {
      title: z
        .string()
        .min(1)
        .describe("Short title for the overall plan, e.g. 'Migrate payments to v2'."),
      phases: z
        .array(
          z.object({
            slug: z
              .string()
              .regex(
                /^[a-z0-9][a-z0-9-]*$/,
                "lowercase letters, digits and hyphens; must start alphanumeric",
              )
              .describe("Filesystem-safe identifier; must be unique within the plan."),
            title: z.string().min(1),
            description: z
              .string()
              .min(1)
              .describe("What this phase accomplishes — markdown is fine."),
            depends_on: z
              .array(z.string())
              .optional()
              .describe("Slugs of other phases that must finish first."),
          }),
        )
        .min(1),
    },
    async ({ title, phases }) => {
      const slugs = new Set<string>();
      for (const p of phases) {
        if (slugs.has(p.slug)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Duplicate phase slug '${p.slug}'. Slugs must be unique within a plan.`,
              },
            ],
          };
        }
        slugs.add(p.slug);
      }
      for (const p of phases) {
        for (const dep of p.depends_on ?? []) {
          if (!slugs.has(dep)) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Phase '${p.slug}' depends on unknown slug '${dep}'.`,
                },
              ],
            };
          }
        }
      }

      const plan: PlanRecord = {
        id: randomUUID(),
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        title,
        phases,
        status: "submitted",
        created_at: new Date().toISOString(),
      };
      try {
        await writePlan(plan);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to persist plan: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
      ctx.onPlanSubmitted(plan);

      return {
        content: [
          {
            type: "text" as const,
            text: `Plan ${plan.id} with ${phases.length} phase(s) submitted. The user can now review and approve it in the chat panel.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: PLAN_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [submitPlan],
  });
}
