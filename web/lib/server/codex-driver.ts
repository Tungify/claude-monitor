import "server-only";

import { randomUUID } from "node:crypto";

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { Codex } from "@openai/codex-sdk";
import type {
  ApprovalMode,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  ModelReasoningEffort,
  ReasoningItem,
  SandboxMode,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TodoListItem,
  Usage,
  WebSearchItem,
} from "@openai/codex-sdk";

import { CodexAuthError } from "./codex-auth";
import type {
  ChatEvent,
  Effort,
  HandoffRecord,
  SessionUsage,
} from "@/lib/chat-types";

// CodexSessionContract is the minimal shape driveCodexSession needs.
// We don't import ChatSession from sessions.ts to keep this module
// import-graph-clean — sessions.ts hands us callbacks for status
// transitions and history mutation so the driver doesn't reach into
// internal session state directly.
export interface CodexSessionContract {
  id: string;
  // Working directory passed to the codex binary as --cd. Mirrors the
  // claude-side session.cwd so codex's shell/apply_patch/file_search
  // tools operate against the same project root the user opened.
  cwd: string;
  // Snapshot of history at the moment driveCodexSession was kicked.
  // Items pushed during the loop are read straight off this array each
  // iteration so the running transcript stays in sync.
  history: SDKMessage[];
  // The most recent handoff record on this session. Required: a codex
  // session always has at least one handoff (the claude→codex one
  // that flipped its provider). Used to derive the system instructions
  // and the post-handoff input slice, and to read/write the persisted
  // codex_thread_id for cross-restart resume.
  handoff: HandoffRecord;
  // Called once per turn so a model hot-swap on the live session
  // takes effect on the next API call without a respawn. The
  // resolver reads from a mutable source (typically session.model
  // on the parent ChatSession).
  resolveModel: () => string;
  // Optional effort hot-swap. Maps Anthropic-flavored effort levels
  // (low/medium/high/xhigh/max) onto codex's reasoning effort range
  // (minimal/low/medium/high/xhigh) — "max" collapses to "xhigh"
  // since codex doesn't have a level above xhigh.
  resolveEffort?: () => Effort | undefined;
  inputQueue: AsyncIterable<SDKUserMessage>;
  abortSignal: AbortSignal;
  // Bridges back into sessions.ts.
  pushHistory: (msg: SDKMessage) => void;
  emit: (event: ChatEvent) => void;
  setStatus: (status: "starting" | "idle" | "thinking" | "errored" | "closed") => void;
  recordUsage: (usage: SessionUsage) => void;
  // Detect "the session was respawned out from under us" so a stale
  // driver doesn't flip status of a session that's been re-pointed at
  // a fresh driver instance.
  isStillCurrent: () => boolean;
  // Called when the codex SDK reports a `thread.started` event so the
  // session can persist handoff.codex_thread_id back to disk. The
  // driver already mutates handoff in place; this callback exists so
  // sessions.ts can also schedule a snapshot write — without it, the
  // thread_id only lands on disk on the next history push.
  recordThreadId?: (threadId: string) => void;
}

// CodexDriverError is what we throw on unrecoverable turn failures so
// the outer loop can format a single message line for the chat UI.
export class CodexDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDriverError";
  }
}

// Sandbox + approval defaults. workspace-write confines codex's writes
// to the chosen --cd; approval=never keeps the binary unblocked (we
// have no UI to approve mid-turn yet). If we ever surface a permission
// dialog like the claude side does, swap to "on-request".
const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";
const DEFAULT_APPROVAL_POLICY: ApprovalMode = "never";

