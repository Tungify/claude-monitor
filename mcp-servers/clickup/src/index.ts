#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ClickUpClient, ClickUpError, SpaceCache } from "./clickup.js";

const apiKey = process.env.CLICKUP_API_KEY;
if (!apiKey) {
  console.error("[clickup-mcp] CLICKUP_API_KEY env var is required.");
  process.exit(1);
}

const defaultTeamId = process.env.CLICKUP_TEAM_ID;
const client = new ClickUpClient(apiKey, defaultTeamId);
const spaceCache = new SpaceCache(client);

const server = new McpServer(
  { name: "clickup", version: "0.1.0" },
  {
    instructions: [
      "Read-only ClickUp MCP. Hierarchy: Workspace (team) -> Space -> Folder -> List -> Task.",
      defaultTeamId
        ? `Default workspace_id / team_id: ${defaultTeamId}. Pass team_id to override.`
        : "No default team_id — pass team_id explicitly to any tool that needs it.",
      "Call list_workspaces first if you don't know the workspace_id.",
    ].join(" "),
  },
);

function ok<T>(data: T) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function fail(err: unknown) {
  const msg =
    err instanceof ClickUpError
      ? `ClickUp API ${err.status}: ${err.body || err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

async function safe<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

// Default cap for description text in concise mode. Long enough for an
// LLM to grasp the gist, short enough that comment threads + checklists
// don't blow past the per-tool-call budget. Pass verbose:true to bypass.
const DESC_LIMIT = 4000;

function truncate(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n... [truncated ${s.length - n} chars; pass verbose:true for full]`;
}

type Raw = Record<string, unknown>;

function pickRef(o: unknown): { id?: unknown; name?: unknown } | undefined {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Raw;
  if (r.id === undefined && r.name === undefined) return undefined;
  return { id: r.id, name: r.name };
}

function summarizeTaskBrief(t: Raw): Raw {
  const status = t.status && typeof t.status === "object" ? (t.status as Raw).status : t.status;
  return {
    id: t.id,
    custom_id: t.custom_id || undefined,
    name: t.name,
    url: t.url,
    status,
    assignees: Array.isArray(t.assignees)
      ? (t.assignees as Raw[]).map((a) => a.username || a.email || a.id)
      : undefined,
    due_date: t.due_date,
    list: pickRef(t.list)?.name,
  };
}

// resolveCustomFieldValue maps dropdown-style ids/uuids to their human
// labels via the field's own `type_config.options`. ClickUp returns
// option/sprint/label values as opaque uuids by default (e.g. Working
// Sprint as `4ee8fd66-...`) which are useless to a reader without an
// extra lookup. Falls back to the raw value when the field isn't a
// known options shape — better to surface the id than to drop the value.
function resolveCustomFieldValue(c: Raw): unknown {
  const value = c.value;
  if (value == null || value === "") return value;
  const tc = c.type_config && typeof c.type_config === "object" ? (c.type_config as Raw) : null;
  if (!tc) return value;
  const optionsRaw = (tc.options ?? (tc as Raw).sprints) as unknown;
  if (!Array.isArray(optionsRaw)) return value;
  const options = optionsRaw as Raw[];
  const lookup = (id: unknown): unknown => {
    const opt = options.find((o) => o.id === id || o.orderindex === id);
    if (!opt) return id;
    return opt.name ?? opt.label ?? opt.title ?? id;
  };
  if (Array.isArray(value)) return (value as unknown[]).map(lookup);
  return lookup(value);
}

