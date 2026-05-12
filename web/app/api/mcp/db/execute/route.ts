import { NextResponse, type NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findConnectionByName } from "@/lib/server/postgres-mcp";

// POST /api/mcp/db/execute
// Body: { connection: string, sql: string }
//
// Spawns the connection's uvx-based MCP server, calls its read-only
// query tool, returns the parsed result. Process is torn down before
// the response ships — we don't keep a long-lived MCP client because
// the orchestrator's own SDK sessions already maintain one each.
//
// Read-only is enforced at the MCP layer: postgres-mcp runs with
// --access-mode=restricted (READ ONLY transaction + pglast AST guard);
// mcp-clickhouse defaults CLICKHOUSE_ALLOW_WRITE_ACCESS=false and
// rejects DDL/DML at the tool level. We do NOT set the
// write-allowing flags — there's no UI affordance to do so, and
// adding one would defeat the entire point of this integration.

export const runtime = "nodejs";

type ExecuteBody = {
  connection: string;
  sql: string;
};

// toolForDriver returns the canonical read-only query tool name each
// upstream MCP server exposes. Postgres-mcp's primary surface is
// `execute_sql`; mcp-clickhouse exposes `run_query` (with read-only
// enforcement in the default config). Redis doesn't have an
// equivalent single-query tool, so we reject it before reaching this.
function toolForDriver(
  driver: "postgres" | "clickhouse",
): { name: string; argKey: string } {
  switch (driver) {
    case "postgres":
      return { name: "execute_sql", argKey: "sql" };
    case "clickhouse":
      return { name: "run_query", argKey: "query" };
  }
}

export async function POST(req: NextRequest) {
  let body: ExecuteBody;
  try {
    body = (await req.json()) as ExecuteBody;
  } catch (err) {
    return NextResponse.json(
      { error: `invalid json: ${(err as Error).message}` },
      { status: 400 },
    );
  }
  if (!body?.connection || typeof body.connection !== "string") {
    return NextResponse.json(
      { error: "connection name is required" },
      { status: 400 },
    );
  }
  if (!body.sql || typeof body.sql !== "string") {
    return NextResponse.json(
      { error: "sql is required" },
      { status: 400 },
    );
  }

  const conn = findConnectionByName(body.connection);
  if (!conn) {
    return NextResponse.json(
      {
        error: `no DB connection named "${body.connection}" — register one in the /mcp panel first`,
      },
      { status: 412 },
    );
  }
  if (conn.driver !== "postgres" && conn.driver !== "clickhouse") {
    return NextResponse.json(
      {
        error: `connection "${body.connection}" is a ${conn.driver} server; the SQL replay surface only supports postgres and clickhouse`,
      },
      { status: 400 },
    );
  }

  const transport = new StdioClientTransport({
    command: conn.command,
    args: conn.args,
    env: { ...(process.env as Record<string, string>), ...conn.env },
  });

  const client = new Client(
    { name: "claude-monitor-db-replay", version: "1.0.0" },
    { capabilities: {} },
  );
  // Hard cap on the whole spawn+call cycle. Cold-start of uvx
  // (downloading the package on first use) can take a while; 30s is
  // generous after the first run and bounded enough that a hung
  // server can't tie up a Node worker indefinitely.
  const overall = AbortSignal.timeout(30_000);
  const { name: toolName, argKey } = toolForDriver(conn.driver);

  try {
    await client.connect(transport);
    const result = await client.callTool(
      {
        name: toolName,
        arguments: { [argKey]: body.sql },
      },
      undefined,
      { signal: overall },
    );
    return NextResponse.json({
      ok: true,
      connection: conn.name,
      driver: conn.driver,
      tool: toolName,
      content: result.content,
      isError: result.isError ?? false,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: (err as Error).message,
      },
      { status: 502 },
    );
  } finally {
    // Always tear down the transport / child process so a panicking
    // server doesn't leak. close() is idempotent.
    try {
      await client.close();
    } catch {
      // ignored
    }
  }
}
