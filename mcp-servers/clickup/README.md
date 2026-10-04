# clickup-mcp

Local MCP server for ClickUp. No license, no third-party server: a thin TypeScript wrapper over
the ClickUp REST API (v2 + v3), built to cover the official ClickUp MCP's tool set without its
quota, and to spend as few tokens as possible.

## Token budget

- **Responses are compact.** Lists render as `a | b | c` tables that drop empty columns.
  Comments and chat come back as `#id user · date` blocks. The hierarchy and doc pages are
  indented trees. Everything else is pruned JSON (no nulls, empty values or `false`, minified).
  Timestamps are local `YYYY-MM-DD HH:MM`.
- **`get_task` is lean.** Large sections (custom fields, checklists, attachments, dependencies,
  links, watchers) show up as counts under `more`; `include: [...]` expands them. Descriptions
  are cut at 4k characters unless you pass `full: true`.
- **Writes return a one-line ack** (`updated abc123: status, assignees`), not the full object.
- **No URLs per row.** A task's link is `https://app.clickup.com/t/<id>`, and the server
  instructions say so once.
- **Schemas are short.** 47 tools come to about 7.7k tokens; read-only mode (23 tools) is about 3.7k.
- **Size comparison:** 100 tasks from `filter_tasks` are about 12 KB, against 351 KB for the raw
  API page.

## Tools

| Area | Tools | Official equivalent |
|---|---|---|
| Tasks | `get_task`, `filter_tasks`, `search`, `create_task`, `update_task`, `delete_task`, `move_task`, `merge_tasks` | same names |
| Task relations | `task_tag`, `task_dependency`, `task_link`, `task_in_list` (each takes `action: add\|remove`) | add/remove tag, add/remove dependency, add/remove link, add/remove task to/from list |
| Comments | `get_task_comments`, `get_threaded_comments`, `create_comment`, `update_comment`, `delete_comment` | same, except the deprecated `create_task_comment`, which is dropped |
| Chat | `get_chat_channels`, `get_chat_channel_messages`, `get_chat_message_replies`, `send_chat_message` | same |
| Docs | `create_document`, `list_document_pages`, `get_document_pages`, `create_document_page`, `update_document_page` | same |
| Hierarchy | `list_workspaces`, `get_workspace_hierarchy`, `get_folder`, `create_folder`, `update_folder`, `get_list`, `create_list`, `update_list` | `create_list` also covers `create_list_in_folder` (pass `folder_id`) |
| People | `get_workspace_members`, `find_member_by_name`, `resolve_assignees` | same |
| Custom fields | `get_custom_fields` | same |
| Time | `start_time_tracking`, `stop_time_tracking`, `add_time_entry`, `get_current_time_entry`, `get_time_entries`, `get_time_in_status` | `get_time_in_status` covers both the single-task and bulk versions |
| Files | `attach_task_file`, `download_attachment` | attach + request upload; download task / doc-page attachment |
| Escape hatch | `api_request` (raw REST, `keep` projects fields) | Unified API operators / schema |

Not available:

- **Reminders.** ClickUp's public API has no reminder endpoints (`/v3/.../reminders` returns 404).
- **Listing doc-page attachments.** There's no public endpoint. Images in a page's markdown carry
  their URLs; pass one to `download_attachment`.

### Differences from the official server

- Assignees, custom-field people, and comment assignees accept ids, emails, names, or `"me"`.
  Names are matched case-insensitively and without diacritics.
- Custom field values accept option **names** for dropdowns and labels, and field **names** as
  well as ids.
- `space_name`, `folder_name`, and `list_name` resolve against a hierarchy cache that lives for 5 minutes.
- `search` has no keyword endpoint to call, because ClickUp's public API doesn't have one. It
  scans recently updated tasks, 100 per page up to `max_pages`, and matches every word of the
  query against task names (and descriptions with `in_description`). It also filters doc titles.
  A task id or custom id in the query is looked up directly.
- Files use the local disk. `attach_task_file` takes a local `file_path`, and
  `download_attachment` saves to a file and returns the path instead of a short-lived URL.
- Comments are written in markdown, with `[@Name](#user_mention#<id>)` for mentions. They're sent
  as ClickUp rich text and read back as markdown.

## Env

| Var | |
|---|---|
| `CLICKUP_API_KEY` | required. Personal token (`pk_...`) from ClickUp → Settings → Apps |
| `CLICKUP_TEAM_ID` | default workspace. If unset, the only workspace the token can see is used |
| `CLICKUP_READ_ONLY=1` | hide write tools; `api_request` becomes GET-only. claude-monitor sets this unless the integration has `clickup_allow_write` |
| `CLICKUP_ENABLED_TOOLS` / `CLICKUP_DISABLED_TOOLS` | comma lists that trim the tool surface further |

## Setup

```bash
cd mcp-servers/clickup
npm install
npm run build   # → dist/index.js
```

Register it with Claude Code. For every project, add this to `~/.claude.json` under `mcpServers`:

```json
"clickup_local": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<you>/Workspace/Nexlify/claude-monitor/mcp-servers/clickup/dist/index.js"],
  "env": { "CLICKUP_API_KEY": "pk_xxxxxxxx", "CLICKUP_TEAM_ID": "1234567" }
}
```

For project scope only, put the same entry in `.mcp.json` with a relative path
(`./mcp-servers/clickup/dist/index.js`). Restart Claude Code afterwards.

## Verify

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | CLICKUP_API_KEY=pk_xxx node dist/index.js
```

This lists 47 tools, or 23 with `CLICKUP_READ_ONLY=1`.
