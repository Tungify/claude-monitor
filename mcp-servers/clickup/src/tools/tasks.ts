import { z } from "zod";
import { pickByName, type ClickUpClient } from "../clickup.js";
import {
  clip,
  fmtBytes,
  fmtDate,
  fmtDuration,
  ms,
  parseDate,
  parseDuration,
  PRIORITY,
  priorityName,
  statusName,
  table,
  taskUrl,
  userName,
  type Raw,
} from "../format.js";
import { date, full, taskId, ws, type Module } from "../registry.js";

const DESC_LIMIT = 4000;

// ─────────────────────────── rendering ───────────────────────────

export function briefRow(t: Raw): Raw {
  return {
    id: t.id,
    custom_id: t.custom_id,
    name: t.name,
    status: statusName(t.status),
    priority: priorityName(t.priority),
    assignees: (t.assignees ?? []).map(userName),
    due: fmtDate(t.due_date),
    list: t.list?.name,
    tags: (t.tags ?? []).map((x: Raw) => x.name),
    parent: t.parent,
    folder: t.folder?.hidden ? undefined : t.folder?.name,
    created: fmtDate(t.date_created),
    updated: fmtDate(t.date_updated),
    done: fmtDate(t.date_done ?? t.date_closed),
    points: t.points,
    estimate: t.time_estimate ? fmtDuration(t.time_estimate) : undefined,
  };
}

export const BASE_COLS = ["id", "custom_id", "name", "status", "priority", "assignees", "due", "list"];
export const EXTRA_COLS = ["tags", "parent", "folder", "created", "updated", "done", "points", "estimate"] as const;

// cfDisplay turns a custom field value into something readable:
// dropdown/label uuids become option names, dates and people become
// strings. Unknown shapes pass through untouched.
function cfDisplay(f: Raw): unknown {
  const v = f.value;
  switch (f.type) {
    case "date":
      return fmtDate(v);
    case "users":
      return Array.isArray(v) ? v.map(userName) : v;
    case "tasks":
    case "list_relationship":
      return Array.isArray(v) ? v.map((x: Raw) => x.name ?? x.id) : v;
    case "attachment":
      return Array.isArray(v) ? v.map((x: Raw) => x.title ?? x.id) : v;
    case "location":
      return v?.formatted_address ?? v;
    case "manual_progress":
    case "automatic_progress":
      return v?.percent_complete !== undefined ? `${v.percent_complete}%` : v;
  }
  const opts = f.type_config?.options ?? f.type_config?.sprints;
  if (Array.isArray(opts)) {
    const look = (id: unknown) => {
      const o = opts.find((o: Raw) => o.id === id || o.orderindex === id || String(o.orderindex) === String(id));
      return o ? (o.name ?? o.label ?? o.title ?? id) : id;
    };
    return Array.isArray(v) ? v.map(look) : look(v);
  }
  return v;
}

function depsOf(id: string, deps: Raw[]): Raw {
  return {
    waiting_on: deps.filter((d) => d.task_id === id).map((d) => d.depends_on),
    blocking: deps.filter((d) => d.depends_on === id).map((d) => d.task_id),
  };
}

export const INCLUDE = [
  "description",
  "custom_fields",
  "subtasks",
  "checklists",
  "attachments",
  "dependencies",
  "linked_tasks",
  "watchers",
  "statuses",
] as const;

