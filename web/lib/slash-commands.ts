// Slash-command registry shared by the composer's autocomplete popover and
// the chat panel that actually executes them. Commands are pure metadata
// here — execution context (session, helpers) is wired in chat-panel.tsx.
//
// The list mirrors the built-in commands in Claude Code v2.1.x. Some are
// implemented locally (we have the data or can talk to the daemon),
// others are forwarded to the agent verbatim (passThrough) so the SDK
// + Claude can run their skill-based behavior, and the rest show a
// short explanation when their backend isn't available in the web
// orchestrator.

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  // Optional placeholder showing what arguments the command accepts.
  // Rendered after the name in the autocomplete (e.g. "/model <id>").
  argHint?: string;
  // Hides the command from autocomplete unless explicitly typed. Used
  // for aliases we want callable but not promoted.
  hidden?: boolean;
  // When true, the chat panel forwards the raw "/name args" text to the
  // agent (just like a normal user message) instead of executing
  // locally. Lets skill-style commands like /init or /review run
  // through Claude's own slash-command awareness.
  passThrough?: boolean;
  // Coarse grouping shown as a section header in the autocomplete and
  // /help output. Order in this file controls display order.
  group?: string;
}

// CHAT_COMMANDS are usable inside an active chat session. The chat panel
// owns the handlers (with access to session state); this file only
// describes the menu surface.
export const CHAT_COMMANDS: SlashCommand[] = [
  // ─────────── Conversation
  {
    name: "help",
    description: "Show available commands",
    group: "Conversation",
  },
  {
    name: "clear",
    description: "Start a fresh chat with the same settings",
    group: "Conversation",
  },
  {
    name: "compact",
    description: "Summarize and compact conversation history",
    passThrough: true,
    group: "Conversation",
  },
  {
    name: "rewind",
    description: "Restore file edits and conversation to a snapshot",
    group: "Conversation",
  },
  {
    name: "catch-up",
    aliases: ["catchup"],
    description: "Get caught up on what happened while away",
    passThrough: true,
    group: "Conversation",
  },

  // ─────────── Sessions
  {
    name: "sessions",
    description: "List active chat sessions",
    group: "Sessions",
  },
  {
    name: "resume",
    argHint: "[id]",
    description: "Open another active session",
    group: "Sessions",
  },
  {
    name: "stop",
    description: "Stop the current turn",
    group: "Sessions",
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "End this chat session",
    group: "Sessions",
  },

  // ─────────── Settings
  {
    name: "model",
    argHint: "[id]",
    description: "Show or change the active model",
    group: "Settings",
  },
  {
    name: "effort",
    argHint: "[level]",
    description: "Show or change reasoning effort",
    group: "Settings",
  },
  {
    name: "fast",
    description: "Toggle fast (Opus 4.6) mode",
    group: "Settings",
  },
  {
    name: "config",
    description: "Open configuration",
    group: "Settings",
  },
  {
    name: "permissions",
    description: "Show tool permission rules",
    group: "Settings",
  },
  {
    name: "output-style",
    argHint: "[style]",
    description: "Change response style",
    passThrough: true,
    group: "Settings",
  },
  {
    name: "add-dir",
    argHint: "<path>",
    description: "Add an extra working directory",
    passThrough: true,
    group: "Settings",
  },

  // ─────────── Information
  {
    name: "status",
    description: "Show session status & connection",
    group: "Information",
  },
  {
    name: "context",
    description: "Show context-window usage",
    group: "Information",
  },
  {
    name: "usage",
    description: "Show token usage breakdown for this session",
    group: "Information",
  },
  {
    name: "cost",
    description: "Show estimated cost so far",
    group: "Information",
  },
  {
    name: "stats",
    description: "Aggregated stats across sessions",
    group: "Information",
  },
  {
    name: "cwd",
    description: "Show the working folder",
    group: "Information",
  },
  {
    name: "account",
    description: "Show the active Claude account",
    group: "Information",
  },

  // ─────────── Actions
  {
    name: "copy",
    description: "Copy the last assistant message to clipboard",
    group: "Actions",
  },
  {
    name: "init",
    description: "Initialize CLAUDE.md for this folder",
    passThrough: true,
    group: "Actions",
  },
  {
    name: "review",
    description: "Review a pull request or current branch",
    passThrough: true,
    group: "Actions",
  },
  {
    name: "commit",
    description: "Create a git commit from current changes",
    passThrough: true,
    group: "Actions",
  },
  {
    name: "commit-push-pr",
    description: "Commit, push, and open a pull request",
    passThrough: true,
    group: "Actions",
  },
  {
    name: "pr-comments",
    description: "Show comments on the current pull request",
    passThrough: true,
    group: "Actions",
  },

  // ─────────── Skills & integrations
  {
    name: "agents",
    description: "List available agents/subagents",
    group: "Skills",
  },
  {
    name: "skills",
    description: "List available skills",
    group: "Skills",
  },
  {
    name: "memory",
    description: "Open auto-memory directory",
    group: "Skills",
  },
  {
    name: "tasks",
    description: "Show task list",
    passThrough: true,
    group: "Skills",
  },
  {
    name: "hooks",
    description: "Show hook configuration",
    group: "Skills",
  },
  {
    name: "mcp",
    description: "Show MCP server status",
    group: "Skills",
  },
  {
    name: "plugin",
    aliases: ["plugins"],
    description: "List installed plugins and marketplaces",
    group: "Skills",
  },
  {
    name: "loop",
    argHint: "[interval] [prompt]",
    description: "Run a prompt or slash command on a recurring interval",
    passThrough: true,
    group: "Skills",
  },
  {
    name: "ultrareview",
    argHint: "[pr#]",
    description: "Multi-agent cloud review of the current branch or PR",
    passThrough: true,
    group: "Skills",
  },
  {
    name: "babysit-prs",
    description: "Watch + nudge open pull requests",
    passThrough: true,
    group: "Skills",
  },
  {
    name: "morning-checkin",
    description: "Daily check-in summary",
    passThrough: true,
    group: "Skills",
  },
  {
    name: "install-github-app",
    description: "Install the Claude GitHub app",
    passThrough: true,
    group: "Skills",
  },

  // ─────────── Account
  {
    name: "login",
    description: "Sign in to a Claude account",
    group: "Account",
  },
  {
    name: "logout",
    description: "Sign out of the active account",
    group: "Account",
  },

  // ─────────── Misc
  {
    name: "feedback",
    description: "Report feedback or an issue on GitHub",
    group: "Misc",
  },
  {
    name: "bug",
    description: "Report a bug",
    group: "Misc",
    hidden: true,
  },
  {
    name: "doctor",
    description: "Diagnose the local Claude Code install",
    group: "Misc",
  },
  {
    name: "ide",
    description: "IDE integration helper",
    group: "Misc",
  },
  {
    name: "upgrade",
    description: "Upgrade Claude Code (CLI only)",
    group: "Misc",
  },
];

