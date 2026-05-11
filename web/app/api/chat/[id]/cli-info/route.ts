import { NextResponse } from "next/server";
import {
  buildStatusInfo,
  fetchClaudeAiMcpServers,
  listAgents,
  listCatalogPlugins,
  listHooks,
  listMarketplaces,
  listMcpServers,
  listPlugins,
  listSkills,
  loadSettings,
  readOrganizationUuid,
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
        // Fire file-walk + claude.ai connector fetch + org uuid read
        // in parallel — all are I/O bound and independent. The
        // connector fetch is wrapped to never throw (returns
        // {servers:[], needsAuth:bool}); the org-uuid read returns
        // undefined when no oauthAccount has been written yet.
        const [configured, claudeAi, organizationUuid] = await Promise.all([
          listMcpServers(configDir, cwd),
          fetchClaudeAiMcpServers(configDir),
          readOrganizationUuid(configDir),
        ]);
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
        return NextResponse.json({
          servers: [...builtins, ...configured, ...claudeAi.servers],
          // Surface the "user is signed in but OAuth scope missing"
          // signal so the chat panel can prompt re-auth instead of
          // silently showing zero claude.ai integrations.
          claudeAiNeedsAuth: claudeAi.needsAuth,
          // Used by the MCP dialog to build per-connector auth deep-
          // links. Undefined when no oauthAccount is recorded yet —
          // dialog falls back to the generic settings/connectors page.
          organizationUuid,
        });
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
      case "plugins": {
        // Three independent reads — installed-set, marketplace
        // catalog, and the marketplace registry. All best-effort; an
        // empty list from any of them still renders a useful panel.
        const [plugins, catalog, marketplaces] = await Promise.all([
          listPlugins(),
          listCatalogPlugins(),
          listMarketplaces(),
        ]);
        return NextResponse.json({ plugins, catalog, marketplaces });
      }
      case "status": {
        const info = await buildStatusInfo(configDir, cwd);
        // Builtin count is session-shape dependent — match the same
        // logic as the /mcp branch so /status agrees with /mcp. Plan
        // is always there; notes when scheduled inside a phase tree;
        // leader on the owner session.
        let builtin = 1;
        if (snap.summary.plan_id && snap.summary.phase_slug) builtin += 1;
        if (!snap.summary.phase_slug) builtin += 1;
        return NextResponse.json({
          ...info,
          mcp: { ...info.mcp, builtin },
        });
      }
      default:
        return NextResponse.json(
          {
            error:
              "topic must be one of: mcp, agents, skills, hooks, config, permissions, status, plugins",
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
