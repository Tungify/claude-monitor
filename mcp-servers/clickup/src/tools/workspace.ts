import { z } from "zod";
import { findMembers, isCustomTaskId, pickByName, type ClickUpClient } from "../clickup.js";
import { clip, fmtDate, json, ms, parseDate, PRIORITY, table, userName, type Raw } from "../format.js";
import { date, full, READ_ONLY, ws, type Module } from "../registry.js";
import { briefRow } from "./tasks.js";

const ROLE: Record<number, string> = { 1: "owner", 2: "admin", 3: "member", 4: "guest" };

// fold lowercases and strips diacritics so "tung" matches "Tùng".
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

function memberRow(m: Raw): Raw {
  return { id: m.id, username: m.username, email: m.email, role: ROLE[m.role] ?? m.role };
}

async function folderById(c: ClickUpClient, a: Raw): Promise<string> {
  if (a.folder_id) return a.folder_id;
  if (!a.folder_name) throw new Error("folder_id or folder_name required");
  const spaces = await c.tree(a.workspace_id);
  const space = a.space_id
    ? spaces.find((s) => String(s.id) === a.space_id)
    : a.space_name
      ? pickByName(spaces, a.space_name, "space")
      : undefined;
  const pool = (space ? [space] : spaces).flatMap((s) => s.folders.map((f: Raw) => ({ ...f, where: s.name })));
  return String(pickByName(pool, a.folder_name, "folder").id);
}