async function summarizeTask(c: ClickUpClient, t: Raw, inc: Set<string>, fullText?: boolean): Promise<Raw> {
  let type: unknown;
  if (t.custom_item_id) {
    const types = await c.taskTypes(t.team_id).catch(() => [] as Raw[]);
    type = types.find((x) => x.id === t.custom_item_id)?.name ?? t.custom_item_id;
  }
  const spaceId = t.space?.id ? String(t.space.id) : undefined;
  const desc = t.markdown_description || t.text_content || t.description;
  const out: Raw = {
    id: t.id,
    custom_id: t.custom_id,
    name: t.name,
    type,
    status: statusName(t.status),
    priority: priorityName(t.priority),
    assignees: (t.assignees ?? []).map(userName),
    creator: userName(t.creator),
    tags: (t.tags ?? []).map((x: Raw) => x.name),
    due: fmtDate(t.due_date),
    start: fmtDate(t.start_date),
    created: fmtDate(t.date_created),
    updated: fmtDate(t.date_updated),
    done: fmtDate(t.date_done ?? t.date_closed),
    estimate: t.time_estimate ? fmtDuration(t.time_estimate) : undefined,
    tracked: t.time_spent ? fmtDuration(t.time_spent) : undefined,
    points: t.points,
    parent: t.parent,
    list: t.list && { id: t.list.id, name: t.list.name },
    folder: t.folder && !t.folder.hidden ? { id: t.folder.id, name: t.folder.name } : undefined,
    space: spaceId && { id: spaceId, name: t.space.name ?? (await c.spaceName(spaceId, t.list?.id)) },
    description: inc.has("description") || fullText ? desc : clip(desc, DESC_LIMIT),
  };
  const more: Raw = {};
  const section = (key: string, arr: Raw[] | undefined, render: (a: Raw[]) => unknown) => {
    if (!arr?.length) return;
    if (inc.has(key)) out[key] = render(arr);
    else more[key] = arr.length;
  };
  const setFields = (t.custom_fields ?? []).filter((f: Raw) => f.value !== undefined && f.value !== null && f.value !== "");
  section("custom_fields", setFields, (a) => a.map((f) => ({ id: f.id, name: f.name, value: cfDisplay(f) })));
  section("checklists", t.checklists, (a) =>
    a.map((cl) => ({ name: cl.name, items: (cl.items ?? []).map((i: Raw) => `[${i.resolved ? "x" : " "}] ${i.name}`) })),
  );
  section("attachments", t.attachments, (a) =>
    a.map((x) => ({ id: x.id, title: x.title, size: fmtBytes(x.size), date: fmtDate(x.date) })),
  );
  section("dependencies", t.dependencies, (a) => depsOf(t.id, a));
  section("linked_tasks", t.linked_tasks, (a) => a.map((l) => (l.task_id === t.id ? l.link_id : l.task_id)));
  section("watchers", t.watchers, (a) => a.map(userName));
  if (inc.has("subtasks")) {
    out.subtasks = (t.subtasks ?? []).map((s: Raw) => `${s.id} · ${s.name} · ${statusName(s.status)}`);
  }
  if (inc.has("statuses") && t.list?.id) {
    const l = await c.v2<Raw>(`/list/${t.list.id}`);
    out.statuses = (l.statuses ?? []).map((s: Raw) => s.status);
  }
  out.more = more;
  return out;
}

// ─────────────────────────── custom field input ───────────────────────────

const cfInput = z
  .array(
    z.object({
      id: z.string().describe("Field id or name"),
      value: z
        .any()
        .describe("Dropdown/labels: option names or ids; date: YYYY-MM-DD; people: names/ids/\"me\"; relationships: task ids"),
    }),
  )
  .optional();

const tryJSON = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

