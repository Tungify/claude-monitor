import { z } from "zod";
import type { ClickUpClient } from "../clickup.js";
import { clip, fmtDate, userName, type Raw } from "../format.js";
import { hasFormatting, markdownToParts, partsToMarkdown } from "../markdown.js";
import { full, taskId, ws, type Module } from "../registry.js";

const TEXT_LIMIT = 2000;
const PAGE_LIMIT = 12000;

// block renders one comment/message as a header line + body, which is
// far cheaper than a JSON object per entry.
function block(id: unknown, who: unknown, when: unknown, flags: (string | false | undefined)[], text: unknown, fullText?: boolean) {
  const meta = [who, fmtDate(when), ...flags].filter(Boolean).join(" · ");
  const trimmed = typeof text === "string" ? text.trim() : undefined;
  const body = fullText ? trimmed : clip(trimmed, TEXT_LIMIT);
  return `#${id} ${meta}${body ? `\n${body}` : ""}`;
}

const replies = (n: unknown) => (Number(n) > 0 ? `${n} repl${Number(n) === 1 ? "y" : "ies"}` : undefined);

// Markdown (and [@Name](#user_mention#id) mentions) go out as rich
// parts; plain text stays plain comment_text.
function commentBody(text: string | undefined, extra: Raw): Raw {
  if (text === undefined) return extra;
  const parts = markdownToParts(text);
  return hasFormatting(parts) ? { comment: parts, ...extra } : { comment_text: text, ...extra };
}

function renderComments(list: Raw[], fullText?: boolean): string {
  return list
    .map((cm) =>
      block(
        cm.id,
        userName(cm.user),
        cm.date,
        [replies(cm.reply_count), cm.resolved && "resolved", cm.assignee && `→${userName(cm.assignee)}`],
        cm.comment?.length ? partsToMarkdown(cm.comment) : cm.comment_text,
        fullText,
      ),
    )
    .join("\n\n");
}

async function renderMessages(c: ClickUpClient, wsId: string, r: Raw, fullText?: boolean): Promise<string> {
  const msgs: Raw[] = r.data ?? [];
  const lines = await Promise.all(
    msgs.map(async (m) =>
      block(
        m.id,
        await c.userLabel(m.user_id, wsId),
        m.date,
        [
          m.type === "post" && `post${m.post_data?.title ? ` "${m.post_data.title}"` : ""}`,
          replies(m.replies_count),
          m.resolved && "resolved",
          m.assignee && `→${await c.userLabel(m.assignee, wsId)}`,
        ],
        m.content,
        fullText,
      ),
    ),
  );
  const out = lines.join("\n\n") || "no messages";
  return r.next_cursor ? `${out}\n\nmore → cursor=${r.next_cursor}` : out;
}

const DOC_PARENT: Record<string, number> = { space: 4, folder: 5, list: 6, everything: 7, workspace: 12 };

function pageTree(pages: Raw[], ind = ""): string[] {
  return pages.flatMap((p) => [`${ind}- ${p.name || "(untitled)"} #${p.id}`, ...pageTree(p.pages ?? [], `${ind}  `)]);
}