// HOME_COMMANDS are shown on the empty-state landing. Most session-scoped
// commands don't make sense before a session exists, so this list is a
// trimmed subset.
export const HOME_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "Show available commands",
  },
  {
    name: "clear",
    description: "Clear the input",
  },
  {
    name: "sessions",
    description: "List active chat sessions",
  },
];

export interface ParsedCommand {
  command: SlashCommand;
  args: string;
  // The original raw text, after trimStart, including the leading slash.
  // Useful when a handler wants to fall through and send as a regular
  // user message.
  raw: string;
}

// parseSlashCommand recognizes a leading /name (followed optionally by
// whitespace + args). Returns null if the text isn't a command or if the
// name doesn't match anything in the registry.
export function parseSlashCommand(
  text: string,
  registry: SlashCommand[],
): ParsedCommand | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] ?? "").trim();
  for (const c of registry) {
    if (c.name === name || c.aliases?.includes(name)) {
      return { command: c, args, raw: trimmed };
    }
  }
  return null;
}

// matchSlashCommands powers the autocomplete: the user's input is reduced
// to the partial name they're typing, and we filter by prefix on name +
// aliases. Returns [] when the menu shouldn't show (no leading slash, or
// the user has typed past the name into argument territory).
export function matchSlashCommands(
  text: string,
  registry: SlashCommand[],
): SlashCommand[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return [];
  // Once the user types whitespace, we treat them as past the command
  // name and stop suggesting (they're filling in arguments now).
  if (/\s/.test(trimmed)) return [];
  const q = trimmed.slice(1).toLowerCase();
  const visible = registry.filter((c) => !c.hidden);
  if (q === "") return visible;
  return visible.filter((c) => {
    if (c.name.toLowerCase().startsWith(q)) return true;
    return c.aliases?.some((a) => a.toLowerCase().startsWith(q)) ?? false;
  });
}