function summarizeTask(t: Raw): Raw {
  const status = t.status && typeof t.status === "object" ? (t.status as Raw).status : t.status;
  const priority = t.priority && typeof t.priority === "object" ? (t.priority as Raw).priority : t.priority;
  const cf = Array.isArray(t.custom_fields)
    ? (t.custom_fields as Raw[])
        .filter((c) => c.value !== null && c.value !== undefined && c.value !== "")
        .map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          value: resolveCustomFieldValue(c),
        }))
    : undefined;
  const subtasks = Array.isArray(t.subtasks)
    ? (t.subtasks as Raw[]).map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status && typeof s.status === "object" ? (s.status as Raw).status : s.status,
      }))
    : undefined;
  const checklists = Array.isArray(t.checklists)
    ? (t.checklists as Raw[]).map((c) => ({
        name: c.name,
        items: Array.isArray(c.items)
          ? (c.items as Raw[]).map((i) => ({ name: i.name, resolved: i.resolved }))
          : undefined,
      }))
    : undefined;
  return {
    id: t.id,
    custom_id: t.custom_id || undefined,
    name: t.name,
    url: t.url,
    status,
    priority,
    parent: t.parent || undefined,
    list: pickRef(t.list),
    folder: pickRef(t.folder),
    space: pickRef(t.space),
    assignees: Array.isArray(t.assignees)
      ? (t.assignees as Raw[]).map((a) => ({ id: a.id, username: a.username, email: a.email }))
      : undefined,
    watchers_count: Array.isArray(t.watchers) ? (t.watchers as unknown[]).length : undefined,
    tags: Array.isArray(t.tags) ? (t.tags as Raw[]).map((tag) => tag.name) : undefined,
    due_date: t.due_date,
    start_date: t.start_date,
    date_created: t.date_created,
    date_updated: t.date_updated,
    description: truncate(t.markdown_description || t.text_content || t.description, DESC_LIMIT),
    subtasks,
    comment_count: t.comment_count ? Number(t.comment_count) : undefined,
    checklists,
    custom_fields: cf && cf.length > 0 ? cf : undefined,
    attachment_count: Array.isArray(t.attachments) ? (t.attachments as unknown[]).length : undefined,
  };
}

function summarizeTasksList(data: Raw): Raw {
  const tasks = Array.isArray(data.tasks) ? (data.tasks as Raw[]).map(summarizeTaskBrief) : [];
  return { tasks, has_more_tasks: data.has_more_tasks };
}

function summarizeComment(c: Raw): Raw {
  const user = c.user && typeof c.user === "object" ? (c.user as Raw) : {};
  return {
    id: c.id,
    user: user.username || user.email || user.id,
    date: c.date,
    resolved: c.resolved,
    reply_count: c.reply_count ? Number(c.reply_count) : 0,
    comment_text: truncate(c.comment_text, DESC_LIMIT),
  };
}

function summarizeComments(data: Raw): Raw {
  const comments = Array.isArray(data.comments) ? (data.comments as Raw[]).map(summarizeComment) : [];
  return { comments };
}

// enrichSpaceName mutates `space.name` on a task in-place using the
// SpaceCache. ClickUp's task payload only carries `space.id`; this
// fills in the readable name with a cached lookup so summaries stop
// surfacing bare numeric ids. teamId is whichever workspace the call
// targets — falls back to the default env var.
async function enrichSpaceName(task: Raw): Promise<void> {
  const space = task.space;
  if (!space || typeof space !== "object") return;
  const s = space as Raw;
  if (!s.id || s.name) return;
  // Pass list.id as a fallback hint — for spaces the API token can't
  // reach directly, the list payload still carries space.name.
  const list = task.list && typeof task.list === "object" ? (task.list as Raw) : undefined;
  const listIdHint = list?.id ? String(list.id) : undefined;
  const name = await spaceCache.resolveName(String(s.id), listIdHint);
  if (name) s.name = name;
}

async function enrichTaskList(data: Raw): Promise<void> {
  if (!Array.isArray(data.tasks)) return;
  // Promise-cached single fetch per unique space id, parallel across
  // tasks — N tasks sharing K spaces issues K (not N) API calls.
  await Promise.all((data.tasks as Raw[]).map((t) => enrichSpaceName(t)));
}

// ─────────────────────────── Hierarchy ───────────────────────────

