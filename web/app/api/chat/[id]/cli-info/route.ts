import { NextResponse } from "next/server";
import {
  listAgents,
  listHooks,
  listMcpServers,
  listSkills,
  loadSettings,
  readPermissions,
} from "@/lib/server/cli-introspect";
import { snapshotSession } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// Returns a slice of "what does Claude Code see for this session" so
// the chat panel's slash commands can render the same answers the CLI
// would. ?topic=mcp|agents|skills|hooks|config|permissions selects
// which slice to compute. Doing this server-side means the browser
// never needs filesystem access — we look up the session's configDir +
// cwd, read those files, and shape the response for direct rendering.
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic");
  const configDir = snap.summary.config_dir;
  const cwd = snap.summary.cwd;

  try {
    switch (topic) {
      case "mcp": {
        const configured = await listMcpServers(configDir, cwd);
        // Surface the orchestrator's in-process MCP servers alongside
        // the configured ones. Without these the /mcp panel reads as
        // "no MCP servers" for a fresh account — confusing because the
        // session very much has plan/notes/leader tools available. The
        // builtins are session-shape dependent: phase sessions get
        // notes, owner sessions get the leader toolkit, both get plan.
        const builtins: Array<{
          name: string;
          scope: "builtin";
          type: string;
          target?: string;
        }> = [
          {
            name: "plan",
            scope: "builtin",
            type: "sdk",
            target: "claude-monitor · plan submit / read",
          },
        ];
        if (snap.summary.plan_id && snap.summary.phase_slug) {
          builtins.push({
            name: "notes",
            scope: "builtin",
            type: "sdk",
            target: "claude-monitor · sibling-phase notes",
          });
        }
        if (!snap.summary.phase_slug) {
          builtins.push({
            name: "leader",
            scope: "builtin",
            type: "sdk",
            target: "claude-monitor · cross-phase planner toolkit",
          });
        }
        return NextResponse.json({ servers: [...builtins, ...configured] });
      }
      case "agents": {
        const agents = await listAgents(configDir, cwd);
        return NextResponse.json({ agents });
      }
      case "skills": {
        const skills = await listSkills(configDir, cwd);
        return NextResponse.json({ skills });
      }
      case "hooks": {
        const hooks = await listHooks(configDir);
        return NextResponse.json({ hooks });
      }
      case "permissions": {
        const permissions = await readPermissions(configDir);
        return NextResponse.json({ permissions });
      }
      case "config": {
        // Surface paths + a high-level summary; we don't echo the full
        // settings file because it can contain tokens / non-Claude
        // bits the user wouldn't expect to leak into the chat panel.
        const { global, local, merged } = await loadSettings(configDir);
        return NextResponse.json({
          paths: {
            user_settings: `${configDir}/settings.json`,
            user_local_settings: `${configDir}/settings.local.json`,
            project_settings: `${cwd}/.claude/settings.json`,
          },
          loaded: {
            global: !!global,
            local: !!local,
          },
          summary: {
            mcp_server_count: Object.keys(merged.mcpServers ?? {}).length,
            hook_event_count: Object.keys(merged.hooks ?? {}).length,
            permission_default_mode: merged.permissions?.defaultMode,
          },
        });
      }
      default:
        return NextResponse.json(
          {
            error:
              "topic must be one of: mcp, agents, skills, hooks, config, permissions",
          },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
