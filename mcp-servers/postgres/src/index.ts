#!/usr/bin/env node
// Local Postgres MCP server. Proxies the upstream postgres-mcp
// (crystaldba) tools unchanged — so the chat UI's execute_sql
// playground keeps working — and adds local utility tools, plus
// insert/update/delete tools when the connection allows writes.
//
// Env:
//   DATABASE_URI  required.
//   PG_READ_ONLY  "1" = upstream runs --access-mode=restricted and the
//                 write tools are hidden. Anything else allows writes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { Db } from "./db.js";
import { LOCAL_TOOLS } from "./tools.js";

const uri = process.env.DATABASE_URI?.trim();
if (!uri) {
  console.error("DATABASE_URI is required");
  process.exit(1);
}
const readOnly = process.env.PG_READ_ONLY === "1";

const db = new Db(uri);
// Fail fast so the daemon's connection test reports a bad URI instead
// of a server that boots and then errors on every call.
try {
  await db.ping();
} catch (err) {
  console.error(`cannot connect to database: ${(err as Error).message}`);
  process.exit(1);
}
console.error(`connected to database (${readOnly ? "read-only" : "read-write"})`);

const localTools = LOCAL_TOOLS.filter((t) => !readOnly || !t.write);
const localByName = new Map(localTools.map((t) => [t.name, t]));

// postgres-mcp 0.3 imports mcp.server.fastmcp, which mcp 2.x removed.
const upstream = new Client({ name: "claude-monitor-postgres", version: "0.1.0" });
let upstreamTools: Tool[] = [];
try {
  await upstream.connect(
    new StdioClientTransport({
      command: "uvx",
      args: [
        "--with",
        "mcp<2",
        "postgres-mcp",
        `--access-mode=${readOnly ? "restricted" : "unrestricted"}`,
      ],
      env: { ...(process.env as Record<string, string>), DATABASE_URI: uri },
      stderr: "ignore",
    }),
  );
  upstreamTools = (await upstream.listTools()).tools.filter((t) => !localByName.has(t.name));
} catch (err) {
  console.error(`postgres-mcp unavailable, serving local tools only: ${(err as Error).message}`);
}

const server = new Server(
  { name: "claude-monitor-postgres", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...upstreamTools,
    ...localTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool["inputSchema"],
    })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args = {} } = req.params;
  const local = localByName.get(name);
  if (!local) {
    return (await upstream.callTool({ name, arguments: args })) as CallToolResult;
  }
  try {
    const result = await local.run(db, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
});

async function shutdown(): Promise<void> {
  await upstream.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