// driveCodexSession is the codex-flavored twin of driveSession in
// sessions.ts. Pumping pattern matches: read SDKUserMessage from the
// queue, spawn the codex binary via the @openai/codex-sdk SDK per
// turn (the SDK does `codex exec --experimental-json` under the
// hood — see exec.ts in @openai/codex-sdk), stream item events,
// translate them into Anthropic-flavored SDKMessage blocks so the
// existing chat panel can render them, and push them to history.
//
// Why per-turn process: the codex binary's exec mode is one-shot —
// it reads stdin, emits JSONL events to stdout, then exits. To get
// continuity we pass `resume <thread_id>` after the first turn,
// which makes codex hydrate the on-disk session at
// <CODEX_HOME>/sessions/<id>.jsonl. That means we can hot-swap the
// model, sandbox mode, etc. on each turn without losing context.
export async function driveCodexSession(
  session: CodexSessionContract,
): Promise<void> {
  session.setStatus("idle");

  try {
    for await (const userMsg of session.inputQueue) {
      if (!session.isStillCurrent()) return;
      session.setStatus("thinking");
      try {
        await driveOneCodexTurn(session, userMsg);
      } catch (err) {
        if (!session.isStillCurrent()) return;
        if (
          err instanceof Error &&
          (err.name === "AbortError" || session.abortSignal.aborted)
        ) {
          // Session was closed / interrupted mid-turn — fall out
          // through the natural end branch below.
          return;
        }
        const message = formatCodexError(err);
        emitCodexFailureMessage(session, message);
        session.emit({ type: "error", data: { message } });
        session.setStatus("idle");
      }
    }
    if (!session.isStillCurrent()) return;
    session.setStatus("closed");
    session.emit({ type: "closed", data: {} });
  } catch (err) {
    if (!session.isStillCurrent()) return;
    session.setStatus("errored");
    session.emit({
      type: "error",
      data: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// driveOneCodexTurn runs a single codex Thread.runStreamed() for the
// just-popped user message. The user message has already been written
// to history by sendMessage (same as the claude path), so we don't
// re-push it here — the driver only adds assistant/tool/result rows.
async function driveOneCodexTurn(
  session: CodexSessionContract,
  userMsg: SDKUserMessage,
): Promise<void> {
  if (!session.handoff.codex_config_dir) {
    throw new CodexDriverError("codex session has no codex_config_dir");
  }

  // Build the Codex client per turn. The SDK's Codex class is cheap to
  // construct (the spawn happens on .run()), and rebuilding lets us pick
  // up env/CODEX_HOME changes if the user ever swaps accounts on a
  // running session. `env` is exhaustive: if we pass it at all the SDK
  // skips inheriting from process.env, so we merge in the parent env
  // by hand.
  const env = buildEnv(session.handoff.codex_config_dir);
  const codex = new Codex({ env });

  // Resolve thread options fresh per turn so model/effort hot-swaps
  // land on the very next API call.
  const threadOptions: ThreadOptions = {
    model: session.resolveModel(),
    workingDirectory: session.cwd,
    // Codex bails on non-git workspaces unless we opt out. The
    // orchestrator runs in arbitrary project dirs (including
    // ephemeral worktrees), so always skip the check.
    skipGitRepoCheck: true,
    sandboxMode: DEFAULT_SANDBOX_MODE,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
  };
  const effort = effortToReasoning(session.resolveEffort?.());
  if (effort) threadOptions.modelReasoningEffort = effort;

  const isFirstTurn = !session.handoff.codex_thread_id;
  const thread = isFirstTurn
    ? codex.startThread(threadOptions)
    : codex.resumeThread(session.handoff.codex_thread_id!, threadOptions);

  const prompt = buildPromptForTurn(session, userMsg, isFirstTurn);

  // Per-turn streaming state. We track every in-flight item by id so
  // a series of item.started → item.updated → item.completed events
  // collapses into the right SDKMessage emission at the right moment.
  // agent_message gets live delta streaming (stream_event content_block_delta),
  // everything else lands on item.completed as one or two finalized
  // SDKMessages (assistant tool_use + user tool_result).
  const agentTexts = new Map<string, { uuid: string; text: string }>();
  let usage: Usage | undefined;
  let failureMessage: string | undefined;
  let lastAgentText = "";

  const { events } = await thread.runStreamed(prompt, {
    signal: session.abortSignal,
  });

  for await (const ev of events) {
    if (!session.isStillCurrent()) return;
    handleEvent(session, ev, agentTexts, {
      onUsage: (u) => (usage = u),
      onFailure: (m) => (failureMessage = m),
      onAgentTextFinal: (text) => (lastAgentText = text),
    });
  }

  if (failureMessage) {
    throw new CodexDriverError(failureMessage);
  }

  if (usage) session.recordUsage(codexUsageToSession(usage));

  // Result message gives the UI its end-of-turn signal (status flips
  // back to idle, context-window meter recomputes).
  const resultMsg: SDKMessage = {
    type: "result",
    uuid: randomUUID(),
    session_id: session.id,
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: lastAgentText,
    total_cost_usd: 0,
    usage: codexUsageToAnthropic(usage),
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
  session.pushHistory(resultMsg);
  session.emit({ type: "message", data: resultMsg });
  session.setStatus("idle");
}

interface HandlerCallbacks {
  onUsage: (u: Usage) => void;
  onFailure: (m: string) => void;
  onAgentTextFinal: (text: string) => void;
}

function handleEvent(
  session: CodexSessionContract,
  ev: ThreadEvent,
  agentTexts: Map<string, { uuid: string; text: string }>,
  cb: HandlerCallbacks,
): void {
  switch (ev.type) {
    case "thread.started":
      if (session.handoff.codex_thread_id !== ev.thread_id) {
        session.handoff.codex_thread_id = ev.thread_id;
        session.recordThreadId?.(ev.thread_id);
      }
      break;
    case "turn.started":
      // No-op: setStatus("thinking") was already done by the outer loop.
      break;
    case "item.started":
      handleItemStarted(session, ev.item, agentTexts);
      break;
    case "item.updated":
      handleItemUpdated(session, ev.item, agentTexts);
      break;
    case "item.completed":
      handleItemCompleted(session, ev.item, agentTexts, cb.onAgentTextFinal);
      break;
    case "turn.completed":
      cb.onUsage(ev.usage);
      break;
    case "turn.failed":
      cb.onFailure(ev.error.message);
      break;
    case "error":
      cb.onFailure(ev.message);
      break;
  }
}

function handleItemStarted(
  _session: CodexSessionContract,
  item: ThreadItem,
  agentTexts: Map<string, { uuid: string; text: string }>,
): void {
  if (item.type === "agent_message") {
    // Reserve a uuid up front so stream_event deltas can target it via
    // parent_message_uuid. We do NOT emit anything yet — the assistant
    // message is finalized on item.completed.
    if (!agentTexts.has(item.id)) {
      agentTexts.set(item.id, { uuid: randomUUID(), text: "" });
    }
  }
  // Other item types (command_execution, file_change, mcp_tool_call,
  // web_search, todo_list, reasoning) flush on item.completed only —
  // emitting an in-progress placeholder would clutter the transcript
  // and double-render once the completion event arrived.
}

function handleItemUpdated(
  session: CodexSessionContract,
  item: ThreadItem,
  agentTexts: Map<string, { uuid: string; text: string }>,
): void {
  if (item.type !== "agent_message") return;
  const state = agentTexts.get(item.id);
  if (!state) {
    // We missed item.started — synthesize state so delta math still works.
    agentTexts.set(item.id, { uuid: randomUUID(), text: item.text });
    emitAssistantDelta(session, agentTexts.get(item.id)!.uuid, item.text);
    return;
  }
  if (item.text.length <= state.text.length) {
    // Codex sometimes re-emits the same cumulative text on item.updated.
    // Nothing to render; just keep state pinned.
    state.text = item.text;
    return;
  }
  const delta = item.text.slice(state.text.length);
  state.text = item.text;
  emitAssistantDelta(session, state.uuid, delta);
}

function handleItemCompleted(
  session: CodexSessionContract,
  item: ThreadItem,
  agentTexts: Map<string, { uuid: string; text: string }>,
  onAgentTextFinal: (text: string) => void,
): void {
  switch (item.type) {
    case "agent_message": {
      const state = agentTexts.get(item.id) ?? {
        uuid: randomUUID(),
        text: "",
      };
      // Final text always wins over our cumulative buffer (handles the
      // rare codex case where item.updated never fires for short
      // replies and the full text only lands on item.completed).
      const finalText = item.text || state.text;
      onAgentTextFinal(finalText);
      pushAssistantText(session, state.uuid, finalText, item.id);
      agentTexts.delete(item.id);
      return;
    }
    case "reasoning":
      pushAssistantThinking(session, item);
      return;
    case "command_execution":
      pushToolPair(session, commandToToolUse(item), commandToToolResult(item));
      return;
    case "file_change":
      pushToolPair(session, fileChangeToToolUse(item), fileChangeToToolResult(item));
      return;
    case "mcp_tool_call":
      pushToolPair(session, mcpToToolUse(item), mcpToToolResult(item));
      return;
    case "web_search":
      pushToolPair(session, webSearchToToolUse(item), webSearchToToolResult(item));
      return;
    case "todo_list":
      // TodoWrite renders standalone — no matching tool_result echo.
      pushAssistantToolOnly(session, todoListToToolUse(item));
      return;
    case "error":
      pushErrorItem(session, item);
      return;
  }
}

// buildPromptForTurn assembles the prompt we feed codex per turn. On
// the very first turn after a claude→codex handoff we prepend the
// handoff summary so codex has the pre-handoff context (it can't read
// the Anthropic-format transcript on its own). On subsequent turns
// it's just the user's text — codex's own resume mechanism handles
// the rest from <CODEX_HOME>/sessions/<thread_id>.jsonl.
function buildPromptForTurn(
  session: CodexSessionContract,
  userMsg: SDKUserMessage,
  isFirstTurn: boolean,
): string {
  const userText = extractUserText(userMsg);
  if (!isFirstTurn) return userText;

  const summary = session.handoff.summary?.trim() ?? "";
  // Direct codex sessions (started from the home composer) carry a
  // sentinel handoff: at_message_index = -1, empty summary. No
  // pre-handoff transcript to bridge — just send the user's text.
  if (!summary && session.handoff.at_message_index === -1) {
    return userText;
  }
  return [
    "You're continuing a software engineering chat that started in Anthropic Claude and was just handed off to you (OpenAI Codex) mid-session via the claude-monitor orchestrator.",
    "The summary below is your context from before the handoff — treat it like a /resume preamble. Your full local tool suite (shell, apply_patch, file ops, MCP, web search) is available; use it as you would in a normal codex session.",
    "",
    "## Pre-handoff summary (written by claude)",
    "",
    summary,
    "",
    "## Latest user message",
    "",
    userText,
  ].join("\n");
}

function extractUserText(msg: SDKMessage): string {
  if (msg.type !== "user") return "";
  const m = msg as unknown as {
    message?: {
      content?: string | Array<{ type: string; text?: string; content?: unknown }>;
    };
  };
  const content = m.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

// emitAssistantDelta synthesizes an SDKPartialAssistantMessage so the
// chat panel's live-preview path (already handles content_block_delta
// from claude) renders codex deltas identically. We use a single
// content block at index 0 since codex doesn't split text into
// multiple blocks the way Claude can.
function emitAssistantDelta(
  session: CodexSessionContract,
  assistantUuid: string,
  delta: string,
): void {
  const streamEvent = {
    type: "stream_event",
    uuid: randomUUID(),
    session_id: session.id,
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta },
    },
    parent_message_uuid: assistantUuid,
  } as unknown as SDKMessage;
  session.emit({ type: "message", data: streamEvent });
}

function pushAssistantText(
  session: CodexSessionContract,
  uuid: string,
  text: string,
  codexItemId: string,
): void {
  const msg = makeAssistantMessage(session, uuid, [{ type: "text", text }], codexItemId);
  session.pushHistory(msg);
  session.emit({ type: "message", data: msg });
}

function pushAssistantThinking(
  session: CodexSessionContract,
  item: ReasoningItem,
): void {
  // Codex reasoning summaries are short paragraphs — render them as
  // thinking blocks so MessageBubble shows the collapsible thinking
  // bubble it already has for claude extended thinking.
  const msg = makeAssistantMessage(
    session,
    randomUUID(),
    [{ type: "thinking", thinking: item.text, signature: "" }],
    item.id,
  );
  session.pushHistory(msg);
  session.emit({ type: "message", data: msg });
}

function pushToolPair(
  session: CodexSessionContract,
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  toolResult: { tool_use_id: string; content: string; is_error: boolean },
): void {
  const asstUuid = randomUUID();
  const userUuid = randomUUID();
  const asstMsg = makeAssistantMessage(
    session,
    asstUuid,
    [
      {
        type: "tool_use",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      },
    ],
    toolUse.id,
  );
  const userMsg: SDKMessage = {
    type: "user",
    uuid: userUuid,
    session_id: session.id,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolResult.tool_use_id,
          content: [{ type: "text", text: toolResult.content }],
          is_error: toolResult.is_error,
        },
      ],
    },
  } as unknown as SDKMessage;
  session.pushHistory(asstMsg);
  session.emit({ type: "message", data: asstMsg });
  session.pushHistory(userMsg);
  session.emit({ type: "message", data: userMsg });
}

function pushAssistantToolOnly(
  session: CodexSessionContract,
  toolUse: { id: string; name: string; input: Record<string, unknown> },
): void {
  const msg = makeAssistantMessage(
    session,
    randomUUID(),
    [
      {
        type: "tool_use",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      },
    ],
    toolUse.id,
  );
  session.pushHistory(msg);
  session.emit({ type: "message", data: msg });
}

function pushErrorItem(
  session: CodexSessionContract,
  item: ErrorItem,
): void {
  const msg = makeAssistantMessage(
    session,
    randomUUID(),
    [{ type: "text", text: `⚠ codex error: ${item.message}` }],
    item.id,
  );
  session.pushHistory(msg);
  session.emit({ type: "message", data: msg });
}

function makeAssistantMessage(
  session: CodexSessionContract,
  uuid: string,
  content: Array<Record<string, unknown>>,
  responseId: string,
): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: session.id,
    parent_tool_use_id: null,
    message: {
      id: responseId || uuid,
      type: "message",
      role: "assistant",
      model: session.resolveModel(),
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

// === Tool item translators ===
//
// Each codex item type maps onto an Anthropic-flavored tool_use block.
// We pick tool names that the chat panel already styles (Bash for
// shell, Edit/Write/Bash-rm for file changes, WebSearch for search,
// TodoWrite for plans) so MessageBubble's existing tool renderers
// pick them up without per-codex special cases. Unknown MCP tools
// fall through with their codex-side `mcp__server__tool` name — the
// generic renderer handles those.

function commandToToolUse(item: CommandExecutionItem): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  return {
    id: item.id,
    name: "Bash",
    input: {
      command: item.command,
      description: "codex shell",
    },
  };
}

function commandToToolResult(item: CommandExecutionItem): {
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  const out = item.aggregated_output ?? "";
  const exit = item.exit_code;
  const isErr = item.status === "failed" || (exit !== undefined && exit !== 0);
  const header =
    exit === undefined ? "" : `exit ${exit}\n`;
  return {
    tool_use_id: item.id,
    content: header + out,
    is_error: isErr,
  };
}

function fileChangeToToolUse(item: FileChangeItem): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  // We don't get the patch payload in the item — only paths + kinds.
  // Surface as a single "apply_patch" tool_use with a summary input
  // so the chat panel renders a generic tool card. The user can read
  // the diff via git or the file in their editor.
  return {
    id: item.id,
    name: "ApplyPatch",
    input: {
      changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })),
    },
  };
}

