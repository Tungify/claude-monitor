import type pg from "pg";

import { Db, ident, qualified, type Querier } from "./db.js";

// Local tools sit next to the 9 proxied postgres-mcp tools. Reads run
// in a READ ONLY transaction that is always rolled back; writes are
// registered only when the connection allows writes, and each one
// rolls back when it would touch more than max_rows rows.

const MAX_OUTPUT_ROWS = 200;
const MAX_INSERT_ROWS = 500;
const DEFAULT_MAX_AFFECTED = 100;

type Args = Record<string, unknown>;

export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  run: (db: Db, args: Args) => Promise<unknown>;
}

const tableProps = {
  table: { type: "string", description: "Table name (unquoted)." },
  schema: { type: "string", description: "Schema name. Default: public." },
};

const whereProp = {
  type: "string",
  description:
    "SQL boolean expression without the WHERE keyword. Use $1, $2… placeholders bound from `params` instead of inlining values.",
};

const paramsProp = {
  type: "array",
  description: "Values bound to the $n placeholders in `where`.",
  items: {},
};

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

function requireStr(args: Args, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`${key} is required`);
  return v;
}

function int(args: Args, key: string, def: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Math.min(v, max);
}

function params(args: Args): unknown[] {
  const v = args.params;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("params must be an array");
  return v;
}

function whereClause(where: string | undefined): string {
  return where ? ` WHERE (${where})` : "";
}

function capped(res: pg.QueryResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    row_count: res.rowCount,
    rows: res.rows.slice(0, MAX_OUTPUT_ROWS),
  };
  if (res.rows.length > MAX_OUTPUT_ROWS) {
    out.truncated = `showing ${MAX_OUTPUT_ROWS} of ${res.rows.length} rows`;
  }
  return out;
}

async function regclass(q: Querier, args: Args): Promise<string> {
  const name = qualified(requireStr(args, "table"), str(args, "schema"));
  const res = await q.rows("SELECT to_regclass($1)::oid AS oid", [name]);
  const oid = res.rows[0]?.oid;
  if (!oid) throw new Error(`table not found: ${name}`);
  return String(oid);
}

// guardAffected rolls the write back (by throwing inside the tx) when
// it touched more rows than the caller said it expected.
function guardAffected(res: pg.QueryResult, max: number): void {
  if ((res.rowCount ?? 0) > max) {
    throw new Error(
      `would affect ${res.rowCount} rows, more than max_rows=${max}; rolled back. Narrow the WHERE or raise max_rows.`,
    );
  }
}

