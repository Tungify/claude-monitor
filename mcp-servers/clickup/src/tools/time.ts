import { z } from "zod";
import { fmtDate, fmtDuration, fmtMinutes, ms, parseDate, parseDuration, table, userName, type Raw } from "../format.js";
import { date, taskId, ws, type Module } from "../registry.js";

const tagList = z.array(z.string()).optional();
const toTags = (t?: string[]) => t?.map((name) => ({ name }));

function entryRow(e: Raw): Raw {
  const running = Number(e.duration) < 0;
  return {
    id: e.id,
    task: e.task ? `${e.task.custom_id ?? e.task.id} ${e.task.name}` : undefined,
    user: userName(e.user),
    start: fmtDate(e.start),
    duration: running ? `running ${fmtDuration(Date.now() - Number(e.start))}` : fmtDuration(e.duration),
    description: e.description,
    billable: e.billable ? "yes" : undefined,
    tags: (e.tags ?? []).map((t: Raw) => t.name),
  };
}

const COLS = ["id", "task", "user", "start", "duration", "description", "billable", "tags"];

function statusLine(id: string, r: Raw): string {
  const cur = r.current_status;
  const now = cur
    ? `now ${cur.status} ${fmtMinutes(Number(cur.total_time?.by_minute ?? 0))}${cur.total_time?.since ? ` (since ${fmtDate(cur.total_time.since)})` : ""}`
    : "";
  const hist = (r.status_history ?? [])
    .map((s: Raw) => `${s.status} ${fmtMinutes(Number(s.total_time?.by_minute ?? 0))}`)
    .join(", ");
  return `${id}: ${[now, hist && `history: ${hist}`].filter(Boolean).join(" | ")}`;
}

export const time: Module = (reg, c) => {
  reg(
    "start_time_tracking",
    {
      description: "Start a timer on a task (one running timer per user).",
      write: true,
      input: { task_id: taskId, description: z.string().optional(), billable: z.boolean().optional(), tags: tagList, workspace_id: ws },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const tid = await c.resolveTaskId(a.task_id, wsId);
      const r = await c.send2<Raw>("POST", `/team/${wsId}/time_entries/start`, {
        tid,
        description: a.description,
        billable: a.billable,
        tags: toTags(a.tags),
      });
      return `timer started on ${a.task_id} (entry ${r.data?.id ?? "?"})`;
    },
  );

  reg(
    "stop_time_tracking",
    {
      description: "Stop the running timer; optionally set its description/tags.",
      write: true,
      input: { description: z.string().optional(), tags: tagList, workspace_id: ws },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.send2<Raw>("POST", `/team/${wsId}/time_entries/stop`);
      const e = r.data ?? {};
      if (e.id && (a.description !== undefined || a.tags?.length)) {
        await c.send2("PUT", `/team/${wsId}/time_entries/${e.id}`, {
          description: a.description,
          tags: toTags(a.tags),
          tag_action: a.tags?.length ? "add" : undefined,
        });
      }
      return `timer stopped: ${fmtDuration(e.duration) ?? "?"} on ${e.task?.name ?? "task"} (entry ${e.id ?? "?"})`;
    },
  );

  reg(
    "add_time_entry",
    {
      description: "Log time manually: start + (duration or end_time).",
      write: true,
      input: {
        task_id: taskId,
        start: z.string().describe("YYYY-MM-DD HH:MM"),
        duration: z.string().optional().describe("\"1h 30m\" or minutes"),
        end_time: z.string().optional().describe("YYYY-MM-DD HH:MM"),
        description: z.string().optional(),
        billable: z.boolean().optional(),
        tags: tagList,
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const start = parseDate(a.start)!.ms;
      const duration = a.duration
        ? parseDuration(a.duration)
        : a.end_time
          ? parseDate(a.end_time)!.ms - start
          : NaN;
      if (!(duration > 0)) throw new Error("duration or a later end_time is required");
      const r = await c.send2<Raw>("POST", `/team/${wsId}/time_entries`, {
        tid: await c.resolveTaskId(a.task_id, wsId),
        start,
        duration,
        description: a.description,
        billable: a.billable,
        tags: toTags(a.tags),
      });
      return `logged ${fmtDuration(duration)} on ${a.task_id} (entry ${r.data?.id ?? "?"})`;
    },
  );

  reg(
    "get_current_time_entry",
    { description: "The running timer, if any.", input: { workspace_id: ws } },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.v2<Raw>(`/team/${wsId}/time_entries/current`);
      return r.data ? table([entryRow(r.data)], COLS) : "no timer running";
    },
  );

  reg(
    "get_time_entries",
    {
      description:
        "Time entries (default: last 30 days, your own). assignee: user ids/names, or [\"any\"] for everyone.",
      input: {
        task_id: z.string().optional(),
        start_date: date.optional(),
        end_date: date.optional(),
        assignee: z.array(z.string()).optional(),
        is_billable: z.boolean().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      let assignee: string | undefined;
      if (a.assignee?.includes("any")) assignee = (await c.members(wsId)).map((m) => m.id).join(",");
      else if (a.assignee?.length) assignee = (await c.resolveUsers(a.assignee, wsId)).join(",");
      const r = await c.v2<Raw>(`/team/${wsId}/time_entries`, {
        start_date: ms(a.start_date),
        end_date: ms(a.end_date, true),
        assignee,
        task_id: a.task_id ? await c.resolveTaskId(a.task_id, wsId) : undefined,
        is_billable: a.is_billable,
      });
      const list: Raw[] = r.data ?? [];
      if (!list.length) return "no time entries";
      const total = list.reduce((s, e) => s + Math.max(0, Number(e.duration) || 0), 0);
      return `${list.length} entries, total ${fmtDuration(total)}\n${table(list.map(entryRow), COLS)}`;
    },
  );

  reg(
    "get_time_in_status",
    {
      description: "Time each task spent per status (1–100 tasks). Needs the Total Time in Status ClickApp.",
      input: { task_ids: z.array(z.string()).min(1).max(100), workspace_id: ws },
    },
    async (a) => {
      const ids: string[] = a.task_ids;
      if (ids.length === 1) {
        const r = await c.v2<Raw>(`/task/${ids[0]}/time_in_status`, await c.taskQuery(ids[0], a.workspace_id));
        return statusLine(ids[0], r);
      }
      const native = await Promise.all(ids.map((id) => c.resolveTaskId(id, a.workspace_id)));
      const r = await c.v2<Raw>("/task/bulk_time_in_status/task_ids", { task_ids: native });
      if (!Object.keys(r).length) return "no data (is the Total Time in Status ClickApp on / in your plan?)";
      return native.map((id, i) => (r[id] ? statusLine(ids[i], r[id]) : `${ids[i]}: no data`)).join("\n");
    },
  );
};
