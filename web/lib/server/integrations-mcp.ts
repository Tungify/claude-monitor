import "server-only";

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Bridges the Go daemon's persisted MCP integrations registry into
// the orchestrator's Claude Agent SDK sessions. Each named
// integration (Slack today, more services later) becomes one entry
// in the spawned session's `mcpServers` map keyed by the user-supplied
// name — same name the daemon-side injection uses in each managed
// account's .claude.json.
//
// Mirrors postgres-mcp.ts (getDbMcpEntries) but for the
// `integrations` envelope. We re-read synchronously here because
// attachSDKQuery is sync and rippling async through every spawn
// caller would touch a lot of unrelated code.

type StdioStanza = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
};

type IntegrationDisk = {
  id?: string;
  name?: string;
  service?: "slack";
  // Slack
  slack_token?: string;
  slack_add_message_tool?: boolean;
};

type Envelope = {
  integrations?: {
    integrations?: IntegrationDisk[];
  };
};

function configPath(): string {
  return path.join(os.homedir(), ".claude-monitor", "mcp.json");
}

function readEnvelope(): Envelope | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Envelope;
  } catch {
    return null;
  }
}

function readIntegrations(): IntegrationDisk[] {
  const env = readEnvelope();
  return env?.integrations?.integrations ?? [];
}

// slackStanza must produce a byte-identical shape to the Go side's
// slackStanza in internal/mcp/integrations/integrations.go. Both
// surfaces (daemon-injected .claude.json and SDK-spawned mcpServers)
// need to address the same npx package with the same env vars.
function slackStanza(i: IntegrationDisk): StdioStanza | null {
  const tok = i.slack_token?.trim();
  if (!tok) return null;
  const env: Record<string, string> = {};
  if (tok.startsWith("xoxp-")) {
    env.SLACK_MCP_XOXP_TOKEN = tok;
  } else if (tok.startsWith("xoxb-")) {
    env.SLACK_MCP_XOXB_TOKEN = tok;
  } else {
    // Unknown prefix — Go validate would have rejected, but be
    // defensive: returning null means "skip this entry" rather than
    // spawning an MCP server with no auth that the model would then
    // see as a broken tool surface.
    return null;
  }
  if (i.slack_add_message_tool) {
    env.SLACK_MCP_ADD_MESSAGE_TOOL = "true";
  }
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
    env,
  };
}

function stanzaFor(i: IntegrationDisk): StdioStanza | null {
  switch (i.service) {
    case "slack":
      return slackStanza(i);
    default:
      return null;
  }
}

// getIntegrationsMcpEntries returns every configured integration's
// mcpServers stanza keyed by its user-supplied name. Tools surface
// to the model as `mcp__<integration_name>__<upstream_tool>` (e.g.
// `mcp__team_slack__conversations_history`).
//
// Returns {} when no integrations are configured. Safe to spread
// into a session's mcpServers map unconditionally — npx is always
// present since the orchestrator runs on Node.
export function getIntegrationsMcpEntries(): Record<string, StdioStanza> {
  const items = readIntegrations();
  if (items.length === 0) return {};
  const out: Record<string, StdioStanza> = {};
  for (const i of items) {
    if (!i.name) continue;
    const stanza = stanzaFor(i);
    if (stanza) out[i.name] = stanza;
  }
  return out;
}
