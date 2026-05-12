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
  service?: "slack" | "clickup" | "github";
  // Disabled = parked. Stripped from the spawn map but kept on
  // disk so re-enable doesn't require re-entering secrets.
  disabled?: boolean;
  // Slack
  slack_token?: string;
  slack_add_message_tool?: boolean;
  // ClickUp
  clickup_api_key?: string;
  clickup_team_id?: string;
  // ClickUp — opt-in writes. Default (undefined/false) means
  // CLICKUP_MCP_PERSONA=auditor → read-only tool surface.
  clickup_allow_write?: boolean;
  // GitHub
  github_token?: string;
  // GitHub — opt-in writes. Default (undefined/false) means
  // GITHUB_READ_ONLY=1 → upstream filters out write tools.
  github_allow_write?: boolean;
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

// clickupStanza must produce a byte-identical shape to the Go side's
// clickupStanza in internal/mcp/integrations/integrations.go. Both
// surfaces (daemon-injected .claude.json and SDK-spawned mcpServers)
// need to address the same npx package with the same env vars.
function clickupStanza(i: IntegrationDisk): StdioStanza | null {
  const key = i.clickup_api_key?.trim();
  const team = i.clickup_team_id?.trim();
  if (!key || !team) return null;
  const env: Record<string, string> = {
    CLICKUP_API_KEY: key,
    CLICKUP_TEAM_ID: team,
  };
  // Read-only is the default — must produce byte-identical env to
  // the Go side's clickupStanza so the daemon-injected stanza and
  // the SDK-spawned stanza both narrow to the auditor persona.
  if (!i.clickup_allow_write) {
    env.CLICKUP_MCP_PERSONA = "auditor";
  }
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", "@taazkareem/clickup-mcp-server@latest"],
    env,
  };
}

// githubStanza must produce a byte-identical shape to the Go side's
// githubStanza in internal/mcp/integrations/integrations.go. The
// official GitHub MCP server ships as a docker image — we pass `-e
// KEY` without a value so docker reads from the inherited env rather
// than echoing the PAT into `ps`. The orchestrator's spawn machinery
// merges StdioStanza.env into the child process env, which docker
// then forwards into the container via the `-e` flags.
function githubStanza(i: IntegrationDisk): StdioStanza | null {
  const tok = i.github_token?.trim();
  if (!tok) return null;
  const args: string[] = ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN"];
  const env: Record<string, string> = {
    GITHUB_PERSONAL_ACCESS_TOKEN: tok,
  };
  // Read-only is the default — must produce byte-identical env to
  // the Go side so the daemon-injected stanza and the SDK-spawned
  // stanza both narrow to the read-only tool surface.
  if (!i.github_allow_write) {
    args.push("-e", "GITHUB_READ_ONLY");
    env.GITHUB_READ_ONLY = "1";
  }
  args.push("ghcr.io/github/github-mcp-server");
  return {
    type: "stdio",
    command: "docker",
    args,
    env,
  };
}

function stanzaFor(i: IntegrationDisk): StdioStanza | null {
  switch (i.service) {
    case "slack":
      return slackStanza(i);
    case "clickup":
      return clickupStanza(i);
    case "github":
      return githubStanza(i);
    default:
      return null;
  }
}

// hasEnabledService returns true when at least one *enabled*
// integration of the given service is configured. Used by sessions.ts
// to decide whether to inject service-specific system-prompt
// directives — we shouldn't tell the LLM "include ClickUp task URLs"
// if there's no ClickUp integration spawning into the session.
export function hasEnabledService(
  service: IntegrationDisk["service"],
): boolean {
  return readIntegrations().some(
    (i) => i.service === service && !i.disabled && Boolean(i.name),
  );
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
    // Parked entry — keep its secrets on disk but don't expose any
    // tool surface for it. Mirrors the Go side's apply path which
    // strips the stanza from each account's .claude.json.
    if (i.disabled) continue;
    const stanza = stanzaFor(i);
    if (stanza) out[i.name] = stanza;
  }
  return out;
}
