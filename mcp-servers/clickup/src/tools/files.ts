import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { fmtBytes, type Raw } from "../format.js";
import { taskId, ws, type Module } from "../registry.js";

const DEFAULT_DIR = join(tmpdir(), "clickup-attachments");

const isClickUpHost = (u: string) => /(^|\.)clickup(-attachments)?\.com$/.test(new URL(u).hostname);

function safeName(s: string): string {
  return s.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_").slice(0, 150) || "attachment";
}

// Because the server runs on the user's machine, uploads read local
// paths directly and downloads land on disk — no short-lived URLs or
// base64 round-trips through the model's context.
export const files: Module = (reg, c) => {
  reg(
    "attach_task_file",
    {
      description: "Upload a file to a task from a local path, a URL, or base64 (small files).",
      write: true,
      input: {
        task_id: taskId,
        file_path: z.string().optional(),
        file_url: z.string().optional(),
        auth_header: z.string().optional().describe("Authorization header for file_url"),
        file_data: z.string().optional().describe("Base64, needs file_name"),
        file_name: z.string().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      let bytes: Uint8Array;
      let name: string | undefined = a.file_name;
      if (a.file_path) {
        bytes = await readFile(a.file_path);
        name ??= basename(a.file_path);
      } else if (a.file_url) {
        const res = await fetch(a.file_url, { headers: a.auth_header ? { Authorization: a.auth_header } : {} });
        if (!res.ok) throw new Error(`download ${res.status} from ${a.file_url}`);
        bytes = new Uint8Array(await res.arrayBuffer());
        name ??= decodeURIComponent(basename(new URL(a.file_url).pathname)) || "file";
      } else if (a.file_data) {
        if (!name) throw new Error("file_name required with file_data");
        bytes = Buffer.from(a.file_data, "base64");
      } else throw new Error("file_path, file_url or file_data required");
      const form = new FormData();
      form.append("attachment", new Blob([Buffer.from(bytes)]), name);
      const r = await c.form2<Raw>(`/task/${a.task_id}/attachment`, form, await c.taskQuery(a.task_id, a.workspace_id));
      return `attached "${r.title ?? name}" (${fmtBytes(bytes.byteLength)}, id ${r.id ?? "?"})`;
    },
  );

  reg(
    "download_attachment",
    {
      description:
        "Download a task attachment (task_id + attachment_id from get_task include attachments) or any ClickUp file url (e.g. images in doc pages) to a local file; returns the path.",
      input: {
        task_id: z.string().optional(),
        attachment_id: z.string().optional(),
        url: z.string().optional(),
        save_to: z.string().optional().describe(`Dir or file path (default ${DEFAULT_DIR})`),
        workspace_id: ws,
      },
    },
    async (a) => {
      let url: string | undefined = a.url;
      let name: string | undefined;
      if (!url) {
        if (!a.task_id || !a.attachment_id) throw new Error("url, or task_id + attachment_id, required");
        const t = await c.v2<Raw>(`/task/${a.task_id}`, await c.taskQuery(a.task_id, a.workspace_id));
        const att = (t.attachments ?? []).find((x: Raw) => x.id === a.attachment_id);
        if (!att) throw new Error(`attachment ${a.attachment_id} not on task ${a.task_id}`);
        url = att.url_w_query || att.url;
        name = att.title;
      }
      let res = await fetch(url!);
      if ((res.status === 401 || res.status === 403) && isClickUpHost(url!)) {
        res = await fetch(url!, { headers: { Authorization: c.apiKeyHeader() } });
      }
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      name = safeName(name ?? decodeURIComponent(basename(new URL(url!).pathname)));
      let path: string;
      if (a.save_to && extname(a.save_to)) path = a.save_to;
      else {
        const dir = a.save_to ?? DEFAULT_DIR;
        await mkdir(dir, { recursive: true });
        path = join(dir, name);
      }
      await writeFile(path, bytes);
      return `saved ${path} (${fmtBytes(bytes.byteLength)}, ${res.headers.get("content-type") ?? "?"})`;
    },
  );
};
