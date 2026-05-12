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
