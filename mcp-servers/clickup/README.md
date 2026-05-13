# clickup-mcp

Local, read-only MCP server for ClickUp. No license, no third-party server — just a thin
TypeScript wrapper over the ClickUp REST API (v2 + v3 docs).

## Tools (14)

Hierarchy
- `list_workspaces` — `GET /v2/team`
- `list_spaces` — `GET /v2/team/{team_id}/space`
- `list_folders` — `GET /v2/space/{space_id}/folder` (sprint folders included; check `sprint_folder`)
- `list_folder_lists` — `GET /v2/folder/{folder_id}/list`
- `list_folderless_lists` — `GET /v2/space/{space_id}/list`
- `get_list` — `GET /v2/list/{list_id}`

Tasks
- `get_task` — `GET /v2/task/{task_id}` (supports custom ids)
- `list_tasks_in_list` — `GET /v2/list/{list_id}/task`
- `search_tasks` — `GET /v2/team/{team_id}/task` (filter by space/folder/list/status/assignee/dates)

Comments
- `get_task_comments` — `GET /v2/task/{task_id}/comment`

Docs (v3)
- `list_docs` — `GET /v3/workspaces/{workspace_id}/docs`
- `get_doc` — `GET /v3/workspaces/{workspace_id}/docs/{doc_id}`
- `list_doc_pages` — `GET /v3/workspaces/{workspace_id}/docs/{doc_id}/page_listing`
- `get_doc_page` — `GET /v3/workspaces/{workspace_id}/docs/{doc_id}/pages/{page_id}`

Sprints live as folders with `sprint_folder: true` — surface them via `list_folders`.

## Setup

```bash
cd mcp-servers/clickup
npm install
npm run build
```

Builds `dist/index.js` (entry point).

## Env

- `CLICKUP_API_KEY` (required) — personal API token from ClickUp → Settings → Apps (`pk_...`).
- `CLICKUP_TEAM_ID` (optional) — default workspace id; tools that take `team_id`/`workspace_id`
  fall back to this when omitted.

## Register with Claude Code

Project-scope (this repo only) — create `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "clickup": {
      "type": "stdio",
      "command": "node",
      "args": ["./mcp-servers/clickup/dist/index.js"],
      "env": {
        "CLICKUP_API_KEY": "pk_xxxxxxxx",
        "CLICKUP_TEAM_ID": "3807076"
      }
    }
  }
}
```

User-scope (every project) — edit `~/.claude.json` and add under `mcpServers`:

```json
"clickup_local": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<you>/Workspace/Nexlify/claude-monitor/mcp-servers/clickup/dist/index.js"],
  "env": {
    "CLICKUP_API_KEY": "pk_xxxxxxxx",
    "CLICKUP_TEAM_ID": "3807076"
  }
}
```

Use an absolute path for user-scope; relative paths only work in project-scope `.mcp.json`.
After editing, restart Claude Code to pick up the new server.

## Verify

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | CLICKUP_API_KEY=pk_xxx node dist/index.js
```

You should see one JSON-RPC response listing 14 tools.