async function coerceCf(c: ClickUpClient, def: Raw, v: unknown, wsId?: string): Promise<Raw> {
  const str = typeof v === "string" ? v.trim() : undefined;
  const val: any = str && /^[[{]/.test(str) ? tryJSON(str) : v;
  const opts: Raw[] = def.type_config?.options ?? [];
  const optId = (x: unknown) => {
    const s = String(x).toLowerCase();
    const o = opts.find((o) => o.id === x || String(o.name ?? o.label ?? "").toLowerCase() === s);
    if (!o) throw new Error(`"${x}" is not an option of ${def.name}: ${opts.map((o) => o.name ?? o.label).join(", ")}`);
    return o.id;
  };
  const list = (x: unknown): unknown[] =>
    Array.isArray(x) ? x : String(x).split(",").map((s) => s.trim()).filter(Boolean);
  const addRem = async (x: any, users: boolean) => {
    const conv = (a: unknown[]) => (users ? c.resolveUsers(a as string[], wsId) : Promise.resolve(a));
    if (x && typeof x === "object" && !Array.isArray(x) && (x.add || x.rem)) {
      return { add: await conv(x.add ?? []), rem: await conv(x.rem ?? []) };
    }
    return { add: await conv(list(x)), rem: [] };
  };
  switch (def.type) {
    case "drop_down":
      return { value: optId(val) };
    case "labels":
      return { value: list(val).map(optId) };
    case "date": {
      const d = parseDate(String(val))!;
      return { value: d.ms, value_options: { time: d.time } };
    }
    case "number":
    case "currency":
    case "emoji":
      return { value: Number(val) };
    case "checkbox":
      return { value: val === true || str === "true" };
    case "users":
      return { value: await addRem(val, true) };
    case "tasks":
    case "list_relationship":
      return { value: await addRem(val, false) };
    case "manual_progress":
      return { value: typeof val === "object" ? val : { current: Number(val) } };
  }
  return { value: val };
}

async function setCustomFields(
  c: ClickUpClient,
  taskIdVal: string,
  q: Raw,
  defs: Raw[],
  fields: { id: string; value: unknown }[],
  wsId?: string,
): Promise<string[]> {
  const done: string[] = [];
  for (const f of fields) {
    const def = defs.find((d) => d.id === f.id) ?? pickByName(defs, f.id, "custom field");
    const body = await coerceCf(c, def, f.value, wsId);
    await c.send2("POST", `/task/${taskIdVal}/field/${def.id}`, body, q);
    done.push(def.name);
  }
  return done;
}

async function taskTypeId(c: ClickUpClient, name: string, wsId?: string): Promise<number> {
  if (/^(none|task)$/i.test(name)) return 0;
  const types = await c.taskTypes(wsId);
  return Number(pickByName(types, name, "task type").id);
}

function dateFields(body: Raw, key: "due_date" | "start_date", v: string | undefined) {
  if (v === undefined) return;
  if (v === "none") {
    body[key] = null;
    return;
  }
  const d = parseDate(v)!;
  body[key] = d.ms;
  body[`${key}_time`] = d.time;
}

// ─────────────────────────── tools ───────────────────────────

export const tasks: Module = (reg, c) => {
  reg(
    "get_task",
    {
      description:
        "Get one task. Lean by default: big sections appear as counts under `more` — name them in include to expand. \"statuses\" lists valid statuses for update_task.",
      input: { task_id: taskId, include: z.array(z.enum(INCLUDE)).optional(), full, workspace_id: ws },
    },
    async (a) => {
      const inc = new Set<string>(a.include ?? []);
      const t = await c.v2<Raw>(`/task/${a.task_id}`, {
        ...(await c.taskQuery(a.task_id, a.workspace_id)),
        include_subtasks: inc.has("subtasks") || undefined,
        include_markdown_description: true,
      });
      return summarizeTask(c, t, inc, a.full);
    },
  );

  reg(
    "filter_tasks",
    {
      description:
        "Filter tasks by structured fields (OR within a filter, AND across). 100/page; when output says more, call again with the next page. Assignees accept ids, emails, names or \"me\". For keyword search use search.",
      input: {
        list_ids: z.array(z.string()).optional(),
        folder_ids: z.array(z.string()).optional(),
        space_ids: z.array(z.string()).optional(),
        statuses: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        due_date_from: date.optional(),
        due_date_to: date.optional(),
        date_closed_from: date.optional(),
        date_closed_to: date.optional(),
        created_from: date.optional(),
        created_to: date.optional(),
        updated_from: date.optional(),
        updated_to: date.optional(),
        custom_fields: z
          .array(z.object({ field_id: z.string(), operator: z.string().describe("= == != < <= > >= RANGE ANY ALL NOT ANY NOT ALL IS NULL IS NOT NULL"), value: z.any().optional() }))
          .optional(),
        parent: z.string().optional().describe("Only subtasks of this task"),
        include_closed: z.boolean().optional(),
        subtasks: z.boolean().optional().describe("Default true"),
        order_by: z.enum(["id", "created", "updated", "due_date"]).optional(),
        reverse: z.boolean().optional(),
        page: z.number().int().min(0).optional(),
        columns: z.array(z.enum(EXTRA_COLS)).optional().describe("Extra columns"),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const cf = a.custom_fields?.map((f: Raw) => {
        let value = f.value;
        if (typeof value === "string" && /^[<>]=?$|^RANGE$/.test(f.operator)) {
          value = f.operator === "RANGE" ? tryJSON(value) : value;
          if (Array.isArray(value)) value = value.map((x: unknown) => (typeof x === "string" ? (ms(x) ?? x) : x));
          else if (/^\d{4}-/.test(value)) value = ms(value);
        } else if (typeof value === "string" && /^[[{]/.test(value)) value = tryJSON(value);
        return { field_id: f.field_id, operator: f.operator, value };
      });
      const page = a.page ?? 0;
      const data = await c.v2<Raw>(`/team/${wsId}/task`, {
        page,
        order_by: a.order_by,
        reverse: a.reverse,
        subtasks: a.subtasks ?? true,
        include_closed: a.include_closed,
        parent: a.parent,
        "list_ids[]": a.list_ids,
        "project_ids[]": a.folder_ids,
        "space_ids[]": a.space_ids,
        "statuses[]": a.statuses,
        "tags[]": a.tags,
        "assignees[]": a.assignees ? await c.resolveUsers(a.assignees, wsId) : undefined,
        due_date_gt: ms(a.due_date_from),
        due_date_lt: ms(a.due_date_to, true),
        date_done_gt: ms(a.date_closed_from),
        date_done_lt: ms(a.date_closed_to, true),
        date_created_gt: ms(a.created_from),
        date_created_lt: ms(a.created_to, true),
        date_updated_gt: ms(a.updated_from),
        date_updated_lt: ms(a.updated_to, true),
        custom_fields: cf ? JSON.stringify(cf) : undefined,
      });
      const list: Raw[] = data.tasks ?? [];
      const more = data.last_page === false || (data.last_page === undefined && list.length === 100);
      const head = `${list.length} tasks (page ${page}${more ? `; more → page=${page + 1}` : ""})`;
      if (!list.length) return head;
      return `${head}\n${table(list.map(briefRow), [...BASE_COLS, ...(a.columns ?? [])])}`;
    },
  );

  reg(
    "create_task",
    {
      description: "Create a task (or subtask via parent). Always confirm the list with the user.",
      write: true,
      input: {
        list_id: z.string(),
        name: z.string(),
        markdown_description: z.string().optional(),
        status: z.string().optional(),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        assignees: z.array(z.string()).optional().describe("Ids, emails, names or \"me\""),
        tags: z.array(z.string()).optional().describe("Must exist in the space"),
        due_date: date.optional(),
        start_date: date.optional(),
        time_estimate: z.string().optional().describe("\"2h 30m\" or minutes"),
        points: z.number().optional(),
        parent: z.string().optional(),
        task_type: z.string().optional().describe("Type name, e.g. milestone"),
        custom_fields: cfInput,
        workspace_id: ws,
      },
    },
    async (a) => {
      const body: Raw = {
        name: a.name,
        markdown_content: a.markdown_description,
        status: a.status,
        priority: a.priority ? PRIORITY[a.priority] : undefined,
        assignees: a.assignees ? await c.resolveUsers(a.assignees, a.workspace_id) : undefined,
        tags: a.tags,
        time_estimate: a.time_estimate ? parseDuration(a.time_estimate) : undefined,
        points: a.points,
        parent: a.parent ? await c.resolveTaskId(a.parent, a.workspace_id) : undefined,
        custom_item_id: a.task_type ? await taskTypeId(c, a.task_type, a.workspace_id) : undefined,
      };
      dateFields(body, "due_date", a.due_date);
      dateFields(body, "start_date", a.start_date);
      const t = await c.send2<Raw>("POST", `/list/${a.list_id}/task`, body);
      let note = "";
      if (a.custom_fields?.length) {
        try {
          const { fields = [] } = await c.v2<Raw>(`/list/${a.list_id}/field`);
          note = `; fields: ${(await setCustomFields(c, t.id, {}, fields, a.custom_fields, a.workspace_id)).join(", ")}`;
        } catch (e) {
          note = `; custom fields FAILED: ${e instanceof Error ? e.message : e}`;
        }
      }
      return `created ${t.id}${t.custom_id ? ` (${t.custom_id})` : ""} "${t.name}" [${statusName(t.status)}] ${taskUrl(t.id)}${note}`;
    },
  );

  reg(
    "update_task",
    {
      description:
        "Update task fields; omitted fields stay unchanged. assignees REPLACES the current set. Dates/priority/task_type accept \"none\" to clear.",
      write: true,
      destructive: true,
      input: {
        task_id: taskId,
        name: z.string().optional(),
        markdown_description: z.string().optional(),
        status: z.string().optional(),
        priority: z.enum(["urgent", "high", "normal", "low", "none"]).optional(),
        assignees: z.array(z.string()).optional().describe("Ids, emails, names or \"me\""),
        due_date: z.string().optional(),
        start_date: z.string().optional(),
        time_estimate: z.string().optional(),
        points: z.number().optional(),
        parent: z.string().optional().describe("Move subtask under another parent"),
        task_type: z.string().optional(),
        archived: z.boolean().optional(),
        custom_fields: cfInput,
        workspace_id: ws,
      },
    },
    async (a) => {
      const q = await c.taskQuery(a.task_id, a.workspace_id);
      const cur = a.assignees || a.custom_fields?.length ? await c.v2<Raw>(`/task/${a.task_id}`, q) : undefined;
      const body: Raw = {
        name: a.name,
        markdown_content: a.markdown_description,
        status: a.status,
        time_estimate: a.time_estimate ? parseDuration(a.time_estimate) : undefined,
        points: a.points,
        parent: a.parent ? await c.resolveTaskId(a.parent, a.workspace_id) : undefined,
        archived: a.archived,
      };
      if (a.priority) body.priority = a.priority === "none" ? null : PRIORITY[a.priority];
      if (a.task_type) body.custom_item_id = await taskTypeId(c, a.task_type, a.workspace_id);
      dateFields(body, "due_date", a.due_date);
      dateFields(body, "start_date", a.start_date);
      if (a.assignees && cur) {
        const want = new Set(await c.resolveUsers(a.assignees, a.workspace_id));
        const have = new Set<number>((cur.assignees ?? []).map((u: Raw) => Number(u.id)));
        body.assignees = { add: [...want].filter((x) => !have.has(x)), rem: [...have].filter((x) => !want.has(x)) };
      }
      const changed = Object.keys(body).filter((k) => body[k] !== undefined && !k.endsWith("_time"));
      if (changed.length) await c.send2("PUT", `/task/${a.task_id}`, body, q);
      if (a.custom_fields?.length && cur) {
        const id = String(cur.id);
        changed.push(...(await setCustomFields(c, id, {}, cur.custom_fields ?? [], a.custom_fields, a.workspace_id)));
      }
      if (!changed.length) throw new Error("Nothing to update");
      return `updated ${a.task_id}: ${changed.join(", ")}`;
    },
  );

  reg(
    "delete_task",
    { description: "Delete a task. Confirm with the user first.", write: true, destructive: true, input: { task_id: taskId, workspace_id: ws } },
    async (a) => {
      await c.send2("DELETE", `/task/${a.task_id}`, undefined, await c.taskQuery(a.task_id, a.workspace_id));
      return `deleted ${a.task_id}`;
    },
  );

  reg(
    "move_task",
    { description: "Move a task to a new home list.", write: true, input: { task_id: taskId, list_id: z.string(), workspace_id: ws } },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const id = await c.resolveTaskId(a.task_id, wsId);
      await c.send3("PUT", `/workspaces/${wsId}/tasks/${id}/home_list/${a.list_id}`, {});
      return `moved ${a.task_id} → list ${a.list_id}`;
    },
  );

  reg(
    "task_in_list",
    {
      description: "Add a task to an extra list, or remove it from one (not its home list). Needs the Tasks in Multiple Lists ClickApp.",
      write: true,
      input: { task_id: taskId, list_id: z.string(), action: z.enum(["add", "remove"]), workspace_id: ws },
    },
    async (a) => {
      const method = a.action === "add" ? "POST" : "DELETE";
      await c.send2(method, `/list/${a.list_id}/task/${a.task_id}`, undefined, await c.taskQuery(a.task_id, a.workspace_id));
      return `${a.action === "add" ? "added" : "removed"} ${a.task_id} ${a.action === "add" ? "to" : "from"} list ${a.list_id}`;
    },
  );

  reg(
    "merge_tasks",
    {
      description: "Merge source tasks into task_id. Sources are consumed; target wins on conflicts.",
      write: true,
      destructive: true,
      input: { task_id: taskId, source_task_ids: z.array(z.string()).min(1), workspace_id: ws },
    },
    async (a) => {
      const target = await c.resolveTaskId(a.task_id, a.workspace_id);
      const sources = await Promise.all(a.source_task_ids.map((s: string) => c.resolveTaskId(s, a.workspace_id)));
      await c.send2("POST", `/task/${target}/merge`, { source_task_ids: sources });
      return `merged ${sources.join(", ")} → ${a.task_id}`;
    },
  );

  reg(
    "task_tag",
    {
      description: "Add or remove a tag on a task. The tag must already exist in the space.",
      write: true,
      input: { task_id: taskId, tag_name: z.string(), action: z.enum(["add", "remove"]), workspace_id: ws },
    },
    async (a) => {
      const method = a.action === "add" ? "POST" : "DELETE";
      await c.send2(method, `/task/${a.task_id}/tag/${encodeURIComponent(a.tag_name)}`, undefined, await c.taskQuery(a.task_id, a.workspace_id));
      return `${a.action === "add" ? "tagged" : "untagged"} ${a.task_id} "${a.tag_name}"`;
    },
  );

  reg(
    "task_dependency",
    {
      description:
        "Add/remove a blocking dependency. waiting_on: task_id can't start until other is done; blocking: task_id blocks other. Non-blocking relation → task_link.",
      write: true,
      input: {
        task_id: taskId,
        other_task_id: z.string(),
        type: z.enum(["waiting_on", "blocking"]),
        action: z.enum(["add", "remove"]),
        workspace_id: ws,
      },
    },
    async (a) => {
      const id = await c.resolveTaskId(a.task_id, a.workspace_id);
      const other = await c.resolveTaskId(a.other_task_id, a.workspace_id);
      const rel = a.type === "waiting_on" ? { depends_on: other } : { dependency_of: other };
      if (a.action === "add") await c.send2("POST", `/task/${id}/dependency`, rel);
      else await c.send2("DELETE", `/task/${id}/dependency`, undefined, rel);
      return `${a.action === "add" ? "added" : "removed"}: ${a.task_id} ${a.type} ${a.other_task_id}`;
    },
  );

  reg(
    "task_link",
    {
      description: "Link or unlink two tasks (non-blocking relation).",
      write: true,
      input: { task_id: taskId, links_to: z.string(), action: z.enum(["add", "remove"]), workspace_id: ws },
    },
    async (a) => {
      const id = await c.resolveTaskId(a.task_id, a.workspace_id);
      const other = await c.resolveTaskId(a.links_to, a.workspace_id);
      await c.send2(a.action === "add" ? "POST" : "DELETE", `/task/${id}/link/${other}`);
      return `${a.action === "add" ? "linked" : "unlinked"} ${a.task_id} ↔ ${a.links_to}`;
    },
  );
};