server.tool(
  "list_workspaces",
  "List all ClickUp Workspaces (teams) the authenticated user belongs to. Returns each workspace's id and name. Use this first if you don't know which workspace_id to target.",
  {},
  async () => safe(() => client.v2<unknown>("/team")),
);

server.tool(
  "list_spaces",
  "List Spaces in a Workspace. Spaces are the top-level grouping under a workspace.",
  {
    team_id: z
      .string()
      .optional()
      .describe("Workspace id. Defaults to CLICKUP_TEAM_ID env var if set."),
    archived: z.boolean().optional().describe("Include archived spaces. Default: false."),
  },
  async ({ team_id, archived }) =>
    safe(() =>
      client.v2<unknown>(`/team/${client.teamId(team_id)}/space`, {
        archived: archived ?? false,
      }),
    ),
);

server.tool(
  "list_folders",
  "List Folders inside a Space. Sprint folders appear here with `sprint_folder: true`.",
  {
    space_id: z.string().describe("Space id."),
    archived: z.boolean().optional().describe("Include archived folders. Default: false."),
  },
  async ({ space_id, archived }) =>
    safe(() =>
      client.v2<unknown>(`/space/${space_id}/folder`, {
        archived: archived ?? false,
      }),
    ),
);

server.tool(
  "list_folder_lists",
  "List Lists inside a Folder.",
  {
    folder_id: z.string().describe("Folder id."),
    archived: z.boolean().optional().describe("Include archived lists. Default: false."),
  },
  async ({ folder_id, archived }) =>
    safe(() =>
      client.v2<unknown>(`/folder/${folder_id}/list`, {
        archived: archived ?? false,
      }),
    ),
);

server.tool(
  "list_folderless_lists",
  "List folderless Lists directly under a Space (lists not nested in any folder).",
  {
    space_id: z.string().describe("Space id."),
    archived: z.boolean().optional().describe("Include archived lists. Default: false."),
  },
  async ({ space_id, archived }) =>
    safe(() =>
      client.v2<unknown>(`/space/${space_id}/list`, {
        archived: archived ?? false,
      }),
    ),
);

server.tool(
  "get_list",
  "Get a single List by id, including its statuses, due date, and metadata.",
  { list_id: z.string().describe("List id.") },
  async ({ list_id }) => safe(() => client.v2<unknown>(`/list/${list_id}`)),
);

// ─────────────────────────── Tasks ───────────────────────────

server.tool(
  "get_task",
  "Get a single task by id. Returns a concise summary by default (description truncated to 4000 chars, profile/color noise stripped). Pass verbose:true for the raw ClickUp payload. Supports ClickUp short custom IDs when custom_task_ids=true is passed with team_id.",
  {
    task_id: z.string().describe("Task id, e.g. abc123 (or a custom id when custom_task_ids=true)."),
    custom_task_ids: z
      .boolean()
      .optional()
      .describe("Set true to interpret task_id as a custom ID (requires team_id)."),
    team_id: z
      .string()
      .optional()
      .describe("Workspace id, required when custom_task_ids=true."),
    include_subtasks: z.boolean().optional(),
    verbose: z
      .boolean()
      .optional()
      .describe("Return the full raw ClickUp payload instead of the concise summary. Default: false."),
  },
  async ({ task_id, custom_task_ids, team_id, include_subtasks, verbose }) =>
    safe(async () => {
      const data = await client.v2<Raw>(`/task/${task_id}`, {
        custom_task_ids: custom_task_ids ?? undefined,
        team_id: custom_task_ids ? client.teamId(team_id) : team_id,
        include_subtasks: include_subtasks ?? undefined,
        include_markdown_description: true,
      });
      if (verbose) return data;
      await enrichSpaceName(data);
      return summarizeTask(data);
    }),
);