function fileChangeToToolResult(item: FileChangeItem): {
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  const lines = item.changes.map((c) => `${c.kind}: ${c.path}`);
  const body = lines.join("\n");
  const isErr = item.status === "failed";
  return {
    tool_use_id: item.id,
    content: isErr ? `Patch failed.\n${body}` : body,
    is_error: isErr,
  };
}

function mcpToToolUse(item: McpToolCallItem): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  return {
    id: item.id,
    name: `mcp__${item.server}__${item.tool}`,
    input:
      item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
        ? (item.arguments as Record<string, unknown>)
        : { value: item.arguments },
  };
}

function mcpToToolResult(item: McpToolCallItem): {
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  if (item.error) {
    return {
      tool_use_id: item.id,
      content: item.error.message,
      is_error: true,
    };
  }
  const parts: string[] = [];
  for (const block of item.result?.content ?? []) {
    // The MCP content union has many types; we render the common
    // text/image cases inline and stringify the rest as JSON.
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return {
    tool_use_id: item.id,
    content: parts.join("\n") || "(no content)",
    is_error: false,
  };
}

function webSearchToToolUse(item: WebSearchItem): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  return {
    id: item.id,
    name: "WebSearch",
    input: { query: item.query },
  };
}

function webSearchToToolResult(item: WebSearchItem): {
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  // Codex doesn't surface the search results back in the item — they
  // arrive in the next agent_message or as additional tool calls.
  // Echo the query as a placeholder result so the tool_use card has
  // something to render.
  return {
    tool_use_id: item.id,
    content: `(search dispatched: ${item.query})`,
    is_error: false,
  };
}

