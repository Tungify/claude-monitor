"use client";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Check, CircleDashed, GitBranch, Loader2 } from "lucide-react";
import { Markdown } from "@/components/markdown/markdown";
import type { StreamingBlock } from "@/lib/chat-types";
import { parseCliEnvelope } from "@/lib/cli-envelope";
import { isSubagentDispatchTool } from "@/lib/subagents";
import { cn } from "@/lib/utils";
import { SubagentCard } from "./subagent-card";
import { useSubagents } from "./subagent-context";
import { TurnMetaLine } from "./thinking-indicator";
import { useTurnEndMeta, type TurnEndMeta } from "./turn-end-meta-context";

interface Props {
  msg: SDKMessage;
}

// MessageBubble is a switch over the SDKMessage discriminated union.
// We only render the types that meaningfully advance the conversation;
// noise types (stream_event partial deltas, hook progress, status pings,
// etc.) are hidden but kept in history so a backend rewind would have
// the full transcript.
export function MessageBubble({ msg }: Props) {
  switch (msg.type) {
    case "assistant":
      return <AssistantBubble msg={msg} />;
    case "user":
      return <UserBubble msg={msg} />;
    case "result":
      // Result messages used to render their own divider, but the
      // meta + cost now ride along on the assistant bubble that ended
      // the turn (via TurnEndMetaContext). Skipping them here keeps
      // the meta visually glued to the response instead of jumping to
      // a separate row, which read as "the time disappeared".
      return null;
    default:
      // system/init and stream_event variants are silenced — the header
      // already shows session metadata, and stream deltas drive the
      // separate live preview rendered in chat-panel.tsx.
      return null;
  }
}

function AssistantBubble({
  msg,
}: {
  msg: Extract<SDKMessage, { type: "assistant" }>;
}) {
  const content = msg.message.content;
  const subagents = useSubagents();
  // Only the last assistant message of each turn has an entry in the
  // map — see chat-panel.tsx where `turnEndMeta` is computed. For
  // mid-turn assistants (Claude calling a tool, getting a result,
  // then continuing) this returns null and no footer renders.
  const uuid = (msg as { uuid?: string }).uuid;
  const endMeta = useTurnEndMeta(uuid);
  return (
    <div className="space-y-1">
      {content.map((block, i) => {
        if (block.type === "text") {
          return <TextBlock key={i} text={block.text} />;
        }
        if (block.type === "tool_use") {
          // TodoWrite gets a dedicated checklist card — the bullet list
          // with status glyphs is the whole point of the tool, and
          // collapsing it under a "N todos" summary line throws away
          // the only useful surface.
          if (block.name === "TodoWrite") {
            const todos = parseTodos(
              (block.input as Record<string, unknown> | undefined)?.todos,
            );
            if (todos) return <TodoListBlock key={i} todos={todos} />;
          }
          // Subagent dispatches (tool name "Agent" in SDK 0.2.133, or
          // "Task" in older releases — see SUBAGENT_TOOL_NAMES) get
          // their own card so the user sees the subagent as one
          // logical unit instead of an opaque tool_use line followed
          // by every child message inline. Falls back to ToolUseLine
          // when the provider isn't mounted (e.g. tool_use rendered
          // outside the chat viewport, or the summary hasn't been
          // derived yet).
          if (isSubagentDispatchTool(block.name) && subagents) {
            const summary = subagents.byTaskId.get(block.id);
            if (summary) {
              const children = subagents.childrenByTaskId.get(block.id) ?? [];
              return (
                <SubagentCard
                  key={i}
                  summary={summary}
                  childCount={children.length}
                >
                  {children.map((child, idx) => (
                    <MessageBubble key={messageKey(child, idx)} msg={child} />
                  ))}
                </SubagentCard>
              );
            }
          }
          return (
            <ToolUseLine
              key={i}
              name={block.name}
              input={block.input as Record<string, unknown>}
              expandedInput={block.input}
            />
          );
        }
        if (block.type === "thinking") {
          return <ThinkingBlock key={i} thinking={block.thinking} />;
        }
        return null;
      })}
      {endMeta && <AssistantTurnFooter meta={endMeta} />}
    </div>
  );
}