server.tool(
  "list_tasks_in_list",
  "List tasks in a List. Paginated 100 per page (page is 0-indexed). Returns brief task records by default (id/name/status/assignees/due/url); pass verbose:true for the raw ClickUp payload.",
  {
    list_id: z.string().describe("List id."),
    page: z.number().int().min(0).optional().describe("0-indexed page. Default: 0."),
    archived: z.boolean().optional(),
    include_closed: z.boolean().optional().describe("Include closed tasks. Default: false."),
    subtasks: z.boolean().optional().describe("Include subtasks. Default: false."),
    order_by: z.enum(["id", "created", "updated", "due_date"]).optional(),
    reverse: z.boolean().optional(),
    statuses: z
      .array(z.string())
      .optional()
      .describe('Filter by status names, e.g. ["to do","in progress"].'),
    verbose: z.boolean().optional().describe("Return raw payload. Default: false."),
  },
  async (args) =>
    safe(async () => {
      const data = await client.v2<Raw>(`/list/${args.list_id}/task`, {
        page: args.page,
        archived: args.archived,
        include_closed: args.include_closed,
        subtasks: args.subtasks,
        order_by: args.order_by,
        reverse: args.reverse,
        statuses: args.statuses,
      });
      if (args.verbose) return data;
      await enrichTaskList(data);
      return summarizeTasksList(data);
    }),
);

server.tool(
  "search_tasks",
  "Search tasks across a Workspace with filters. Paginated 100 per page. Useful when you only know assignee/space/status, not the list.",
  {
    team_id: z
      .string()
      .optional()
      .describe("Workspace id. Defaults to CLICKUP_TEAM_ID env var."),
    page: z.number().int().min(0).optional(),
    order_by: z.enum(["id", "created", "updated", "due_date"]).optional(),
    reverse: z.boolean().optional(),
    subtasks: z.boolean().optional(),
    include_closed: z.boolean().optional(),
    space_ids: z.array(z.string()).optional(),
    project_ids: z.array(z.string()).optional().describe("Folder ids."),
    list_ids: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional().describe("User ids."),
    tags: z.array(z.string()).optional(),
    due_date_gt: z.number().optional().describe("Unix ms."),
    due_date_lt: z.number().optional().describe("Unix ms."),
    date_updated_gt: z.number().optional().describe("Unix ms."),
    date_updated_lt: z.number().optional().describe("Unix ms."),
    date_created_gt: z.number().optional().describe("Unix ms."),
    date_created_lt: z.number().optional().describe("Unix ms."),
    verbose: z.boolean().optional().describe("Return raw payload. Default: false."),
  },
  async (args) =>
    safe(async () => {
      const teamId = client.teamId(args.team_id);
      const data = await client.v2<Raw>(`/team/${teamId}/task`, {
        page: args.page,
        order_by: args.order_by,
        reverse: args.reverse,
        subtasks: args.subtasks,
        include_closed: args.include_closed,
        space_ids: args.space_ids,
        project_ids: args.project_ids,
        list_ids: args.list_ids,
        statuses: args.statuses,
        assignees: args.assignees,
        tags: args.tags,
        due_date_gt: args.due_date_gt,
        due_date_lt: args.due_date_lt,
        date_updated_gt: args.date_updated_gt,
        date_updated_lt: args.date_updated_lt,
        date_created_gt: args.date_created_gt,
        date_created_lt: args.date_created_lt,
      });
      if (args.verbose) return data;
      await enrichTaskList(data);
      return summarizeTasksList(data);
    }),
);

// ─────────────────────────── Comments ───────────────────────────

server.tool(
  "get_task_comments",
  "List comments on a task (most recent first). Returns concise records (id/user/date/resolved/reply_count/comment_text, text truncated to 4000 chars). Pass verbose:true for raw.",
  {
    task_id: z.string().describe("Task id."),
    start: z
      .number()
      .int()
      .optional()
      .describe("Pagination cursor: unix ms of the last comment from the previous page."),
    start_id: z
      .string()
      .optional()
      .describe("Pagination cursor: id of the last comment from the previous page."),
    verbose: z.boolean().optional().describe("Return raw payload. Default: false."),
  },
  async ({ task_id, start, start_id, verbose }) =>
    safe(async () => {
      const data = await client.v2<Raw>(`/task/${task_id}/comment`, {
        start,
        start_id,
      });
      return verbose ? data : summarizeComments(data);
    }),
);