function todoListToToolUse(item: TodoListItem): {
  id: string;
  name: string;
  input: Record<string, unknown>;
} {
  return {
    id: item.id,
    name: "TodoWrite",
    input: {
      todos: item.items.map((t) => ({
        content: t.text,
        status: t.completed ? "completed" : "in_progress",
        activeForm: t.text,
      })),
    },
  };
}

// === Helpers ===

function buildEnv(configDir: string): Record<string, string> {
  // We must pass env exhaustively — when SDK sees a non-undefined env,
  // it skips process.env inheritance entirely. Filter undefined values
  // because Record<string,string> can't carry them.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.CODEX_HOME = configDir;
  return env;
}

// effortToReasoning maps the orchestrator's effort union onto codex's
// reasoning effort levels. Codex doesn't have "max"; we collapse it to
// xhigh (the topmost level it supports).
function effortToReasoning(effort: Effort | undefined): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

// codexUsageToAnthropic shoehorns codex's usage shape into the
// Anthropic-flavored usage shape the existing UI expects on
// assistant/result messages. Fields without a clean codex counterpart
// (cache_creation_input_tokens) zero out — the meter degrades
// gracefully rather than showing nonsense.
function codexUsageToAnthropic(
  usage: Usage | undefined,
): Record<string, number> {
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens,
    cache_creation_input_tokens: 0,
  };
}

function codexUsageToSession(usage: Usage): SessionUsage {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cached_input_tokens,
    cache_creation_input_tokens: 0,
  };
}

// emitCodexFailureMessage surfaces a codex-side error as an assistant
// message in the transcript (visible to the user) AND as a ChatEvent
// "error" (handled by the UI's error banner). Twin emission means a
// reload from disk still shows the failure inline even though the
// transient SSE banner is gone.
function emitCodexFailureMessage(
  session: CodexSessionContract,
  text: string,
): void {
  const msg = makeAssistantMessage(
    session,
    randomUUID(),
    [{ type: "text", text: `⚠ codex error: ${text}` }],
    "",
  );
  session.pushHistory(msg);
  session.emit({ type: "message", data: msg });
}

function formatCodexError(err: unknown): string {
  if (err instanceof CodexAuthError) {
    return `auth: ${err.message}`;
  }
  if (err instanceof CodexDriverError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