export const LOCAL_TOOLS: LocalTool[] = [
  {
    name: "list_tables",
    description:
      "List tables, views and materialized views with estimated row counts and total on-disk size, largest first.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Only this schema. Default: all user schemas." },
        pattern: { type: "string", description: "ILIKE filter on the name, e.g. %order%." },
      },
    },
    run: (db, args) =>
      db.read(async (q) =>
        capped(
          await q.rows(
            `SELECT n.nspname AS schema, c.relname AS name,
                    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned'
                                   WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' END AS kind,
                    GREATEST(c.reltuples, 0)::bigint AS est_rows,
                    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
                    obj_description(c.oid, 'pg_class') AS comment
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p', 'v', 'm')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg_toast%'
                AND ($1::text IS NULL OR n.nspname = $1)
                AND ($2::text IS NULL OR c.relname ILIKE $2)
              ORDER BY pg_total_relation_size(c.oid) DESC`,
            [str(args, "schema") ?? null, str(args, "pattern") ?? null],
          ),
        ),
      ),
  },
  {
    name: "describe_table",
    description:
      "Columns, constraints (PK/unique/check/FK), foreign keys pointing at this table, and indexes.",
    write: false,
    inputSchema: { type: "object", properties: tableProps, required: ["table"] },
    run: (db, args) =>
      db.read(async (q) => {
        const oid = await regclass(q, args);
        const columns = await q.rows(
          `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                  NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default,
                  col_description(a.attrelid, a.attnum) AS comment
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
          [oid],
        );
        const constraints = await q.rows(
          `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE conrelid = $1::oid ORDER BY contype, conname`,
          [oid],
        );
        const referencedBy = await q.rows(
          `SELECT conrelid::regclass::text AS from_table, conname AS name,
                  pg_get_constraintdef(oid) AS definition
             FROM pg_constraint WHERE confrelid = $1::oid AND contype = 'f'
            ORDER BY 1, 2`,
          [oid],
        );
        const indexes = await q.rows(
          `SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition,
                  pg_size_pretty(pg_relation_size(x.indexrelid)) AS size
             FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
            WHERE x.indrelid = $1::oid ORDER BY i.relname`,
          [oid],
        );
        return {
          columns: columns.rows,
          constraints: constraints.rows,
          referenced_by: referencedBy.rows,
          indexes: indexes.rows,
        };
      }),
  },
  {
    name: "sample_rows",
    description: "Return a few rows of a table, optionally filtered and ordered.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        ...tableProps,
        where: whereProp,
        params: paramsProp,
        order_by: { type: "string", description: "Column to order by." },
        desc: { type: "boolean", description: "Order descending. Default: false." },
        limit: { type: "integer", description: `Rows to return. Default 20, max ${MAX_OUTPUT_ROWS}.` },
      },
      required: ["table"],
    },
    run: (db, args) =>
      db.read(async (q) => {
        const orderBy = str(args, "order_by");
        const order = orderBy
          ? ` ORDER BY ${ident(orderBy)}${args.desc === true ? " DESC" : ""}`
          : "";
        const limit = int(args, "limit", 20, MAX_OUTPUT_ROWS);
        return capped(
          await q.rows(
            `SELECT * FROM ${qualified(requireStr(args, "table"), str(args, "schema"))}${whereClause(str(args, "where"))}${order} LIMIT ${limit}`,
            params(args),
          ),
        );
      }),
  },
  {
    name: "count_rows",
    description: "Exact row count of a table, optionally filtered.",
    write: false,
    inputSchema: {
      type: "object",
      properties: { ...tableProps, where: whereProp, params: paramsProp },
      required: ["table"],
    },
    run: (db, args) =>
      db.read(async (q) => {
        const res = await q.rows(
          `SELECT count(*)::bigint AS count FROM ${qualified(requireStr(args, "table"), str(args, "schema"))}${whereClause(str(args, "where"))}`,
          params(args),
        );
        return res.rows[0];
      }),
  },
  {
    name: "find_columns",
    description: "Find columns whose name matches a pattern across all user tables.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Substring to match, case-insensitive." },
        schema: { type: "string", description: "Only this schema. Default: all user schemas." },
      },
      required: ["pattern"],
    },
    run: (db, args) =>
      db.read(async (q) =>
        capped(
          await q.rows(
            `SELECT table_schema AS schema, table_name AS table, column_name AS column, data_type
               FROM information_schema.columns
              WHERE column_name ILIKE '%' || $1 || '%'
                AND table_schema NOT IN ('pg_catalog', 'information_schema')
                AND ($2::text IS NULL OR table_schema = $2)
              ORDER BY 1, 2, 3`,
            [requireStr(args, "pattern"), str(args, "schema") ?? null],
          ),
        ),
      ),
  },
  {
    name: "active_queries",
    description: "Sessions on this database with their running query and how long it has run.",
    write: false,
    inputSchema: {
      type: "object",
      properties: {
        include_idle: { type: "boolean", description: "Include idle sessions. Default: false." },
      },
    },
    run: (db, args) =>
      db.read(async (q) =>
        capped(
          await q.rows(
            `SELECT pid, usename AS user, application_name, state, wait_event_type, wait_event,
                    (now() - query_start)::text AS running_for, left(query, 500) AS query
               FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND ($1::boolean OR state IS DISTINCT FROM 'idle')
              ORDER BY query_start NULLS LAST`,
            [args.include_idle === true],
          ),
        ),
      ),
  },
  {
    name: "blocking_locks",
    description: "Sessions currently blocked on a lock, and which sessions block them.",
    write: false,
    inputSchema: { type: "object", properties: {} },
    run: (db) =>
      db.read(async (q) =>
        capped(
          await q.rows(
            `SELECT a.pid AS blocked_pid, pg_blocking_pids(a.pid) AS blocked_by,
                    (now() - a.query_start)::text AS waiting_for, left(a.query, 500) AS blocked_query
               FROM pg_stat_activity a
              WHERE cardinality(pg_blocking_pids(a.pid)) > 0`,
          ),
        ),
      ),
  },
  {
    name: "insert_rows",
    description: `Insert rows into a table in one transaction (max ${MAX_INSERT_ROWS}). Keys missing from a row get the column DEFAULT.`,
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        ...tableProps,
        rows: {
          type: "array",
          description: "Objects mapping column name to value.",
          items: { type: "object" },
        },
      },
      required: ["table", "rows"],
    },
    run: (db, args) => {
      const rows = args.rows;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("rows must be a non-empty array");
      if (rows.length > MAX_INSERT_ROWS) throw new Error(`at most ${MAX_INSERT_ROWS} rows per call`);
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r as object)))];
      if (columns.length === 0) throw new Error("rows have no columns");
      const values: unknown[] = [];
      const tuples = rows.map((r) => {
        const row = r as Record<string, unknown>;
        const cells = columns.map((c) => {
          if (!(c in row)) return "DEFAULT";
          values.push(row[c]);
          return `$${values.length}`;
        });
        return `(${cells.join(", ")})`;
      });
      return db.write(async (q) =>
        capped(
          await q.rows(
            `INSERT INTO ${qualified(requireStr(args, "table"), str(args, "schema"))} (${columns.map(ident).join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`,
            values,
          ),
        ),
      );
    },
  },
  {
    name: "update_rows",
    description:
      "Update rows matching `where`. Rolls back if more than max_rows rows would change.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        ...tableProps,
        set: { type: "object", description: "Column name to new value." },
        where: whereProp,
        params: paramsProp,
        max_rows: { type: "integer", description: `Abort above this many rows. Default ${DEFAULT_MAX_AFFECTED}.` },
      },
      required: ["table", "set", "where"],
    },
    run: (db, args) => {
      const set = args.set as Record<string, unknown> | undefined;
      if (!set || typeof set !== "object" || Object.keys(set).length === 0) {
        throw new Error("set must be a non-empty object");
      }
      const where = requireStr(args, "where");
      const values = [...params(args)];
      const assignments = Object.entries(set).map(([col, v]) => {
        values.push(v);
        return `${ident(col)} = $${values.length}`;
      });
      const max = int(args, "max_rows", DEFAULT_MAX_AFFECTED, Number.MAX_SAFE_INTEGER);
      return db.write(async (q) => {
        const res = await q.rows(
          `UPDATE ${qualified(requireStr(args, "table"), str(args, "schema"))} SET ${assignments.join(", ")}${whereClause(where)} RETURNING *`,
          values,
        );
        guardAffected(res, max);
        return capped(res);
      });
    },
  },
  {
    name: "delete_rows",
    description:
      "Delete rows matching `where`. Rolls back if more than max_rows rows would be deleted.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        ...tableProps,
        where: whereProp,
        params: paramsProp,
        max_rows: { type: "integer", description: `Abort above this many rows. Default ${DEFAULT_MAX_AFFECTED}.` },
      },
      required: ["table", "where"],
    },
    run: (db, args) => {
      const max = int(args, "max_rows", DEFAULT_MAX_AFFECTED, Number.MAX_SAFE_INTEGER);
      return db.write(async (q) => {
        const res = await q.rows(
          `DELETE FROM ${qualified(requireStr(args, "table"), str(args, "schema"))}${whereClause(requireStr(args, "where"))} RETURNING *`,
          params(args),
        );
        guardAffected(res, max);
        return capped(res);
      });
    },
  },
];
