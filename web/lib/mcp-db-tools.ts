// Shared parser for DB MCP tool names. The chat panel, tool-run card,
// and session permission synthesizer all need to recognize the
// `mcp__<conn>__execute_sql` / `mcp__<conn>__run_query` shape; keeping
// the regex in one place avoids drift (e.g. one site allowing hyphens
// while another doesn't).
//
// connection name charset matches the Go-side `connections.nameRe`:
// `[a-z][a-z0-9_]*`. Hyphens are forbidden because some downstream
// parsers choke on them in the SDK's `mcp__<name>__<tool>` flattening.
export const MCP_DB_TOOL_RE = /^mcp__([a-z][a-z0-9_]*)__(execute_sql|run_query)$/;

// Every tool the postgres server (mcp-servers/postgres) exposes: the
// proxied postgres-mcp tools plus the local ones. "Always allow" on
// any of them authorizes the whole tool name, like execute_sql.
const PG_TOOLS = [
  "execute_sql",
  "list_schemas",
  "list_objects",
  "get_object_details",
  "explain_query",
  "analyze_workload_indexes",
  "analyze_query_indexes",
  "analyze_db_health",
  "get_top_queries",
  "list_tables",
  "describe_table",
  "sample_rows",
  "count_rows",
  "find_columns",
  "active_queries",
  "blocking_locks",
  "insert_rows",
  "update_rows",
  "delete_rows",
];

export const MCP_DB_ANY_TOOL_RE = new RegExp(
  `^mcp__([a-z][a-z0-9_]*)__(run_query|${PG_TOOLS.join("|")})$`,
);

export interface DbToolMatch {
  connectionName: string;
  driver: "postgres" | "clickhouse";
}

// classifyDbTool returns the (connection, driver) tuple when `name`
// is a DB MCP query tool, or null otherwise. Non-query tools from the
// same servers (analyze_db_health, list_objects, …) intentionally
// don't match — they don't carry a SQL payload worth lifting into a
// playground card.
export function classifyDbTool(name: string): DbToolMatch | null {
  const m = MCP_DB_TOOL_RE.exec(name);
  if (!m) return null;
  return {
    connectionName: m[1]!,
    driver: m[2] === "execute_sql" ? "postgres" : "clickhouse",
  };
}
