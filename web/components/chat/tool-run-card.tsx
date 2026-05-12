"use client";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageBubble } from "./message-bubble";
import { SqlExecutionCard } from "./sql-execution-card";
import { classifyDbTool } from "@/lib/mcp-db-tools";

interface Props {
  messages: SDKMessage[];
}

// ToolRunCard wraps a streak of tool-only assistant turns + their
// matching tool_result echoes in one collapsible. Default-collapsed —
// the user opted into "gom thành 1 block": they want the noise out of
// the way unless they specifically open it. Header shows op count and
// the first few distinct tool names so the streak is recognisable
// without expanding.
//
// One exception: when the streak contains DB MCP query tool calls
// from any configured connection, those render as dedicated
// SqlExecutionCards OUTSIDE the collapsible — the SQL + result table
// is the whole point and burying it under "click to expand" defeats
// the chat-as-data-explorer intent.
export function ToolRunCard({ messages }: Props) {
  const { totalCalls, toolNames } = summariseRun(messages);
  const sqlRuns = extractSqlRuns(messages);
  const visible = toolNames.slice(0, 4);
  const hiddenCount = toolNames.length - visible.length;
  // When every tool call in this streak became a SqlExecutionCard there
  // is nothing else worth surfacing — the collapsible would just repeat
  // the same SQL + result rendered as raw bubbles. Hide it in that case
  // so a single-call SQL turn renders as just the playground card.
  const showCollapsible = totalCalls > sqlRuns.length;
  return (
    <div className="min-w-0 space-y-2">
      {sqlRuns.map((s) => (
        <SqlExecutionCard
          key={s.toolUseId}
          toolName={s.toolName}
          connectionName={s.connectionName}
          driver={s.driver}
          sql={s.sql}
          initialContent={s.resultContent}
          initialIsError={s.resultIsError}
        />
      ))}
      {showCollapsible && (
      <details className="group rounded-md border-l-2 border-l-emerald-500/40 bg-muted/15 px-2 py-1">
        <summary className="flex cursor-pointer select-none items-baseline gap-2 text-sm">
          <span className="text-emerald-500" aria-hidden>
            ●
          </span>
          <span className="font-medium">Tool run</span>
          <span className="font-mono text-xs text-muted-foreground">
            · {totalCalls} {totalCalls === 1 ? "op" : "ops"}
          </span>
          {visible.length > 0 && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              · {visible.join(", ")}
              {hiddenCount > 0 ? `, +${hiddenCount}` : ""}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/70 group-open:hidden">
            click to expand
          </span>
        </summary>
        <div className="mt-1 space-y-1 border-t border-border/40 pt-1.5">
          {messages.map((m, i) => (
            <MessageBubble key={messageKey(m, i)} msg={m} />
          ))}
        </div>
      </details>
      )}
    </div>
  );
}

function summariseRun(messages: SDKMessage[]): {
  totalCalls: number;
  toolNames: string[];
} {
  let totalCalls = 0;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) {
      if (b.type === "tool_use") {
        totalCalls++;
        if (!seen.has(b.name)) {
          seen.add(b.name);
          ordered.push(b.name);
        }
      }
    }
  }
  return { totalCalls, toolNames: ordered };
}

// SqlRun pairs a DB MCP tool_use with its matching tool_result. We
// scan the whole streak (which may contain multiple SQL executions)
// and return one record per tool_use that targets a recognized DB
// MCP server. Tools we don't recognize fall through to the generic
// collapsible.
interface SqlRun {
  toolUseId: string;
  toolName: string;
  connectionName: string;
  driver: "postgres" | "clickhouse";
  sql: string;
  resultContent?: Array<{ type: string; text?: string }>;
  resultIsError?: boolean;
}

function extractSqlRuns(messages: SDKMessage[]): SqlRun[] {
  // 1) Find every DB MCP tool_use and capture its sql input.
  const runs: Map<string, SqlRun> = new Map();
  for (const m of messages) {
    if (m.type !== "assistant") continue;
    for (const b of m.message.content) {
      if (b.type !== "tool_use") continue;
      const classified = classifyDbTool(b.name);
      if (!classified) continue;
      const sql = extractSql(b.input as Record<string, unknown>, classified.driver);
      if (!sql) continue;
      runs.set(b.id, {
        toolUseId: b.id,
        toolName: b.name,
        connectionName: classified.connectionName,
        driver: classified.driver,
        sql,
      });
    }
  }
  if (runs.size === 0) return [];

  // 2) Hydrate the matching tool_result content (text blocks only —
  // both upstream servers ship JSON-as-text, no images / structured
  // blocks).
  for (const m of messages) {
    if (m.type !== "user") continue;
    const content = m.message.content;
    if (typeof content === "string") continue;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const run = runs.get(b.tool_use_id);
      if (!run) continue;
      if (Array.isArray(b.content)) {
        run.resultContent = b.content.map((blk) => ({
          type: blk.type,
          text: blk.type === "text" ? blk.text : undefined,
        }));
      } else if (typeof b.content === "string") {
        run.resultContent = [{ type: "text", text: b.content }];
      }
      run.resultIsError = b.is_error;
    }
  }

  // Preserve insertion order so the card list mirrors the chat
  // timeline.
  return Array.from(runs.values());
}

function extractSql(
  input: Record<string, unknown> | undefined,
  driver: "postgres" | "clickhouse",
): string {
  if (!input) return "";
  // postgres-mcp's execute_sql uses `sql`; mcp-clickhouse's run_query
  // uses `query`. Each server's canonical arg name — see toolForDriver
  // in /api/mcp/db/execute/route.ts.
  const key = driver === "postgres" ? "sql" : "query";
  const v = input[key];
  return typeof v === "string" ? v : "";
}

function messageKey(msg: SDKMessage, idx: number): string {
  const uuid = (msg as { uuid?: string }).uuid;
  return uuid ? `${msg.type}:${uuid}` : `${msg.type}:${idx}`;
}
