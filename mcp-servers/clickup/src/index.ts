#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClickUpClient, ClickUpError } from "./clickup.js";
import { json } from "./format.js";
import { READ_ONLY, type Reg } from "./registry.js";
import { collab } from "./tools/collab.js";
import { files } from "./tools/files.js";
import { tasks } from "./tools/tasks.js";
import { time } from "./tools/time.js";
import { workspace } from "./tools/workspace.js";

const apiKey = process.env.CLICKUP_API_KEY;
if (!apiKey) {
  console.error("[clickup-mcp] CLICKUP_API_KEY env var is required.");
  process.exit(1);
}

const defaultTeamId = process.env.CLICKUP_TEAM_ID || undefined;
const client = new ClickUpClient(apiKey, defaultTeamId);

const server = new McpServer(
  { name: "clickup", version: "0.2.0" },
  {
    instructions: [
      "ClickUp: workspace › space › folder › list › task.",
      defaultTeamId ? `Default workspace_id ${defaultTeamId}.` : "Pass workspace_id when the token sees several workspaces.",
      "Task URL = https://app.clickup.com/t/<id>; link tasks as [name](url).",
      "task_id accepts custom ids (DEV-12). Dates: YYYY-MM-DD or YYYY-MM-DD HH:MM, local time.",
      "Output is compact: tables drop empty columns; `more` = sections expandable via include.",
      READ_ONLY ? "Read-only mode: write tools are disabled." : "",
    ]
      .filter(Boolean)
      .join(" "),
  },
);

function errorText(err: unknown): string {
  if (err instanceof ClickUpError) return `ClickUp ${err.status}: ${err.body.slice(0, 500) || err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// CLICKUP_ENABLED_TOOLS / CLICKUP_DISABLED_TOOLS (comma lists) trim the
// tool surface further — fewer tools listed = fewer tokens per session.
const csv = (s?: string) => new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const enabled = csv(process.env.CLICKUP_ENABLED_TOOLS);
const disabled = csv(process.env.CLICKUP_DISABLED_TOOLS);

const reg: Reg = (name, cfg, fn) => {
  if (cfg.write && READ_ONLY) return;
  if ((enabled.size && !enabled.has(name)) || disabled.has(name)) return;
  server.registerTool(
    name,
    {
      description: cfg.description,
      inputSchema: cfg.input,
      annotations: {
        readOnlyHint: !cfg.write,
        destructiveHint: cfg.write ? !!cfg.destructive : undefined,
      },
    },
    (async (args: unknown) => {
      try {
        const out = await fn(args);
        return { content: [{ type: "text" as const, text: typeof out === "string" ? out : json(out) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
      }
    }) as any,
  );
};

for (const register of [tasks, workspace, collab, time, files]) register(reg, client);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`[clickup-mcp] ready on stdio${READ_ONLY ? " (read-only)" : ""}`);
}

main().catch((err) => {
  console.error("[clickup-mcp] fatal:", err);
  process.exit(1);
});