// keep filters a raw payload down to the named keys (at any depth),
// preserving the containers that lead to them.
function keepKeys(v: unknown, keys: Set<string>): unknown {
  if (Array.isArray(v)) {
    const out = v.map((x) => keepKeys(x, keys)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out: Raw = {};
    for (const [k, val] of Object.entries(v)) {
      if (keys.has(k)) out[k] = val;
      else if (val && typeof val === "object") {
        const sub = keepKeys(val, keys);
        if (sub !== undefined) out[k] = sub;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

export const workspace: Module = (reg, c) => {
  reg(
    "list_workspaces",
    { description: "Workspaces this token can access.", input: {} },
    async () =>
      table(
        (await c.teams()).map((t) => ({ id: t.id, name: t.name, members: t.members?.length })),
        ["id", "name", "members"],
      ),
  );

  reg(
    "get_workspace_hierarchy",
    {
      description: "Spaces → folders (end with /) → lists as an indented tree with #ids and (task counts).",
      input: {
        space_ids: z.array(z.string()).optional(),
        max_depth: z.enum(["0", "1", "2"]).optional().describe("0 spaces, 1 +folders, 2 +lists (default)"),
        workspace_id: ws,
      },
    },
    async (a) => {
      const depth = Number(a.max_depth ?? 2);
      const spaces = (await c.tree(a.workspace_id, true)).filter(
        (s) => !a.space_ids?.length || a.space_ids.includes(String(s.id)),
      );
      const list = (l: Raw, ind: string) => `${ind}${l.name} #${l.id}${l.task_count ? ` (${l.task_count})` : ""}`;
      const lines: string[] = [];
      for (const s of spaces) {
        lines.push(`${s.name} #${s.id}`);
        if (depth < 1) continue;
        for (const f of s.folders) {
          lines.push(`  ${f.name}/ #${f.id}${f.sprint_folder ? " (sprints)" : ""}`);
          if (depth >= 2) for (const l of f.lists ?? []) lines.push(list(l, "    "));
        }
        if (depth >= 2) for (const l of s.lists) lines.push(list(l, "  "));
      }
      return lines.join("\n") || "no spaces";
    },
  );

  reg(
    "get_workspace_members",
    { description: "All workspace members (id, username, email, role).", input: { workspace_id: ws } },
    async (a) => table((await c.members(a.workspace_id)).map(memberRow), ["id", "username", "email", "role"]),
  );

  reg(
    "find_member_by_name",
    {
      description: "Find members by name or email (diacritics-insensitive).",
      input: { name_or_email: z.string(), workspace_id: ws },
    },
    async (a) => {
      const all = await c.members(a.workspace_id);
      let hits = findMembers(all, a.name_or_email);
      if (!hits.length) {
        const q = fold(a.name_or_email);
        hits = all.filter((m) => fold(`${m.username ?? ""} ${m.email ?? ""}`).includes(q));
      }
      return hits.length ? table(hits.map(memberRow), ["id", "username", "email", "role"]) : "no match";
    },
  );

  reg(
    "resolve_assignees",
    {
      description: "Map names, emails or \"me\" to numeric user ids. Task tools already accept names directly.",
      input: { assignees: z.array(z.string()), workspace_id: ws },
    },
    async (a) => {
      const out: string[] = [];
      for (const q of a.assignees as string[]) {
        try {
          out.push(`${q}=${await c.resolveUser(q, a.workspace_id)}`);
        } catch (e) {
          out.push(`${q}: ${e instanceof Error ? e.message : e}`);
        }
      }
      return out.join("\n");
    },
  );

  // ─────────────────────────── folders / lists ───────────────────────────

  reg(
    "get_folder",
    {
      description: "Folder details + its lists. By folder_id, or folder_name (optionally scoped by space).",
      input: {
        folder_id: z.string().optional(),
        folder_name: z.string().optional(),
        space_id: z.string().optional(),
        space_name: z.string().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const f = await c.v2<Raw>(`/folder/${await folderById(c, a)}`);
      const lists = (f.lists ?? []).map((l: Raw) => ({ id: l.id, name: l.name, tasks: l.task_count, status: l.status?.status }));
      return `${json({
        id: f.id,
        name: f.name,
        space: f.space && { id: f.space.id, name: f.space.name },
        override_statuses: f.override_statuses,
        sprint: f.sprint_folder,
        statuses: f.override_statuses ? (f.statuses ?? []).map((s: Raw) => s.status) : undefined,
      })}\n${lists.length ? table(lists, ["id", "name", "tasks", "status"]) : "no lists"}`;
    },
  );

  reg(
    "create_folder",
    {
      description: "Create a folder in a space.",
      write: true,
      input: { name: z.string(), space_id: z.string().optional(), space_name: z.string().optional(), workspace_id: ws },
    },
    async (a) => {
      const spaceId = a.space_id ?? (a.space_name ? await c.spaceIdByName(a.space_name, a.workspace_id) : undefined);
      if (!spaceId) throw new Error("space_id or space_name required");
      const f = await c.send2<Raw>("POST", `/space/${spaceId}/folder`, { name: a.name });
      c.invalidateTree();
      return `created folder ${f.id} "${f.name}"`;
    },
  );

  reg(
    "update_folder",
    {
      description: "Rename a folder or toggle folder-level statuses.",
      write: true,
      input: { folder_id: z.string(), name: z.string().optional(), override_statuses: z.boolean().optional() },
    },
    async (a) => {
      await c.send2("PUT", `/folder/${a.folder_id}`, { name: a.name, override_statuses: a.override_statuses });
      c.invalidateTree();
      return `updated folder ${a.folder_id}`;
    },
  );

  reg(
    "get_list",
    {
      description: "List details (statuses, description, location). By list_id or list_name.",
      input: { list_id: z.string().optional(), list_name: z.string().optional(), full, workspace_id: ws },
    },
    async (a) => {
      const id = a.list_id ?? (a.list_name ? await c.listIdByName(a.list_name, a.workspace_id) : undefined);
      if (!id) throw new Error("list_id or list_name required");
      const l = await c.v2<Raw>(`/list/${id}`, { include_markdown_description: true });
      return {
        id: l.id,
        name: l.name,
        content: a.full ? l.markdown_content || l.content : clip(l.markdown_content || l.content, 2000),
        folder: l.folder && !l.folder.hidden ? { id: l.folder.id, name: l.folder.name } : undefined,
        space: l.space && { id: l.space.id, name: l.space.name },
        statuses: (l.statuses ?? []).map((s: Raw) => s.status),
        tasks: l.task_count,
        due: fmtDate(l.due_date),
        priority: l.priority?.priority,
        assignee: userName(l.assignee),
        status: l.status?.status,
      };
    },
  );

  reg(
    "create_list",
    {
      description: "Create a list in a folder (folder_id) or directly in a space (space_id/space_name).",
      write: true,
      input: {
        name: z.string(),
        folder_id: z.string().optional(),
        space_id: z.string().optional(),
        space_name: z.string().optional(),
        content: z.string().optional().describe("Markdown description"),
        due_date: date.optional(),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        assignee: z.string().optional(),
        status: z.string().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      let path: string;
      if (a.folder_id) path = `/folder/${a.folder_id}/list`;
      else {
        const spaceId = a.space_id ?? (a.space_name ? await c.spaceIdByName(a.space_name, a.workspace_id) : undefined);
        if (!spaceId) throw new Error("folder_id, space_id or space_name required");
        path = `/space/${spaceId}/list`;
      }
      const due = parseDate(a.due_date);
      const l = await c.send2<Raw>("POST", path, {
        name: a.name,
        markdown_content: a.content,
        due_date: due?.ms,
        due_date_time: due?.time,
        priority: a.priority ? PRIORITY[a.priority] : undefined,
        assignee: a.assignee ? await c.resolveUser(a.assignee, a.workspace_id) : undefined,
        status: a.status,
      });
      c.invalidateTree();
      return `created list ${l.id} "${l.name}"`;
    },
  );

  reg(
    "update_list",
    {
      description: "Update a list's name, description or status.",
      write: true,
      input: { list_id: z.string(), name: z.string().optional(), content: z.string().optional(), status: z.string().optional() },
    },
    async (a) => {
      await c.send2("PUT", `/list/${a.list_id}`, { name: a.name, markdown_content: a.content, status: a.status });
      c.invalidateTree();
      return `updated list ${a.list_id}`;
    },
  );

  reg(
    "get_custom_fields",
    {
      description:
        "Custom field definitions (id, type, options) at list/folder/space/workspace level. Several scopes per call.",
      input: {
        list_id: z.string().optional(),
        folder_id: z.string().optional(),
        space_id: z.string().optional(),
        include_workspace: z.boolean().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const scopes: [string, string][] = [];
      if (a.list_id) scopes.push(["list", `/list/${a.list_id}/field`]);
      if (a.folder_id) scopes.push(["folder", `/folder/${a.folder_id}/field`]);
      if (a.space_id) scopes.push(["space", `/space/${a.space_id}/field`]);
      if (a.include_workspace || !scopes.length) scopes.push(["workspace", `/team/${await c.ws(a.workspace_id)}/field`]);
      const parts = await Promise.all(
        scopes.map(async ([label, path]) => {
          const { fields = [] } = await c.v2<Raw>(path);
          const rows = fields.map((f: Raw) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            required: f.required ? "yes" : undefined,
            options: (f.type_config?.options ?? []).map((o: Raw) => `${o.name ?? o.label}=${o.id}`),
          }));
          return `[${label}] ${rows.length ? `\n${table(rows, ["id", "name", "type", "required", "options"])}` : "none"}`;
        }),
      );
      return parts.join("\n");
    },
  );

  // ─────────────────────────── search ───────────────────────────

  reg(
    "search",
    {
      description:
        "Keyword search over task names (+descriptions with in_description) and doc titles; diacritics-insensitive, all words must match. Scans recently-updated tasks 100/page up to max_pages; resume with page. Task ids / custom ids are looked up directly. For field filters use filter_tasks.",
      input: {
        keywords: z.string(),
        asset_types: z.array(z.enum(["task", "doc"])).optional().describe("Default both"),
        in_description: z.boolean().optional(),
        include_closed: z.boolean().optional(),
        space_ids: z.array(z.string()).optional(),
        list_ids: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
        updated_from: date.optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
        max_pages: z.number().int().min(1).max(20).optional().describe("Default 5"),
        page: z.number().int().min(0).optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const types = new Set<string>(a.asset_types ?? ["task", "doc"]);
      const words = fold(a.keywords).split(/\s+/).filter(Boolean);
      const hit = (s: string) => {
        const f = fold(s);
        return words.every((w) => f.includes(w));
      };
      const limit = a.limit ?? 20;
      const out: string[] = [];

      if (types.has("task")) {
        const rows: Raw[] = [];
        const kw = a.keywords.trim();
        if (isCustomTaskId(kw) || /^[a-z0-9]{7,12}$/.test(kw)) {
          try {
            const t = await c.v2<Raw>(`/task/${kw}`, await c.taskQuery(kw, wsId));
            return `tasks: exact id match\n${table([briefRow(t)], ["id", "custom_id", "name", "status", "assignees", "list", "updated"])}`;
          } catch {}
        }
        const start = a.page ?? 0;
        const maxPages = a.max_pages ?? 5;
        const assignees = a.assignees ? await c.resolveUsers(a.assignees, wsId) : undefined;
        let page = start;
        let more = false;
        let scanned = 0;
        for (; page < start + maxPages && rows.length < limit; page++) {
          const data = await c.v2<Raw>(`/team/${wsId}/task`, {
            page,
            order_by: "updated",
            subtasks: true,
            include_closed: a.include_closed,
            "space_ids[]": a.space_ids,
            "list_ids[]": a.list_ids,
            "assignees[]": assignees,
            date_updated_gt: ms(a.updated_from),
          });
          const list: Raw[] = data.tasks ?? [];
          scanned += list.length;
          for (const t of list) {
            if (rows.length >= limit) break;
            if (rows.some((r) => r.id === t.id)) continue;
            if (hit(t.name ?? "") || (a.in_description && hit(t.text_content ?? ""))) rows.push(briefRow(t));
          }
          more = data.last_page === false || (data.last_page === undefined && list.length === 100);
          if (!more) break;
        }
        const tail = more ? `; more → page=${page}` : "";
        out.push(
          `tasks: ${rows.length} match (scanned ${scanned}${tail})` +
            (rows.length ? `\n${table(rows, ["id", "custom_id", "name", "status", "assignees", "list", "updated"])}` : ""),
        );
      }

      if (types.has("doc")) {
        const docs: Raw[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10 && docs.length < limit; i++) {
          const r = await c.v3<Raw>(`/workspaces/${wsId}/docs`, { limit: 100, cursor });
          for (const d of r.docs ?? []) if (hit(d.name ?? "") && docs.length < limit) docs.push(d);
          cursor = r.next_cursor;
          if (!cursor) break;
        }
        out.push(
          `docs: ${docs.length} match` +
            (docs.length
              ? `\n${table(
                  docs.map((d) => ({ id: d.id, name: d.name, updated: fmtDate(d.date_updated) })),
                  ["id", "name", "updated"],
                )}`
              : ""),
        );
      }
      return out.join("\n");
    },
  );

  // ─────────────────────────── escape hatch ───────────────────────────

  reg(
    "api_request",
    {
      description:
        "Raw ClickUp REST call for anything the other tools don't cover (developer.clickup.com). path like /v2/task/{id} or /v3/workspaces/{ws}/…. Output is pruned and capped at 20k chars; use keep to project fields. Non-GET is refused in read-only mode.",
      input: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        path: z.string(),
        query: z.record(z.any()).optional(),
        body: z.record(z.any()).optional(),
        keep: z.array(z.string()).optional().describe("Only keep these keys (any depth)"),
        full,
      },
    },
    async (a) => {
      const method = a.method ?? "GET";
      if (method !== "GET" && READ_ONLY) {
        throw new Error("read-only mode: only GET is allowed");
      }
      const m = /^\/?(v2|v3)(\/.*)$/.exec(a.path);
      if (!m) throw new Error("path must start with /v2/ or /v3/");
      const base = m[1] === "v2" ? "https://api.clickup.com/api/v2" : "https://api.clickup.com/api/v3";
      const res = await c.request(method, base + m[2], { query: a.query, body: a.body });
      const data = a.keep?.length ? keepKeys(res, new Set(a.keep)) : res;
      const text = json(data);
      return a.full ? text : (clip(text, 20000) ?? "{}");
    },
  );
};