// ─────────────────────────── Docs (v3) ───────────────────────────

server.tool(
  "list_docs",
  "List Docs in a Workspace (ClickUp v3 API).",
  {
    workspace_id: z
      .string()
      .optional()
      .describe("Workspace id. Defaults to CLICKUP_TEAM_ID env var."),
    limit: z.number().int().min(1).max(100).optional().describe("Default: 50."),
    next_cursor: z.string().optional().describe("Pagination cursor from prior call."),
    parent_id: z.string().optional().describe("Filter docs by parent container id."),
    parent_type: z
      .enum(["SPACE", "FOLDER", "LIST", "EVERYTHING", "WORKSPACE"])
      .optional(),
    deleted: z.boolean().optional(),
    archived: z.boolean().optional(),
  },
  async (args) =>
    safe(() =>
      client.v3<unknown>(`/workspaces/${client.teamId(args.workspace_id)}/docs`, {
        limit: args.limit,
        next_cursor: args.next_cursor,
        parent_id: args.parent_id,
        parent_type: args.parent_type,
        deleted: args.deleted,
        archived: args.archived,
      }),
    ),
);

server.tool(
  "get_doc",
  "Get a single Doc by id (v3 API).",
  {
    doc_id: z.string().describe("Doc id."),
    workspace_id: z.string().optional().describe("Defaults to CLICKUP_TEAM_ID."),
  },
  async ({ doc_id, workspace_id }) =>
    safe(() =>
      client.v3<unknown>(
        `/workspaces/${client.teamId(workspace_id)}/docs/${doc_id}`,
      ),
    ),
);

server.tool(
  "list_doc_pages",
  "Fetch the page tree (PageListing) of a Doc — ids and names of all pages and nested subpages.",
  {
    doc_id: z.string().describe("Doc id."),
    workspace_id: z.string().optional(),
    max_page_depth: z
      .number()
      .int()
      .optional()
      .describe("Use -1 for no limit. Default: -1."),
  },
  async ({ doc_id, workspace_id, max_page_depth }) =>
    safe(() =>
      client.v3<unknown>(
        `/workspaces/${client.teamId(workspace_id)}/docs/${doc_id}/page_listing`,
        { max_page_depth: max_page_depth ?? -1 },
      ),
    ),
);

server.tool(
  "get_doc_page",
  "Get a single Doc page. Content is truncated to 8000 chars by default (long docs blow past tool-call budgets); pass verbose:true for full.",
  {
    doc_id: z.string().describe("Doc id."),
    page_id: z.string().describe("Page id."),
    workspace_id: z.string().optional(),
    content_format: z
      .enum(["text/md", "text/plain"])
      .optional()
      .describe("Output format. Default: text/md."),
    verbose: z.boolean().optional().describe("Return raw payload. Default: false."),
  },
  async ({ doc_id, page_id, workspace_id, content_format, verbose }) =>
    safe(async () => {
      const data = await client.v3<Raw>(
        `/workspaces/${client.teamId(workspace_id)}/docs/${doc_id}/pages/${page_id}`,
        { content_format: content_format ?? "text/md" },
      );
      if (verbose) return data;
      return {
        id: data.id,
        doc_id: data.doc_id,
        name: data.name,
        parent_page_id: data.parent_page_id,
        date_updated: data.date_updated,
        content: truncate(data.content, 8000),
      };
    }),
);

// ─────────────────────────── Boot ───────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[clickup-mcp] ready on stdio");
}

main().catch((err) => {
  console.error("[clickup-mcp] fatal:", err);
  process.exit(1);
});