export const collab: Module = (reg, c) => {
  // ─────────────────────────── comments ───────────────────────────

  reg(
    "get_task_comments",
    {
      description: "Task comments, newest first, 25/page. Use get_threaded_comments for replies.",
      input: { task_id: taskId, start: z.number().optional(), start_id: z.string().optional(), full, workspace_id: ws },
    },
    async (a) => {
      const q = { ...(await c.taskQuery(a.task_id, a.workspace_id)), start: a.start, start_id: a.start_id };
      const { comments = [] } = await c.v2<Raw>(`/task/${a.task_id}/comment`, q);
      if (!comments.length) return "no comments";
      const last = comments[comments.length - 1];
      const tail = comments.length >= 25 ? `\n\nolder → start=${last.date} start_id=${last.id}` : "";
      return renderComments(comments, a.full) + tail;
    },
  );

  reg(
    "get_threaded_comments",
    { description: "Replies to a comment.", input: { comment_id: z.string(), full } },
    async (a) => {
      const { comments = [] } = await c.v2<Raw>(`/comment/${a.comment_id}/reply`);
      return comments.length ? renderComments(comments, a.full) : "no replies";
    },
  );

  reg(
    "create_comment",
    {
      description:
        "Comment on a task/list/view, or reply to a comment with reply_to_id. Mention users with [@Name](#user_mention#<user_id>).",
      write: true,
      input: {
        comment_text: z.string(),
        entity_id: z.string().optional().describe("Task/list/view id (not needed with reply_to_id)"),
        entity_type: z.enum(["task", "list", "view"]).optional().describe("Default task"),
        reply_to_id: z.string().optional(),
        assignee: z.string().optional().describe("Id, email, name or \"me\""),
        notify_all: z.boolean().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const extra = {
        notify_all: a.notify_all ?? false,
        assignee: a.assignee ? await c.resolveUser(a.assignee, a.workspace_id) : undefined,
      };
      const body = commentBody(a.comment_text, extra);
      let r: Raw;
      if (a.reply_to_id) r = await c.send2("POST", `/comment/${a.reply_to_id}/reply`, body);
      else {
        if (!a.entity_id) throw new Error("entity_id or reply_to_id required");
        const type = a.entity_type ?? "task";
        const q = type === "task" ? await c.taskQuery(a.entity_id, a.workspace_id) : undefined;
        r = await c.send2("POST", `/${type}/${a.entity_id}/comment`, body, q);
      }
      return `commented #${r.id ?? "ok"}`;
    },
  );

  reg(
    "update_comment",
    {
      description: "Edit a comment's text, resolve/unresolve it, or reassign it.",
      write: true,
      input: {
        comment_id: z.string(),
        comment_text: z.string().optional(),
        resolved: z.boolean().optional(),
        assignee: z.string().optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const extra = {
        resolved: a.resolved,
        assignee: a.assignee ? await c.resolveUser(a.assignee, a.workspace_id) : undefined,
      };
      await c.send2("PUT", `/comment/${a.comment_id}`, commentBody(a.comment_text, extra));
      return `updated comment #${a.comment_id}`;
    },
  );

  reg(
    "delete_comment",
    { description: "Delete a comment (irreversible).", write: true, destructive: true, input: { comment_id: z.string() } },
    async (a) => {
      await c.send2("DELETE", `/comment/${a.comment_id}`);
      return `deleted comment #${a.comment_id}`;
    },
  );

  // ─────────────────────────── chat ───────────────────────────

  reg(
    "get_chat_channels",
    {
      description: "Chat channels in the workspace.",
      input: { limit: z.number().int().min(1).max(100).optional().describe("Default 50"), cursor: z.string().optional(), workspace_id: ws },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.v3<Raw>(`/workspaces/${wsId}/chat/channels`, { limit: a.limit ?? 50, cursor: a.cursor, description_format: "text/plain" });
      const rows = (r.data ?? []).map((ch: Raw) =>
        [
          ch.id,
          ch.name || ch.type,
          ch.name && ch.type !== "CHANNEL" && ch.type,
          ch.visibility === "PRIVATE" && "private",
          ch.latest_comment_at && `last ${fmtDate(ch.latest_comment_at)}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      const out = rows.join("\n") || "no channels";
      return r.next_cursor ? `${out}\nmore → cursor=${r.next_cursor}` : out;
    },
  );

  const fmtArg = z.enum(["text/plain", "text/md"]).optional();

  reg(
    "get_chat_channel_messages",
    {
      description:
        "Messages in a channel, newest first. Channel URLs: /<ws>/chat/r/<channel_id> or /v/cn/<channel_id>. Threads → get_chat_message_replies.",
      input: {
        channel_id: z.string(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
        cursor: z.string().optional(),
        content_format: fmtArg.describe("Default text/plain"),
        full,
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.v3<Raw>(`/workspaces/${wsId}/chat/channels/${a.channel_id}/messages`, {
        limit: a.limit ?? 30,
        cursor: a.cursor,
        content_format: a.content_format ?? "text/plain",
      });
      return renderMessages(c, wsId, r, a.full);
    },
  );

  reg(
    "get_chat_message_replies",
    {
      description: "Thread replies of a chat message (the id at the end of a /t/<id> chat URL).",
      input: {
        message_id: z.string(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50"),
        cursor: z.string().optional(),
        content_format: fmtArg,
        full,
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.v3<Raw>(`/workspaces/${wsId}/chat/messages/${a.message_id}/replies`, {
        limit: a.limit ?? 50,
        cursor: a.cursor,
        content_format: a.content_format ?? "text/plain",
      });
      return renderMessages(c, wsId, r, a.full);
    },
  );

  reg(
    "send_chat_message",
    {
      description: "Send a chat message (markdown), or a thread reply with parent_message_id. type=post needs post_title + post_type.",
      write: true,
      input: {
        content: z.string(),
        channel_id: z.string().optional(),
        parent_message_id: z.string().optional(),
        type: z.enum(["message", "post"]).optional(),
        post_title: z.string().optional(),
        post_type: z.enum(["Update", "Announcement", "Idea", "Discussion"]).optional(),
        assignee: z.string().optional(),
        followers: z.array(z.string()).optional(),
        content_format: z.enum(["text/md", "text/plain"]).optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const body: Raw = {
        type: a.type ?? "message",
        content: a.content,
        content_format: a.content_format ?? "text/md",
        assignee: a.assignee ? String(await c.resolveUser(a.assignee, wsId)) : undefined,
        followers: a.followers ? (await c.resolveUsers(a.followers, wsId)).map(String) : undefined,
      };
      if (body.type === "post") {
        if (!a.post_title || !a.post_type) throw new Error("post needs post_title and post_type");
        const { comment_subtypes = [] } = await c.v3<Raw>(`/workspaces/${wsId}/comments/types/post/subtypes`);
        const sub = comment_subtypes.find((s: Raw) => s.name?.toLowerCase() === a.post_type.toLowerCase());
        if (!sub) throw new Error(`post_type ${a.post_type} not found`);
        body.post_data = { title: a.post_title, subtype: { id: sub.id } };
      }
      let path: string;
      if (a.parent_message_id) path = `/workspaces/${wsId}/chat/messages/${a.parent_message_id}/replies`;
      else if (a.channel_id) path = `/workspaces/${wsId}/chat/channels/${a.channel_id}/messages`;
      else throw new Error("channel_id or parent_message_id required");
      const r = await c.send3<Raw>("POST", path, body);
      return `sent #${r.id ?? "ok"}`;
    },
  );

  // ─────────────────────────── docs ───────────────────────────

  reg(
    "create_document",
    {
      description: "Create a Doc under a space/folder/list/workspace.",
      write: true,
      input: {
        name: z.string(),
        parent_type: z.enum(["space", "folder", "list", "workspace", "everything"]),
        parent_id: z.string().optional().describe("Omit for workspace"),
        visibility: z.enum(["PUBLIC", "PRIVATE", "PERSONAL", "HIDDEN"]).optional(),
        create_page: z.boolean().optional().describe("Default true"),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const d = await c.send3<Raw>("POST", `/workspaces/${wsId}/docs`, {
        name: a.name,
        parent: { id: a.parent_id ?? wsId, type: DOC_PARENT[a.parent_type] },
        visibility: a.visibility,
        create_page: a.create_page ?? true,
      });
      return `created doc ${d.id} "${d.name ?? a.name}"`;
    },
  );

  reg(
    "list_document_pages",
    {
      description: "Page tree of a Doc (names + ids, no content). Doc URLs: /<ws>/docs/<doc_id>/<page_id> or /v/dc/<doc_id>/<page_id>.",
      input: { document_id: z.string(), max_page_depth: z.number().int().optional(), workspace_id: ws },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const r = await c.v3<Raw | Raw[]>(`/workspaces/${wsId}/docs/${a.document_id}/page_listing`, {
        max_page_depth: a.max_page_depth ?? -1,
      });
      const pages = Array.isArray(r) ? r : ((r as Raw).pages ?? []);
      return pageTree(pages).join("\n") || "no pages";
    },
  );

  reg(
    "get_document_pages",
    {
      description: `Content of Doc pages by id (markdown by default, ${PAGE_LIMIT} chars/page unless full).`,
      input: {
        document_id: z.string(),
        page_ids: z.array(z.string()).min(1),
        content_format: z.enum(["text/md", "text/plain"]).optional(),
        full,
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const pages = await Promise.all(
        (a.page_ids as string[]).map((id) =>
          c.v3<Raw>(`/workspaces/${wsId}/docs/${a.document_id}/pages/${id}`, { content_format: a.content_format ?? "text/md" }),
        ),
      );
      return pages
        .map((p) => {
          const body = a.full ? p.content : clip(p.content, PAGE_LIMIT);
          return `## ${p.name || "(untitled)"} #${p.id}${p.date_updated ? ` · updated ${fmtDate(p.date_updated)}` : ""}\n${body ?? ""}`;
        })
        .join("\n\n");
    },
  );

  reg(
    "create_document_page",
    {
      description: "Add a page (or sub-page) to a Doc.",
      write: true,
      input: {
        document_id: z.string(),
        name: z.string(),
        content: z.string().optional(),
        parent_page_id: z.string().optional(),
        sub_title: z.string().optional(),
        content_format: z.enum(["text/md", "text/plain"]).optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      const p = await c.send3<Raw>("POST", `/workspaces/${wsId}/docs/${a.document_id}/pages`, {
        name: a.name,
        content: a.content ?? "",
        parent_page_id: a.parent_page_id,
        sub_title: a.sub_title,
        content_format: a.content_format ?? "text/md",
      });
      return `created page ${p.id} "${p.name ?? a.name}"`;
    },
  );

  reg(
    "update_document_page",
    {
      description:
        "Edit a Doc page. content_edit_mode: replace (default, overwrites the page), append, prepend — append/prepend don't need a read first.",
      write: true,
      destructive: true,
      input: {
        document_id: z.string(),
        page_id: z.string(),
        content: z.string().optional(),
        content_edit_mode: z.enum(["replace", "append", "prepend"]).optional(),
        name: z.string().optional(),
        sub_title: z.string().optional(),
        content_format: z.enum(["text/md", "text/plain"]).optional(),
        workspace_id: ws,
      },
    },
    async (a) => {
      const wsId = await c.ws(a.workspace_id);
      await c.send3("PUT", `/workspaces/${wsId}/docs/${a.document_id}/pages/${a.page_id}`, {
        name: a.name,
        sub_title: a.sub_title,
        content: a.content,
        content_edit_mode: a.content !== undefined ? (a.content_edit_mode ?? "replace") : undefined,
        content_format: a.content !== undefined ? (a.content_format ?? "text/md") : undefined,
      });
      return `updated page ${a.page_id}`;
    },
  );
};