// AssistantTurnFooter renders the per-turn meta line ("3m 43s · ↑
// 17.5k tokens · ↓ 1.2k") directly underneath the assistant content
// that ended the turn. Glued to the bubble (not a separate divider)
// so the meta visible during streaming stays in the same spot once
// the turn settles — no "the time disappeared" jump.
function AssistantTurnFooter({ meta }: { meta: TurnEndMeta }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pt-0.5 text-xs text-muted-foreground">
      <TurnMetaLine
        elapsedMs={meta.durationMs}
        inputTokens={meta.inputTokens}
        outputTokens={meta.outputTokens}
      />
      {meta.isError && meta.errorLabel && (
        <span className="text-destructive">{meta.errorLabel}</span>
      )}
    </div>
  );
}

// messageKey derives a stable key for nested-timeline rendering. Most
// SDKMessages carry uuid; system/result messages don't, so we fall
// back to a positional key. The prefix avoids collisions across kinds.
function messageKey(msg: SDKMessage, idx: number): string {
  const uuid = (msg as { uuid?: string }).uuid;
  if (uuid) return `${msg.type}:${uuid}`;
  return `${msg.type}:${idx}`;
}

function UserBubble({ msg }: { msg: Extract<SDKMessage, { type: "user" }> }) {
  const content = msg.message.content;
  if (typeof content === "string") {
    // Claude CLI wraps slash commands and local command output in
    // synthetic <command-name>/<local-command-stdout>/... envelopes.
    // Pure-envelope messages render as a small inline notice; mixed
    // messages (envelope + prose) render the stripped prose.
    const env = parseCliEnvelope(content);
    if (env.kind === "silent") return null;
    if (env.kind === "notice") {
      return (
        <div className="text-center text-xs text-muted-foreground italic">
          {env.label}
        </div>
      );
    }
    return (
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
        {env.intent && <IntentBadge intent={env.intent} />}
        <div className="whitespace-pre-wrap rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
          {env.text}
        </div>
      </div>
    );
  }
  // Tool results echoed back as user messages — render as continuation lines
  // under the matching tool_use bubble, plus any text/image blocks the user
  // sent alongside.
  return (
    <div className="space-y-1.5">
      {content.map((block, i) => {
        if (block.type === "text") {
          const env = parseCliEnvelope(block.text);
          if (env.kind === "silent") return null;
          if (env.kind === "notice") {
            return (
              <div
                key={i}
                className="text-center text-xs text-muted-foreground italic"
              >
                {env.label}
              </div>
            );
          }
          return (
            <div
              key={i}
              className="ml-auto flex max-w-[85%] flex-col items-end gap-1"
            >
              {env.intent && <IntentBadge intent={env.intent} />}
              <div className="whitespace-pre-wrap rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                {env.text}
              </div>
            </div>
          );
        }
        if (block.type === "image") {
          // Anthropic supports `source.type` of "base64" (inline) and
          // "url". We always send base64 from this app, but URL-source
          // messages can arrive when an SDK transcript is replayed.
          const src =
            block.source.type === "base64"
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.type === "url"
                ? block.source.url
                : undefined;
          if (!src) return null;
          return (
            <div key={i} className="ml-auto flex max-w-[85%] justify-end">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt="attachment"
                className="max-h-72 max-w-full rounded-md border bg-background object-contain shadow-sm"
              />
            </div>
          );
        }
        if (block.type === "tool_result") {
          return (
            <ToolResultLine
              key={i}
              content={block.content}
              isError={Boolean(block.is_error)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}


// IntentBadge renders a tiny pill above a user bubble when the message
// carried an orchestrator-intent envelope (currently only "multi-phase",
// see hintForMultiPhase). The directive text itself stays hidden — it
// would dump a wall of decompose-instruction noise into the user's
// transcript — but this pill keeps the user aware of how the message
// was framed so they remember why the leader behaves the way it does.
function IntentBadge({ intent }: { intent: string }) {
  if (intent === "multi-phase") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
        <GitBranch className="size-2.5" aria-hidden />
        Multi-phase
      </span>
    );
  }
  // Future intents fall back to a neutral label. Keeps the rendering
  // forward-compatible if we add more directive types without needing
  // to land the UI change in the same release.
  return (
    <span className="inline-flex items-center rounded-md border border-muted-foreground/40 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {intent}
    </span>
  );
}

// Shared block renderers used by both finalized history and the streaming
// preview. Keeping them here so the in-progress rendering can't drift away
// from the eventually-finalized rendering.

export function TextBlock({ text }: { text: string }) {
  return (
    <div className="rounded-md bg-card px-3 py-2 text-sm">
      <Markdown source={text} />
    </div>
  );
}

export function ThinkingBlock({ thinking }: { thinking: string }) {
  // The SDK occasionally emits a thinking block whose text never
  // materialises (mid-stream artefact, or a content_block_start that
  // lands without any thinking_delta children). Rendering an empty
  // collapsible looks broken — the user clicks the chevron and
  // nothing visually changes — so suppress entirely.
  if (!thinking || thinking.trim().length === 0) return null;
  return (
    <details className="group rounded-md border-l-2 border-l-muted-foreground/30 bg-muted/20 px-3 py-1.5 text-xs italic text-muted-foreground">
      <summary className="cursor-pointer select-none not-italic font-mono text-[11px] text-muted-foreground/80">
        thinking
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap">{thinking}</div>
    </details>
  );
}

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoEntry {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

// parseTodos accepts the raw `todos` value from a TodoWrite tool_use
// (which during streaming may be undefined, a partial array, or an
// array containing entries that haven't yet received all keys) and
// returns a clean array of well-formed entries — or null if there's
// nothing renderable yet. Callers fall back to ToolUseLine on null.
function parseTodos(raw: unknown): TodoEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TodoEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const content = typeof r.content === "string" ? r.content : "";
    const status =
      r.status === "pending" ||
      r.status === "in_progress" ||
      r.status === "completed"
        ? (r.status as TodoStatus)
        : "pending";
    if (!content) continue;
    out.push({
      content,
      status,
      activeForm: typeof r.activeForm === "string" ? r.activeForm : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

export function TodoListBlock({
  todos,
  streaming,
}: {
  todos: TodoEntry[];
  streaming?: boolean;
}) {
  // Header pulls the active item's running label so the user sees
  // "Auditing leader-nudge silent-fail path…" up top — same shape as
  // the CLI's progress card. Falls back to a count when nothing is
  // in_progress (all-pending lists right after creation, or terminal
  // all-done lists).
  const active = todos.find((t) => t.status === "in_progress");
  const doneCount = todos.filter((t) => t.status === "completed").length;
  const headerLabel = active
    ? `${active.activeForm ?? active.content}…`
    : `Todos · ${doneCount}/${todos.length} done`;
  return (
    <div className="rounded-md border-l-2 border-l-amber-500/60 bg-muted/30 px-3 py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-medium",
            active ? "text-amber-700 dark:text-amber-300" : "text-foreground",
          )}
        >
          {headerLabel}
        </span>
        {streaming && (
          <span className="font-mono text-[10px] text-muted-foreground">
            (updating…)
          </span>
        )}
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {todos.map((t, i) => (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2 font-mono text-[12px] leading-5",
              t.status === "completed" && "text-muted-foreground line-through",
              t.status === "in_progress" &&
                "font-semibold text-amber-700 dark:text-amber-300",
              t.status === "pending" && "text-muted-foreground",
            )}
          >
            <TodoGlyph status={t.status} />
            <span className="whitespace-pre-wrap break-words">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodoGlyph({ status }: { status: TodoStatus }) {
  if (status === "completed")
    return (
      <Check
        className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-label="completed"
      />
    );
  if (status === "in_progress")
    return (
      <Loader2
        className="mt-0.5 size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400"
        aria-label="in progress"
      />
    );
  return (
    <CircleDashed
      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60"
      aria-label="pending"
    />
  );
}

// briefToolInput renders the leading "argument" Claude CLI shows after the
// tool name — `Read(path)`, `Bash(command)`, `Grep(pattern)`. For tools we
// don't have a curated mapping for, fall back to the first string value.
const PRIMARY_KEY: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  ExitPlanMode: "plan",
  Skill: "skill",
  ToolSearch: "query",
  ScheduleWakeup: "reason",
  AskUserQuestion: "question",
};

function briefToolInput(name: string, input: Record<string, unknown>): string {
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    return `${(input.todos as unknown[]).length} todos`;
  }
  const key = PRIMARY_KEY[name];
  const candidate = key ? input[key] : Object.values(input)[0];
  if (candidate == null) return "";
  if (typeof candidate === "string") return truncate(candidate, 80);
  return truncate(JSON.stringify(candidate), 80);
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

interface ToolUseLineProps {
  name: string;
  input: Record<string, unknown>;
  expandedInput?: unknown;
  // While the tool_use input is still streaming via input_json_delta, the
  // partial JSON string drives the brief preview instead of `input`.
  streamingPartialJson?: string;
}

export function ToolUseLine({
  name,
  input,
  expandedInput,
  streamingPartialJson,
}: ToolUseLineProps) {
  // While we're still receiving input_json_delta chunks, attempt to
  // parse what we have so the brief preview tracks. JSON.parse fails
  // until the chunk completes a token boundary; on failure we show
  // an "…" placeholder so the user sees activity.
  let brief = "";
  if (streamingPartialJson !== undefined) {
    if (streamingPartialJson === "") {
      brief = "";
    } else {
      try {
        const parsed = JSON.parse(streamingPartialJson) as Record<string, unknown>;
        brief = briefToolInput(name, parsed);
      } catch {
        brief = "…";
      }
    }
  } else {
    brief = briefToolInput(name, input);
  }
  return (
    <details className="group rounded-md hover:bg-muted/30">
      <summary className="flex cursor-pointer select-none items-baseline gap-2 px-2 py-1 text-sm">
        <span className="text-emerald-500" aria-hidden>
          ●
        </span>
        <span className="font-mono font-medium">{name}</span>
        {brief && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            ({brief})
          </span>
        )}
      </summary>
      <pre className="mx-2 mt-1 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
        {streamingPartialJson !== undefined
          ? streamingPartialJson || "(empty)"
          : JSON.stringify(expandedInput ?? input, null, 2)}
      </pre>
    </details>
  );
}

// stringifyToolResult flattens the tool_result content union into a string
// so the summary line + expanded view share the same source of truth.
function stringifyToolResult(
  content: string | Array<{ type: string; text?: string }> | unknown,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[${c.type}]`))
      .join("\n");
  }
  return "";
}

interface ToolResultLineProps {
  content: string | Array<{ type: string; text?: string }> | unknown;
  isError: boolean;
}

export function ToolResultLine({ content, isError }: ToolResultLineProps) {
  const full = stringifyToolResult(content);
  const trimmed = full.trim();
  let summary: string;
  if (isError) {
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    summary = firstLine ? truncate(firstLine, 100) : "error";
  } else if (!trimmed) {
    summary = "no output";
  } else {
    const lines = trimmed.split("\n");
    summary = lines.length === 1 ? truncate(lines[0], 100) : `${lines.length} lines`;
  }
  return (
    <details className="group ml-2" open={isError}>
      <summary
        className={`flex cursor-pointer select-none items-baseline gap-1.5 px-2 py-0.5 text-xs ${
          isError ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        <span aria-hidden>⎿</span>
        <span className="truncate font-mono">{summary}</span>
      </summary>
      <pre className="mx-2 mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px]">
        {full || "(empty)"}
      </pre>
    </details>
  );
}

// StreamingTurn renders the in-flight assistant turn from the per-block
// streaming state. Same look as a finalized AssistantBubble plus a pulsing
// cursor on the most recently active text block.
export function StreamingTurn({ blocks }: { blocks: StreamingBlock[] }) {
  if (blocks.length === 0) return null;
  // Index of the trailing text block, if any — that's where we put the
  // typing cursor. Tool/thinking blocks don't get a cursor since their
  // "activity" is implied by streaming JSON / italic text.
  let cursorIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      cursorIdx = i;
      break;
    }
  }
  return (
    <div className="space-y-1">
      {blocks.map((block, i) => {
        if (!block) return null;
        if (block.type === "text") {
          return (
            <div key={i} className="rounded-md bg-card px-3 py-2 text-sm">
              <Markdown source={block.text} />
              {i === cursorIdx && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/60 align-middle" />
              )}
            </div>
          );
        }
        if (block.type === "thinking") {
          return <ThinkingBlock key={i} thinking={block.thinking} />;
        }
        if (block.type === "tool_use") {
          // Surface the streaming TodoWrite as a partially-filled
          // checklist as soon as JSON.parse can land on a token
          // boundary — until then ToolUseLine handles the "…"
          // placeholder. In practice the tool payload is small enough
          // that this only blinks for one delta or two before the
          // checklist locks in.
          if (block.name === "TodoWrite" && block.partial_json) {
            try {
              const parsed = JSON.parse(block.partial_json) as {
                todos?: unknown;
              };
              const todos = parseTodos(parsed.todos);
              if (todos)
                return <TodoListBlock key={i} todos={todos} streaming />;
            } catch {
              // partial JSON not yet valid — fall through to ToolUseLine
            }
          }
          return (
            <ToolUseLine
              key={i}
              name={block.name}
              input={{}}
              streamingPartialJson={block.partial_json}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
