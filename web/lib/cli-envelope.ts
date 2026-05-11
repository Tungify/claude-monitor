// Synthetic user messages emitted by the Claude Code CLI wrap their
// payload in XML-style envelopes that aren't user-typed prose:
//   <command-name>/clear</command-name>
//   <command-message>clear</command-message>
//   <command-args></command-args>
//   <local-command-stdout>...</local-command-stdout>
//   <local-command-stderr>...</local-command-stderr>
// The orchestrator also injects its own envelope for the multi-phase
// toggle:
//   <orchestrator-intent>multi-phase</orchestrator-intent>
//   Decompose the request below into parallel phases ...
// Rendering them verbatim looks broken (a wall of instruction text
// before the user's actual prompt), so the chat surfaces strip these
// envelopes + their immediately-following preamble lines, and surface
// a small badge so the user still sees they sent it as multi-phase.

// The decompose preamble is a fixed-shape directive (see
// hintForMultiPhase in components/composer/intent-picker.tsx). We match
// against the leading "Decompose the request below" prefix rather than
// a verbatim string so future copy edits don't reintroduce the wall.
const ORCHESTRATOR_INTENT_RE =
  /<orchestrator-intent>([\s\S]*?)<\/orchestrator-intent>\s*(?:Decompose the request below[^\n]*\n?)?/g;

const ENVELOPE_PATTERNS: RegExp[] = [
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  ORCHESTRATOR_INTENT_RE,
];

export function stripCliEnvelopes(s: string): string {
  let out = s;
  for (const re of ENVELOPE_PATTERNS) out = out.replace(re, "");
  return out.trim();
}

export type CliEnvelope =
  | { kind: "prose"; text: string; intent?: string }
  | { kind: "notice"; label: string; intent?: string }
  | { kind: "silent" };

// parseCliEnvelope categorises a raw string user-message body:
//   prose  — has user-typed text (envelope tags already stripped)
//   notice — pure envelope; show as an inline italic notice
//   silent — pure envelope with no inner text worth showing
//
// `intent` surfaces the orchestrator directive type (currently only
// "multi-phase") so the chat can render a small badge alongside the
// user's prose — the directive itself is hidden, but the user still
// sees which intent they sent.
export function parseCliEnvelope(s: string): CliEnvelope {
  const intentMatch = /<orchestrator-intent>([\s\S]*?)<\/orchestrator-intent>/.exec(s);
  const intent = intentMatch ? intentMatch[1].trim() : undefined;

  const stripped = stripCliEnvelopes(s);
  if (stripped) return { kind: "prose", text: stripped, intent };
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (cmd && cmd[1].trim()) return { kind: "notice", label: cmd[1].trim() };
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(s);
  if (stdout && stdout[1].trim()) return { kind: "notice", label: stdout[1].trim() };
  const stderr = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/.exec(s);
  if (stderr && stderr[1].trim()) return { kind: "notice", label: stderr[1].trim() };
  if (intent) return { kind: "notice", label: `${intent} directive`, intent };
  return { kind: "silent" };
}
