"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown } from "lucide-react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useChatSession } from "@/hooks/use-chat-session";
import { useDaemonContext } from "@/lib/daemon-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Composer, type ComposerSubmit } from "@/components/composer/composer";
import {
  DEFAULT_EFFORT,
  EFFORT_LABELS,
  MODELS,
  modelById,
} from "@/lib/models";
import type {
  AskUserQuestionAnswers,
  AskUserQuestionRequest,
  Effort,
  PermissionMode,
  SessionSummary,
  SessionUsage,
  StreamingBlock,
} from "@/lib/chat-types";
import type { AccountState } from "@/lib/daemon";
import type { PlanRecord } from "@/lib/plan-types";
import {
  CHAT_COMMANDS,
  parseSlashCommand,
  type ParsedCommand,
} from "@/lib/slash-commands";
import { nextPermissionMode } from "@/lib/permission-mode";
import { SidebarTrigger } from "@/components/sidebar/sidebar-trigger";
import { MessageBubble, StreamingTurn } from "./message-bubble";
import { ThinkingIndicator } from "./thinking-indicator";
import { QueueIndicator, computeQueuedMessages } from "./queue-indicator";
import { PermissionDialog } from "./permission-dialog";
import { PlanCard } from "./plan-card";
import { RewindPicker } from "./rewind-picker";
import { AskQuestionCard } from "./ask-question-card";
import { ToolRunCard } from "./tool-run-card";
import { SubagentProvider } from "./subagent-context";
import { isSubagentDispatchTool, shouldHideFromMainTimeline } from "@/lib/subagents";
import {
  CommandOutputBubble,
  type CommandOutput,
  type UsageBar,
} from "./command-output-bubble";

interface Props {
  session: SessionSummary;
}

// One Virtuoso item — message history is interleaved with the streaming
// preview, latest plan, and any error notices so they share the same
// virtualized scroll viewport. Anything that needs to anchor at the
// bottom is added as a trailing item.
// classifyForRun decides whether a message can participate in a
// "tool run" group:
//   tool_asst   — assistant turn whose content is exclusively tool_use
//                 (and optionally thinking); a real text reply ends a
//                 run because that's where Claude is talking to the
//                 user, not just operating.
//   tool_user   — user message whose content is exclusively tool_result
//                 echoes (the SDK's reply to a prior tool_use).
//   skip        — non-rendering noise (system hook events, result-end
//                 markers, future unknown types). Passes transparently
//                 through a streak so a single hook ping doesn't shred
//                 a 10-call tool run into two visible groups.
//   other       — real user text or assistant text — a genuine
//                 conversational beat that ends the streak.
// Hidden subagent-internal messages are filtered upstream and never
// reach this classifier.
// Tools whose result the user mostly looks at *directly* (not as
// supporting evidence for an investigation) — collapsing them into a
// run hides the very thing the user wanted to see. TodoWrite is the
// canonical example: the checklist IS the artifact, not a step toward
// one. Add other "first-class output" tools here as they come up
// (ExitPlanMode, AskUserQuestion would be siblings if they weren't
// already lifted out via dedicated cards).
const STANDALONE_TOOLS = new Set(["TodoWrite"]);

function hasStandaloneTool(blocks: { type: string; name?: string }[]): boolean {
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name && STANDALONE_TOOLS.has(b.name)) {
      return true;
    }
  }
  return false;
}

function classifyForRun(
  msg: SDKMessage,
): "tool_asst" | "tool_user" | "skip" | "other" {
  if (msg.type === "assistant") {
    const content = msg.message.content;
    let hasToolUse = false;
    for (const b of content) {
      if (b.type === "tool_use") hasToolUse = true;
    }
    // Any assistant turn that calls at least one tool counts as part
    // of a tool run, even if it leads with a brief text intro like
    // "Let me check…". The text gets folded into the collapsible
    // alongside the tool_use, which is what the user wants — short
    // operating commentary should NOT shatter a 10-call streak into
    // five tiny groups. A turn with text and NO tool_use stays
    // "other" so a real conversational reply still ends the run.
    //
    // EXCEPTION: a TodoWrite (or other STANDALONE_TOOLS) call must NOT
    // be folded into a tool-run group — the checklist is what the user
    // came here to see, and burying it inside a bash collapsible
    // hides it. Treat it as "other" so it breaks the streak and
    // renders as its own MessageBubble / TodoCard.
    if (hasStandaloneTool(content)) return "other";
    return hasToolUse ? "tool_asst" : "other";
  }
  if (msg.type === "user") {
    const content = msg.message.content;
    if (typeof content === "string") {
      // Plain user text is a real conversational beat — break streak.
      // The synthetic <local-command-stdout> envelope renders as a
      // small inline notice but it still represents a user gesture
      // (slash command), so treat as "other" too.
      return "other";
    }
    if (content.length === 0) return "other";
    for (const b of content) {
      if (b.type !== "tool_result") return "other";
    }
    return "tool_user";
  }
  // system (init, hook_started/hook_response/compact_boundary),
  // result (turn-end), stream_event (partial deltas — but those are
  // already filtered before they reach history), and any future SDK
  // top-level types: don't render as standalone rows in the main
  // timeline (or render as trivial chrome), so they shouldn't break
  // a streak. Skip them.
  return "skip";
}

type ChatItem =
  | { kind: "message"; msg: SDKMessage }
  | { kind: "streaming"; blocks: StreamingBlock[] }
  | { kind: "plan"; plan: PlanRecord }
  | { kind: "ask_question"; request: AskUserQuestionRequest }
  | { kind: "error"; message: string; index: number }
  | { kind: "command_output"; output: CommandOutput; id: string }
  | { kind: "thinking" }
  // tool_run collapses ≥2 contiguous tool-only turns (assistant emits
  // only tool_use/thinking blocks, user echoes only tool_result) into
  // one collapsible block. runId is the first message's uuid so the
  // virtuoso key is stable across re-renders.
  | { kind: "tool_run"; runId: string; messages: SDKMessage[] };

interface CommandLog {
  id: string;
  output: CommandOutput;
  // Number of history entries when the command was run. Used to splice
  // the output back into the right spot of the timeline if the user
  // continues chatting afterwards — otherwise commands clump at the
  // bottom and look temporally wrong.
  insertAfter: number;
}

export function ChatPanel({ session }: Props) {
  const chat = useChatSession(session.id);
  const daemon = useDaemonContext();
  const router = useRouter();
  const [effort, setEffort] = useState<Effort>(session.effort ?? DEFAULT_EFFORT);
  const [model, setModel] = useState<string>(session.model ?? "");
  // permission_mode is one of the only session knobs whose default
  // hasn't always existed on disk — coerce to "default" when the
  // server returned a session without it.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (session.permission_mode as PermissionMode | undefined) ?? "default",
  );
  const [commandLog, setCommandLog] = useState<CommandLog[]>([]);
  // /rewind opens the file-history picker. Boolean rather than
  // payload because the picker fetches snapshots itself — keeping the
  // open state minimal here lets the picker re-fetch each time the
  // user re-opens it (history grows mid-session).
  const [rewindOpen, setRewindOpen] = useState(false);
  // OR favorites list for the composer's model chip. Only fetched when
  // this session is OR-routed; native sessions skip the request. Picker
  // selections call patchOptions({model}) which goes through the SDK's
  // setModel — the binary then carries that id verbatim to OR on the
  // next request. Refreshed once on mount; opening the OR settings
  // dialog from the sidebar would write but this component re-mounts
  // when the user re-enters the chat, so a single fetch is enough.
  const [orModels, setOrModels] = useState<string[]>([]);
  useEffect(() => {
    if (session.provider !== "openrouter") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/openrouter");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { models: string[] };
        if (!cancelled) setOrModels(data.models);
      } catch {
        // chip falls back to "(no models saved)" silently
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.provider]);

  // Legacy OR sessions stored `session.model` as a Claude tier anchor
  // (e.g. "claude-opus-4-7") rather than the actual OR id, because the
  // earlier tier-mapping flow used those anchors to pick the right
  // ANTHROPIC_DEFAULT_*_MODEL env var. The composer chip then has
  // nothing to match against the favorites list and reads as "(no
  // models saved)".
  //
  // Recover the real id from the SDK's reported `assistant.message.model`
  // — that's whatever OR resolved the request to and matches the
  // favorites list. Sync once when the model first arrives in history;
  // after that the user's setModel calls take over.
  useEffect(() => {
    if (session.provider !== "openrouter") return;
    if (model.includes("/")) return; // already an OR id
    const reported = latestAssistantModel(chat.history);
    if (!reported || reported === model) return;
    // queueMicrotask defers the setter past the current render so
    // React 19's set-state-in-effect lint stays quiet — the setter
    // running one microtask later is imperceptible on screen.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setModel(reported);
    });
    return () => {
      cancelled = true;
    };
    // Don't depend on `model` so the sync only fires until the
    // displayed value catches up; a user-initiated patchOptions
    // afterwards will set model to a new OR id with "/", which
    // satisfies the early return above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.provider, chat.history]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Track viewport position so we can show a "scroll to latest" button
  // when the user has read-up. Virtuoso fires atBottomStateChange when
  // the threshold is crossed in either direction.
  const [atBottom, setAtBottom] = useState(true);
  // Mount Virtuoso only after the SSE source emits `history_replayed`
  // — a sentinel the events route writes immediately after iterating
  // snap.history. The hook also dispatches `reset` when sessionId
  // changes, so on tab switch `hydrated` is back to false until the
  // new session's history finishes replaying.
  // Track which session.id we last did the imperative scroll-to-
  // bottom for. Belt-and-suspenders against `initialTopMostItemIndex`
  // not landing the right way on every system / scroll-restoration
  // setup. Cleared by ref-reset on session.id change.
  const initialScrollSessionRef = useRef<string | null>(null);

  // Match the session to one of the daemon's known accounts so /usage,
  // /account, /stats, /status can read live OAuth quota windows. Match by
  // config_dir first (durable), name second (covers older sessions where
  // config_dir might disagree with the snapshot's spelling).
  const activeAccount = findAccount(
    daemon.snapshot?.accounts,
    session.config_dir,
    session.account_name,
  );

  const appendOutput = (output: CommandOutput) => {
    setCommandLog((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${prev.length}`,
        output,
        insertAfter: chat.history.length,
      },
    ]);
  };

  // PATCH the running session with new model/effort. Optimistic update
  // first so the picker chip reflects the choice immediately; if the
  // server rejects (e.g. session already closed), we revert and surface
  // the error in the chat panel's error list.
  const patchOptions = async (patch: {
    model?: string;
    effort?: Effort;
    permission_mode?: PermissionMode;
  }) => {
    const prev = { model, effort, permissionMode };
    if (patch.model) setModel(patch.model);
    if (patch.effort) setEffort(patch.effort);
    if (patch.permission_mode) setPermissionMode(patch.permission_mode);
    try {
      const res = await fetch(`/api/chat/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    } catch {
      setModel(prev.model);
      setEffort(prev.effort);
      setPermissionMode(prev.permissionMode);
    }
  };

  // Shift+Tab cycles through permission modes the same way the Claude
  // Code CLI does (default → acceptEdits → plan → bypassPermissions →
  // default). Bound on `window` so it works whether the textarea has
  // focus or not — preventDefault stops the browser's tab-rotation
  // navigation. The fresh permissionMode read inside the handler avoids
  // staleness without taking it as a dep (which would re-bind the
  // listener on every keystroke).
  const permissionModeRef = useRef(permissionMode);
  useEffect(() => {
    permissionModeRef.current = permissionMode;
  }, [permissionMode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key !== "Tab") return;
      // Don't fight other modifier-laden Tab combos (Ctrl+Shift+Tab is
      // the browser's "previous tab" shortcut on most platforms).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const next = nextPermissionMode(permissionModeRef.current);
      void patchOptions({ permission_mode: next });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // patchOptions is recreated each render but stable in behavior;
    // we read permission mode through the ref above. Empty deps keep
    // the listener registered exactly once for the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The SSR snapshot's `usage` is from session creation; once SSE starts
  // streaming, it becomes stale. Recompute from the latest `result` SDK
  // message in history so the context meter reflects live tokens. React
  // Compiler memoizes this — manual useMemo conflicts with its analysis.
  const liveUsage = latestUsage(chat.history) ?? session.usage;

  // Subagent grouping derives from history. We pass it through context
  // so MessageBubble can render Task tool_use blocks as SubagentCards;
  // here we use it to filter the main timeline so child messages and
  // top-level tool_result echoes don't double-render alongside the card.
  const subagentDerivation = useMemo(
    () => ({
      byTaskId: chat.subagentsByTaskId,
      childrenByTaskId: chat.subagentChildrenByTaskId,
      resultTaskIds: chat.subagentResultTaskIds,
      list: chat.subagents,
    }),
    [
      chat.subagentsByTaskId,
      chat.subagentChildrenByTaskId,
      chat.subagentResultTaskIds,
      chat.subagents,
    ],
  );

  const items = useMemo<ChatItem[]>(() => {
    const out: ChatItem[] = [];
    const sortedCmds = [...commandLog].sort(
      (a, b) => a.insertAfter - b.insertAfter,
    );
    let cmdIdx = 0;
    const flushCmdsUpTo = (boundary: number) => {
      while (
        cmdIdx < sortedCmds.length &&
        sortedCmds[cmdIdx].insertAfter <= boundary
      ) {
        out.push({
          kind: "command_output",
          output: sortedCmds[cmdIdx].output,
          id: sortedCmds[cmdIdx].id,
        });
        cmdIdx++;
      }
    };
    flushCmdsUpTo(0);
    // visibleClass marks each history index by what role it'd play in
    // a tool-run: tool_assistant (assistant turn that's pure tool_use,
    // optionally with thinking), tool_user_result (user message that
    // carries only tool_result blocks), or other. Subagent-internal
    // and otherwise-hidden messages are passed through as "skip" so
    // they don't break a streak that surrounds them.
    const klass: Array<"tool_asst" | "tool_user" | "skip" | "other"> = [];
    for (let i = 0; i < chat.history.length; i++) {
      const msg = chat.history[i];
      if (shouldHideFromMainTimeline(msg, subagentDerivation)) {
        klass.push("skip");
        continue;
      }
      klass.push(classifyForRun(msg));
    }
    let i = 0;
    while (i < chat.history.length) {
      const msg = chat.history[i];
      if (klass[i] === "skip") {
        flushCmdsUpTo(i + 1);
        i++;
        continue;
      }
      // Try to extend a tool-run starting at i. Pattern: a leading
      // tool_asst, then any alternation of tool_user / tool_asst (skip
      // entries pass through transparently). A pure-text assistant
      // turn ("Now let me check the config…") gets folded INTO the
      // streak iff another tool_asst follows within the same window —
      // that interstitial commentary is part of the same investigation
      // and forcing it to break a run leaves a forest of tiny groups
      // standing next to each other. Real user input ends the run
      // unconditionally (that's a new query).
      if (klass[i] === "tool_asst") {
        let end = i + 1;
        let toolTurns = 1;
        while (end < chat.history.length) {
          const c = klass[end];
          if (c === "skip") {
            end++;
            continue;
          }
          if (c === "tool_user" || c === "tool_asst") {
            if (c === "tool_asst") toolTurns++;
            end++;
            continue;
          }
          // c === "other". Lookahead: if this is an assistant-only-
          // text turn AND a tool_asst still follows (ignoring skip),
          // absorb it into the run. User-text "other" stops the
          // streak — the user is talking, not Claude.
          if (chat.history[end].type === "assistant") {
            let look = end + 1;
            while (
              look < chat.history.length &&
              klass[look] === "skip"
            ) {
              look++;
            }
            if (
              look < chat.history.length &&
              klass[look] === "tool_asst"
            ) {
              end++;
              continue;
            }
          }
          break;
        }
        // ≥2 tool-only assistant turns is the threshold for grouping —
        // a single tool call doesn't benefit from being wrapped in a
        // collapsible (it's already one short bubble).
        if (toolTurns >= 2) {
          const slice: SDKMessage[] = [];
          for (let j = i; j < end; j++) {
            if (klass[j] === "skip") continue;
            slice.push(chat.history[j]);
          }
          const firstUuid = (slice[0] as { uuid?: string }).uuid;
          out.push({
            kind: "tool_run",
            runId: firstUuid ?? `run:${i}`,
            messages: slice,
          });
          flushCmdsUpTo(end);
          i = end;
          continue;
        }
      }
      out.push({ kind: "message", msg });
      flushCmdsUpTo(i + 1);
      i++;
    }
    flushCmdsUpTo(Number.MAX_SAFE_INTEGER);
    if (chat.streamingBlocks.length > 0) {
      out.push({ kind: "streaming", blocks: chat.streamingBlocks });
    } else if (
      chat.status === "thinking" &&
      !chat.pendingPermission &&
      !chat.pendingQuestion
    ) {
      // Server-side turn is in flight but no deltas have arrived
      // yet (or extended thinking suppressed them). Show a thinking
      // chip so the UI does not feel frozen during the multi-second
      // wait before the first token streams in.
      out.push({ kind: "thinking" });
    }
    if (chat.pendingQuestion) {
      out.push({ kind: "ask_question", request: chat.pendingQuestion });
    }
    if (chat.latestPlan) {
      out.push({ kind: "plan", plan: chat.latestPlan });
    }
    chat.errors.forEach((message, index) => {
      out.push({ kind: "error", message, index });
    });
    return out;
  }, [
    chat.history,
    chat.streamingBlocks,
    chat.pendingQuestion,
    chat.latestPlan,
    chat.errors,
    chat.status,
    chat.pendingPermission,
    commandLog,
    subagentDerivation,
  ]);

  // Mirror items.length onto a ref so the retry loop below can read
  // the LATEST count without taking items.length as a dep. If we
  // depended on it, every new message during the 700ms retry window
  // would re-run the effect → cleanup → cancel pending retries.
  const itemsLengthRef = useRef(items.length);
  useEffect(() => {
    itemsLengthRef.current = items.length;
  }, [items.length]);

  // After hydration, imperatively scroll to the latest message — but
  // RETRY across multiple delays. Why: chat items have wildly
  // variable heights (a 1-line user message vs a 400px assistant
  // turn with code + thinking + tool calls). Virtuoso's first paint
  // uses `defaultItemHeight={48}` to estimate, then re-measures as
  // it actually renders rows. A single scrollToIndex() at one fixed
  // delay lands wherever the estimate was at that instant — usually
  // mid-list, because real heights >> estimated. Retrying at 50ms /
  // 150ms / 350ms / 700ms catches each measurement stage; the last
  // call fires after Virtuoso has measured all visible rows and the
  // scroll lands at the actual bottom.
  // Per session.id ref guard so subsequent appends (user typing)
  // don't trigger this — they go through followOutput naturally.
  useEffect(() => {
    if (!chat.hydrated) return;
    if (initialScrollSessionRef.current === session.id) return;
    initialScrollSessionRef.current = session.id;
    const timers = [50, 150, 350, 700].map((delay) =>
      setTimeout(() => {
        const len = itemsLengthRef.current;
        if (len === 0) return;
        virtuosoRef.current?.scrollToIndex({
          index: len - 1,
          align: "end",
        });
      }, delay),
    );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [chat.hydrated, session.id]);

  // Derive the visible queue from history. Anything user-typed after
  // the latest `result` is unprocessed; the oldest is in flight (or
  // about to be) and the rest are strictly waiting.
  const queuedMessages = computeQueuedMessages(
    chat.history,
    chat.status === "thinking",
  );

  const closed = chat.status === "closed" || chat.status === "errored";

  const onSubmit = async ({ text, attachments }: ComposerSubmit) => {
    const parsed = parseSlashCommand(text, CHAT_COMMANDS);
    if (parsed && !parsed.command.passThrough) {
      await runChatCommand(parsed, {
        session,
        chat,
        model,
        effort,
        liveUsage,
        account: activeAccount,
        appendOutput,
        patchOptions,
        router,
        openRewind: () => setRewindOpen(true),
      });
      return;
    }
    // Pass-through commands (and regular messages) hit the SDK as-is —
    // Claude has its own slash-command awareness for things like /init,
    // /review, /commit, etc.
    const res = await fetch(`/api/chat/${session.id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: parsed?.raw ?? text,
        attachments,
        // Generate per-submit so server can dedupe accidental repeats
        // (double-Enter, browser auto-retry on a network blip).
        client_request_id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  };

  const cwdLabel = shortenCwd(session.cwd);

  return (
    <SubagentProvider
      byTaskId={subagentDerivation.byTaskId}
      childrenByTaskId={subagentDerivation.childrenByTaskId}
      resultTaskIds={subagentDerivation.resultTaskIds}
    >
      <div className="relative flex h-full min-h-0 flex-col">
        <header
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 px-2 py-2 sm:px-4"
          // top-aligned with the iOS notch when the page is loaded
          // standalone — without this the title hides behind it.
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
            <SidebarTrigger />
            <div className="flex min-w-0 items-baseline gap-2 rounded-md bg-background/70 px-2 py-1 backdrop-blur-sm">
              <span className="min-w-0 truncate text-sm font-medium">
                {session.title ?? "New chat"}
              </span>
              <span
                title={session.cwd}
                className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground sm:inline"
              >
                {cwdLabel}
                {session.account_name && <> · {session.account_name}</>}
              </span>
              <StatusBadge status={chat.status} />
            </div>
          </div>
          <div className="pointer-events-auto flex shrink-0 items-center gap-2">
            {!closed && (
              <Button variant="outline" size="sm" onClick={() => chat.stop()}>
                Stop
              </Button>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          {!chat.hydrated ? (
            // Loading state until the SSE `history_replayed` sentinel
            // fires. We MUST gate Virtuoso behind this — its
            // `initialTopMostItemIndex` is only consulted on first
            // paint, so it has to land on the FINAL items.length.
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {chat.status === "starting"
                ? "Starting Claude Code…"
                : "Loading…"}
            </div>
          ) : (
            <Virtuoso<ChatItem>
              ref={virtuosoRef}
              data={items}
              // Slight default-item-height nudge keeps the virtualizer from
              // over-budgeting offscreen rows for a typical short message.
              defaultItemHeight={48}
              increaseViewportBy={{ top: 200, bottom: 600 }}
              followOutput={(atBottom) => (atBottom ? "smooth" : false)}
              atBottomStateChange={setAtBottom}
              // Anchor on first paint to the latest message at the
              // BOTTOM of the viewport. Critical detail: passing just
              // a number defaults to `align: "start"`, which puts the
              // last item at the TOP of the viewport with empty space
              // below — not what chat UX wants. The object form
              // `{ index: "LAST", align: "end" }` is the canonical
              // pattern (per Virtuoso docs at virtuoso.dev/message-
              // list/scroll-modifier). Gated behind `chat.hydrated`
              // (set when SSE emits `history_replayed`), so
              // items.length here is the FINAL replayed history.
              initialTopMostItemIndex={
                items.length > 0 ? { index: "LAST", align: "end" } : undefined
              }
              // alignToBottom keeps short threads (items don't fill
              // the viewport) docked at the bottom of the panel,
              // matching standard chat UX.
              alignToBottom
              computeItemKey={itemKey}
              // Top spacer matches the floating header's vertical footprint
              // so the first message clears the absolute header on initial
              // render. Header is pointer-events-none so scrolling works
              // through it once content slides up.
              components={{ Header: HeaderSpacer }}
              itemContent={(_, item) => (
                <ItemRow
                  item={item}
                  approvePlan={chat.approvePlan}
                  discussPlan={async (_planId, feedback) => {
                    // Discuss-further on PlanCard pipes the user's
                    // note straight back into the chat as a regular
                    // user message. The model is still in plan mode
                    // (read-only), so it can refine and call
                    // submit_plan again — at which point the plan
                    // pointer flips and PlanCard re-renders with the
                    // new revision.
                    await chat.send(feedback);
                  }}
                  answerQuestion={chat.answer}
                  cancelQuestion={chat.cancelQuestion}
                />
              )}
            />
          )}
          {/* Floating "jump to latest" — visible only while the user
              has scrolled up. Sits inside the virtuoso wrapper so it
              hovers above the messages without overlapping the
              composer footer (which is a sibling below). */}
          {!atBottom && items.length > 0 && (
            <button
              type="button"
              onClick={() =>
                virtuosoRef.current?.scrollToIndex({
                  index: items.length - 1,
                  align: "end",
                  behavior: "smooth",
                })
              }
              aria-label="Scroll to latest message"
              title="Scroll to latest"
              className="absolute right-4 bottom-3 z-10 flex size-9 items-center justify-center rounded-full border bg-background/95 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:text-foreground"
            >
              <ArrowDown className="size-4" />
            </button>
          )}
        </div>

        <footer
          className="px-2 py-2 sm:px-4 sm:py-3"
          // Pad past the iOS home-indicator so the composer's bottom
          // edge clears the gesture bar on standalone-launched PWAs.
          style={{
            paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))",
          }}
        >
          <div className="mx-auto max-w-3xl space-y-2">
            {queuedMessages.length > 0 && (
              <QueueIndicator
                queued={queuedMessages}
                onEdit={chat.editQueued}
                onCancel={chat.cancelQueued}
              />
            )}
            <Composer
              mode="session"
              cwd={session.cwd}
              model={model}
              onModelChange={(id) => void patchOptions({ model: id })}
              effort={effort}
              onEffortChange={(e) => void patchOptions({ effort: e })}
              activeProvider={session.provider}
              orModels={orModels}
              permMode={permissionMode}
              onPermModeChange={(m) => patchOptions({ permission_mode: m })}
              onSubmit={onSubmit}
              disabled={closed}
              usage={liveUsage}
              contextUsage={chat.contextUsage ?? session.context_usage ?? null}
              commands={CHAT_COMMANDS}
              // Per-session draft key — switching tabs unmounts this
              // ChatPanel; the user comes back to the same chat and
              // expects their unfinished text still there.
              draftKey={`cm-draft:session:${session.id}`}
              placeholder={
                closed
                  ? "Session ended — start a new one"
                  : "Describe a task or ask a question · type / for commands"
              }
            />
          </div>
        </footer>

        <PermissionDialog request={chat.pendingPermission} onDecide={chat.decide} />
        <RewindPicker
          open={rewindOpen}
          onOpenChange={setRewindOpen}
          sessionId={session.id}
          history={chat.history}
          onRewound={({ mode }) => {
            // Conversation rewinds abort the live query; the next user
            // turn will re-resume against the truncated transcript.
            // SSE re-subscribes on the next render anyway, so we don't
            // need to do anything imperative here besides letting the
            // user know what happened.
            appendOutput({
              echo: "/rewind",
              tone: "success",
              subtitle:
                mode === "conversation"
                  ? "Conversation restored"
                  : mode === "code"
                    ? "Code restored"
                    : "Conversation + code restored",
              body:
                mode === "conversation"
                  ? "Chat history truncated to the chosen point. Send a new message to continue."
                  : mode === "code"
                    ? "Working tree rolled back to the pre-edit state for the chosen restore point."
                    : "Both surfaces restored. Send a new message to continue.",
            });
          }}
        />
      </div>
    </SubagentProvider>
  );
}

function HeaderSpacer() {
  // Matches the floating header's height (py-2 + content + chip padding ≈ 44px).
  return <div className="h-12" />;
}

// "Card" items render their own bordered surface — tool runs, plans,
// ask-question, todo lists, subagent dispatches. Adjacent cards need
// breathing room or the borders bleed into one wall. Tight rows (plain
// text bubbles, streaming chips, command-output notices) stay close so
// long conversational stretches don't turn into a sparse ladder.
function isCardItem(item: ChatItem): boolean {
  if (item.kind === "tool_run") return true;
  if (item.kind === "plan") return true;
  if (item.kind === "ask_question") return true;
  if (item.kind === "message" && item.msg.type === "assistant") {
    const content = item.msg.message.content;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      // TodoWrite renders as TodoListBlock (boxed checklist), Task /
      // Agent dispatches render as SubagentCard. Both are visual cards.
      if (block.name === "TodoWrite") return true;
      if (isSubagentDispatchTool(block.name)) return true;
    }
  }
  return false;
}

function ItemRow({
  item,
  approvePlan,
  discussPlan,
  answerQuestion,
  cancelQuestion,
}: {
  item: ChatItem;
  approvePlan: (
    planId: string,
    overrides?: import("@/lib/plan-types").PhaseOverrides,
  ) => Promise<void>;
  discussPlan: (planId: string, feedback: string) => Promise<void>;
  answerQuestion: (answers: AskUserQuestionAnswers) => Promise<void>;
  cancelQuestion: (message?: string) => Promise<void>;
}) {
  // Card rows get a wider gap so a TodoListBlock / ToolRunCard /
  // PlanCard doesn't sit flush against its neighbour. Tight rows
  // (plain assistant text, user echoes) keep the 2px padding so
  // back-to-back replies still read as one block.
  const padY = isCardItem(item) ? "py-1.5" : "py-0.5";
  return (
    <div className={`px-4 ${padY}`}>
      <div className="mx-auto max-w-3xl">
        {item.kind === "message" && <MessageBubble msg={item.msg} />}
        {item.kind === "streaming" && <StreamingTurn blocks={item.blocks} />}
        {item.kind === "tool_run" && <ToolRunCard messages={item.messages} />}
        {item.kind === "plan" && (
          <PlanCard
            plan={item.plan}
            onApprove={approvePlan}
            onDiscuss={discussPlan}
          />
        )}
        {item.kind === "ask_question" && (
          <AskQuestionCard
            request={item.request}
            onSubmit={answerQuestion}
            onCancel={() => cancelQuestion()}
          />
        )}
        {item.kind === "error" && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {item.message}
          </div>
        )}
        {item.kind === "command_output" && (
          <CommandOutputBubble output={item.output} />
        )}
        {item.kind === "thinking" && <ThinkingIndicator />}
      </div>
    </div>
  );
}

function itemKey(_: number, item: ChatItem): string {
  switch (item.kind) {
    case "message":
      // SDKMessages carry a uuid for assistant/user; system messages don't,
      // so fall back to a positional key. We prefix to avoid collisions
      // across kinds.
      return `m:${"uuid" in item.msg && item.msg.uuid ? item.msg.uuid : "anon"}`;
    case "streaming":
      // Single sticky key — Virtuoso reuses the same DOM node as deltas
      // arrive, avoiding a re-mount per chunk.
      return "streaming";
    case "tool_run":
      return `run:${item.runId}`;
    case "plan":
      return `plan:${item.plan.id}`;
    case "ask_question":
      return `ask:${item.request.id}`;
    case "error":
      return `err:${item.index}`;
    case "command_output":
      return `cmd:${item.id}`;
    case "thinking":
      return "thinking";
  }
}

// shortenCwd replaces the user's home directory with ~ and squashes long
// middles so the header stays single-line. The full path is exposed via
// the title= attribute on hover.
function shortenCwd(cwd: string): string {
  const homed = cwd
    .replace(/^\/Users\/[^/]+\//, "~/")
    .replace(/^\/home\/[^/]+\//, "~/");
  const segments = homed.split("/");
  if (segments.length <= 4) return homed;
  // ~/.../ <last two segments>
  const head = segments[0] === "~" ? "~" : segments[0] || "/";
  const tail = segments.slice(-2).join("/");
  return `${head}/…/${tail}`;
}

// latestAssistantModel returns the model id reported by the SDK on the
// most recent top-level assistant message. Used to recover the real
// served model on legacy OR sessions whose stored `session.model` is
// a Claude tier anchor rather than an OR id. Subagent assistants
// (parent_tool_use_id set) run on their own model and don't override
// the main session's display.
function latestAssistantModel(
  history: ReturnType<typeof useChatSession>["history"],
): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.type !== "assistant") continue;
    const parent = (m as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (parent) continue;
    const reported = (m as { message?: { model?: string } }).message?.model;
    if (typeof reported === "string" && reported.length > 0) return reported;
  }
  return undefined;
}

function latestUsage(
  history: ReturnType<typeof useChatSession>["history"],
): SessionUsage | undefined {
  // Read per-API-call usage from the latest top-level assistant
  // message. result.usage is a SUM over the turn's tool round-trips
  // (system prompt counted once per call), so it overstates the
  // current cached prefix on tool-heavy turns. Subagent assistants
  // (parent_tool_use_id != null) live in their own context window
  // and must not override the main session's display.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.type !== "assistant") continue;
    const parent = (m as { parent_tool_use_id?: string | null })
      .parent_tool_use_id;
    if (parent) continue;
    const u = (m as { message?: { usage?: Partial<SessionUsage> } })
      .message?.usage;
    if (!u) continue;
    return {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    };
  }
  return undefined;
}

function StatusBadge({ status }: { status: SessionSummary["status"] }) {
  const variant: React.ComponentProps<typeof Badge>["variant"] =
    status === "errored"
      ? "destructive"
      : status === "closed"
        ? "outline"
        : status === "awaiting_permission"
          ? "secondary"
          : "default";
  return <Badge variant={variant}>{status.replace("_", " ")}</Badge>;
}

// runChatCommand is the dispatcher for slash commands typed inside an
// active session. Each branch composes a CommandOutput and may also
// trigger side effects (PATCH the session, stop, navigate, clipboard).
// Unknown command names never reach here — parseSlashCommand filters
// against CHAT_COMMANDS, so the fall-through is "send as user message".
type ChatHookValue = ReturnType<typeof useChatSession>;

interface ChatCommandContext {
  session: SessionSummary;
  chat: ChatHookValue;
  model: string;
  effort: Effort;
  // Latest per-turn usage — drives the context-window meter. May be
  // undefined before any turn completes.
  liveUsage?: SessionUsage;
  // The session's account as seen by the daemon ticker. Undefined when
  // the daemon hasn't snapshot'd yet, or when the session's config_dir
  // doesn't match any known account.
  account?: AccountState;
  appendOutput: (output: CommandOutput) => void;
  patchOptions: (patch: { model?: string; effort?: Effort }) => Promise<void>;
  router: ReturnType<typeof useRouter>;
  // Opens the file-history picker overlay. Wired by the /rewind
  // handler; the picker manages its own loading + restore POST.
  openRewind: () => void;
}

const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

async function runChatCommand(
  parsed: ParsedCommand,
  ctx: ChatCommandContext,
): Promise<void> {
  switch (parsed.command.name) {
    case "help": {
      const body = CHAT_COMMANDS.filter((c) => !c.hidden)
        .map((c) => {
          const sig = `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`;
          return `\`${sig}\` — ${c.description}`;
        })
        .join("\n\n");
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Slash commands",
        body,
      });
      return;
    }

    case "clear": {
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config_dir: ctx.session.config_dir,
            account_name: ctx.session.account_name,
            cwd: ctx.session.cwd,
            model: ctx.model,
            effort: ctx.effort,
          }),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const summary = (await res.json()) as SessionSummary;
        ctx.router.push(`/chat/${summary.id}`);
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Failed to start a new chat: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "context": {
      const m = modelById(ctx.model);
      const window = m?.contextWindow ?? 200_000;
      const u = ctx.liveUsage;
      // Approximation: SDK doesn't break input down by source, so we
      // bucket what we have. cache_read = the cached prefix (system
      // prompt + tools + memory + earlier messages), input = current
      // turn's user input, cache_creation = first-write cached chunks,
      // output = previous turn's response. Free-space is the
      // remainder; autocompact buffer is reserved at 5% of the model
      // window — matches the CLI's default before user override.
      const cacheRead = u?.cache_read_input_tokens ?? 0;
      const cacheCreate = u?.cache_creation_input_tokens ?? 0;
      const newInput = u?.input_tokens ?? 0;
      const output = u?.output_tokens ?? 0;
      const total = cacheRead + cacheCreate + newInput + output;
      const autocompactBuffer = Math.round(window * 0.05);

      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Context Usage",
        context: {
          modelLabel: m
            ? `${m.label}${m.badge ? ` (${m.badge} context)` : ""}`
            : ctx.model,
          modelId: ctx.model,
          totalTokens: total,
          rawMaxTokens: window,
          autocompactBufferTokens: autocompactBuffer,
          // Order matters — this is the order cells get painted in the
          // grid (left-to-right, top-to-bottom).
          categories: [
            {
              name: "Cached prefix",
              tokens: cacheRead,
              color: "text-violet-500",
            },
            {
              name: "Cache write",
              tokens: cacheCreate,
              color: "text-pink-500",
            },
            {
              name: "Messages (this turn)",
              tokens: newInput,
              color: "text-emerald-500",
            },
            {
              name: "Last assistant reply",
              tokens: output,
              color: "text-sky-500",
            },
          ],
        },
        body: u
          ? undefined
          : "_No turn has completed yet — categories will populate after the first response._",
      });
      return;
    }

    case "usage": {
      // Mirrors the CLI's /usage view: three plan-quota bars (and a row
      // for purchased credits if the account has any). Token + context
      // breakdown lives in /context — keep this card focused on plan
      // limits so the user reads it in <1 second.
      const acc = ctx.account;
      const bars: UsageBar[] = [];
      if (acc?.five_hour) {
        bars.push({
          label: "Current session",
          value: acc.five_hour.utilization,
          meta: formatReset(acc.five_hour.resets_at),
        });
      }
      if (acc?.weekly) {
        bars.push({
          label: "Current week (all models)",
          value: acc.weekly.utilization,
          meta: formatReset(acc.weekly.resets_at),
        });
      }
      if (acc?.weekly_sonnet) {
        bars.push({
          label: "Current week (Sonnet only)",
          value: acc.weekly_sonnet.utilization,
        });
      }

      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: acc ? `${acc.name} · plan limits` : daemonOfflineHint(ctx),
        bars: bars.length > 0 ? bars : undefined,
        body:
          bars.length === 0
            ? "_Daemon hasn't reported quota for this account yet — try again in a few seconds._"
            : undefined,
      });
      return;
    }

    case "cost": {
      // SDK ships total_cost_usd on each `result` message. The field is
      // cumulative for the SDK session, so we read the last value rather
      // than summing — summing would double-count completed turns.
      let lastCost: number | null = null;
      let turns = 0;
      let lastDuration: number | null = null;
      let totalDuration = 0;
      for (const m of ctx.chat.history) {
        if (m.type !== "result") continue;
        turns++;
        const r = m as { total_cost_usd?: number; duration_ms?: number };
        if (typeof r.total_cost_usd === "number") lastCost = r.total_cost_usd;
        if (typeof r.duration_ms === "number") {
          lastDuration = r.duration_ms;
          totalDuration += r.duration_ms;
        }
      }
      const acc = ctx.account;
      const bars: UsageBar[] = [];
      if (acc?.five_hour) {
        bars.push({
          label: "Session 5h",
          value: acc.five_hour.utilization,
          meta: formatReset(acc.five_hour.resets_at),
        });
      }
      if (acc?.weekly) {
        bars.push({
          label: "Week 7d",
          value: acc.weekly.utilization,
          meta: formatReset(acc.weekly.resets_at),
        });
      }
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: turns === 0 ? "No turns completed yet" : "Session cost",
        bars: bars.length > 0 ? bars : undefined,
        rows: [
          { label: "Turns", value: String(turns) },
          {
            label: "Total cost (USD)",
            value: lastCost == null ? "—" : `$${lastCost.toFixed(4)}`,
          },
          ...(lastDuration != null
            ? [{ label: "Last turn", value: formatDuration(lastDuration) }]
            : []),
          ...(turns > 0
            ? [{ label: "Total time", value: formatDuration(totalDuration) }]
            : []),
        ],
      });
      return;
    }

    case "model": {
      const arg = parsed.args.trim();
      if (!arg) {
        const body = MODELS.map((m) => {
          const marker = m.id === ctx.model ? "●" : "○";
          const window =
            m.contextWindow >= 1_000_000
              ? "1M"
              : `${Math.round(m.contextWindow / 1000)}K`;
          return `${marker} \`${m.id}\` — ${m.label}${
            m.badge ? ` (${m.badge})` : ""
          } · ${window}`;
        }).join("\n\n");
        ctx.appendOutput({
          echo: parsed.raw,
          subtitle: "Available models",
          body,
        });
        return;
      }
      const target =
        MODELS.find((m) => m.id === arg) ??
        MODELS.find((m) => m.label.toLowerCase() === arg.toLowerCase());
      if (!target) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Unknown model: \`${arg}\`. Run \`/model\` (no args) to see options.`,
        });
        return;
      }
      try {
        await ctx.patchOptions({ model: target.id });
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "success",
          body: `Model set to **${target.label}**${
            target.badge ? ` (${target.badge})` : ""
          }.`,
        });
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "effort": {
      const arg = parsed.args.trim().toLowerCase();
      const m = modelById(ctx.model);
      const supported = m?.supportedEffortLevels ?? ALL_EFFORTS.slice(0, 3);
      if (!arg) {
        const body = ALL_EFFORTS.map((e) => {
          const allowed = supported.includes(e);
          const marker = e === ctx.effort ? "●" : allowed ? "○" : "—";
          return `${marker} \`${e}\` — ${EFFORT_LABELS[e]}${
            !allowed ? " _(not supported by current model)_" : ""
          }`;
        }).join("\n\n");
        ctx.appendOutput({
          echo: parsed.raw,
          subtitle: "Reasoning effort",
          body,
        });
        return;
      }
      const target = ALL_EFFORTS.find((e) => e === arg);
      if (!target) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Unknown effort: \`${arg}\`. Run \`/effort\` (no args) to see options.`,
        });
        return;
      }
      if (!supported.includes(target)) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `\`${target}\` isn't supported by ${
            m?.label ?? ctx.model
          }. Run \`/effort\` for the valid set.`,
        });
        return;
      }
      try {
        await ctx.patchOptions({ effort: target });
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "success",
          body: `Effort set to **${EFFORT_LABELS[target]}**.`,
        });
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Failed to switch effort: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "cwd": {
      ctx.appendOutput({
        echo: parsed.raw,
        rows: [{ label: "Working folder", value: ctx.session.cwd }],
      });
      return;
    }

    case "account": {
      const acc = ctx.account;
      const bars: UsageBar[] = [];
      if (acc?.five_hour) {
        bars.push({
          label: "Session 5h",
          value: acc.five_hour.utilization,
          meta: formatReset(acc.five_hour.resets_at),
        });
      }
      if (acc?.weekly) {
        bars.push({
          label: "Week 7d",
          value: acc.weekly.utilization,
          meta: formatReset(acc.weekly.resets_at),
        });
      }
      if (acc?.weekly_sonnet) {
        bars.push({ label: " · Sonnet", value: acc.weekly_sonnet.utilization });
      }
      if (acc?.weekly_opus) {
        bars.push({ label: " · Opus", value: acc.weekly_opus.utilization });
      }
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: acc ? "Active Claude account" : daemonOfflineHint(ctx),
        bars: bars.length > 0 ? bars : undefined,
        rows: [
          { label: "Account", value: ctx.session.account_name ?? "—" },
          ...(acc?.email ? [{ label: "Email", value: acc.email }] : []),
          { label: "Config dir", value: ctx.session.config_dir },
          ...(acc?.account_uuid
            ? [{ label: "Account UUID", value: acc.account_uuid }]
            : []),
          ...(acc?.error
            ? [{ label: "Daemon error", value: acc.error }]
            : []),
        ],
      });
      return;
    }

    case "status": {
      const acc = ctx.account;
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Session status",
        rows: [
          { label: "Status", value: ctx.chat.status.replace("_", " ") },
          { label: "Connection", value: ctx.chat.connection },
          { label: "Messages", value: String(ctx.chat.history.length) },
          { label: "Errors", value: String(ctx.chat.errors.length) },
          { label: "Account", value: ctx.session.account_name ?? "—" },
          ...(acc?.five_hour
            ? [
                {
                  label: "5h utilization",
                  value: `${(acc.five_hour.utilization * 100).toFixed(1)}%`,
                },
              ]
            : []),
          ...(acc?.weekly
            ? [
                {
                  label: "Week utilization",
                  value: `${(acc.weekly.utilization * 100).toFixed(1)}%`,
                },
              ]
            : []),
          ...(ctx.chat.latestPlan
            ? [{ label: "Latest plan", value: ctx.chat.latestPlan.id }]
            : []),
        ],
      });
      return;
    }

    case "copy": {
      const text = extractLastAssistantText(ctx.chat.history);
      if (!text) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "warning",
          body: "_No assistant message to copy yet._",
        });
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "success",
          body: `Copied **${text.length.toLocaleString()}** characters to clipboard.`,
        });
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Clipboard access denied: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "stop": {
      await ctx.chat.stop();
      ctx.appendOutput({
        echo: parsed.raw,
        tone: "success",
        body: "Session stopped.",
      });
      return;
    }

    case "exit": {
      await ctx.chat.stop();
      ctx.router.push("/");
      return;
    }

    case "sessions":
    case "resume": {
      try {
        const res = await fetch("/api/chat");
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { sessions: SessionSummary[] };
        const arg = parsed.args.trim();
        if (parsed.command.name === "resume" && arg) {
          const target = data.sessions.find(
            (s) => s.id === arg || s.id.startsWith(arg),
          );
          if (!target) {
            ctx.appendOutput({
              echo: parsed.raw,
              tone: "error",
              body: `No active session matched \`${arg}\`. Run \`/sessions\` to list.`,
            });
            return;
          }
          ctx.router.push(`/chat/${target.id}`);
          return;
        }
        if (data.sessions.length === 0) {
          ctx.appendOutput({
            echo: parsed.raw,
            body: "_No active sessions._",
          });
          return;
        }
        const body = data.sessions
          .map((s) => {
            const marker = s.id === ctx.session.id ? "●" : "○";
            const cwd = shortenCwd(s.cwd);
            const title = s.title ?? "_(no input yet)_";
            return `${marker} \`${s.id.slice(0, 8)}\` · ${cwd} — ${title}`;
          })
          .join("\n\n");
        ctx.appendOutput({
          echo: parsed.raw,
          subtitle:
            parsed.command.name === "resume"
              ? "Resume a session — pass an id"
              : "Active sessions",
          body,
        });
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "stats": {
      try {
        const res = await fetch("/api/chat");
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { sessions: SessionSummary[] };
        const totals = data.sessions.reduce(
          (acc, s) => {
            const u = s.usage;
            if (u) {
              acc.input += u.input_tokens;
              acc.output += u.output_tokens;
              acc.cacheRead += u.cache_read_input_tokens;
              acc.cacheCreate += u.cache_creation_input_tokens;
            }
            acc.messages += s.history_length;
            return acc;
          },
          { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 },
        );
        const acc = ctx.account;
        const bars: UsageBar[] = [];
        if (acc?.five_hour) {
          bars.push({
            label: "Session 5h",
            value: acc.five_hour.utilization,
            meta: formatReset(acc.five_hour.resets_at),
          });
        }
        if (acc?.weekly) {
          bars.push({
            label: "Week 7d",
            value: acc.weekly.utilization,
            meta: formatReset(acc.weekly.resets_at),
          });
        }
        if (acc?.weekly_sonnet) {
          bars.push({ label: " · Sonnet", value: acc.weekly_sonnet.utilization });
        }
        if (acc?.weekly_opus) {
          bars.push({ label: " · Opus", value: acc.weekly_opus.utilization });
        }
        ctx.appendOutput({
          echo: parsed.raw,
          subtitle: `Across ${data.sessions.length} session(s)`,
          bars: bars.length > 0 ? bars : undefined,
          rows: [
            { label: "Sessions", value: String(data.sessions.length) },
            { label: "Messages", value: totals.messages.toLocaleString() },
            { label: "Input tokens", value: totals.input.toLocaleString() },
            { label: "Output tokens", value: totals.output.toLocaleString() },
            {
              label: "Cache read",
              value: totals.cacheRead.toLocaleString(),
            },
            {
              label: "Cache create",
              value: totals.cacheCreate.toLocaleString(),
            },
          ],
        });
      } catch (err) {
        ctx.appendOutput({
          echo: parsed.raw,
          tone: "error",
          body: `Failed to compute stats: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    case "agents": {
      await renderCliInfo(ctx, parsed, "agents");
      return;
    }

    case "skills": {
      await renderCliInfo(ctx, parsed, "skills");
      return;
    }

    case "memory": {
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Auto-memory",
        rows: [
          {
            label: "Directory",
            value: `${ctx.session.config_dir}/projects/<project>/memory/`,
          },
          { label: "Index", value: "MEMORY.md" },
        ],
        body:
          "Memory files persist across conversations. Edit them by asking Claude " +
          "to update or remove specific entries.",
      });
      return;
    }

    case "hooks": {
      await renderCliInfo(ctx, parsed, "hooks");
      return;
    }

    case "mcp": {
      await renderCliInfo(ctx, parsed, "mcp");
      return;
    }

    case "config": {
      await renderCliInfo(ctx, parsed, "config");
      return;
    }

    case "permissions": {
      await renderCliInfo(ctx, parsed, "permissions");
      return;
    }

    case "fast": {
      ctx.appendOutput({
        echo: parsed.raw,
        tone: "warning",
        body:
          "`/fast` toggles the CLI's fast mode (Opus 4.6). The web orchestrator " +
          "uses the SDK directly — switch to Opus 4.6 via `/model` for the same model.",
      });
      return;
    }

    case "rewind": {
      ctx.openRewind();
      return;
    }

    case "doctor":
    case "ide":
    case "upgrade": {
      ctx.appendOutput({
        echo: parsed.raw,
        tone: "warning",
        body: `\`/${parsed.command.name}\` is a CLI-only diagnostic. Run it from \`claude\` in your terminal.`,
      });
      return;
    }

    case "login":
    case "logout": {
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Account management",
        body:
          "Open the **Accounts** dialog from the sidebar to swap, add, or " +
          "re-login an account. The web orchestrator delegates auth to the " +
          "claude-monitor daemon.",
      });
      return;
    }

    case "feedback":
    case "bug": {
      ctx.appendOutput({
        echo: parsed.raw,
        subtitle: "Feedback",
        body:
          "Report issues or feedback at [github.com/anthropics/claude-code/issues]" +
          "(https://github.com/anthropics/claude-code/issues).",
      });
      return;
    }

    default: {
      // Defensive: parseSlashCommand only returns names from the
      // registry, but TypeScript wants the switch exhaustive. If we
      // forget a handler, surface it visibly instead of silently
      // dropping the user's input.
      ctx.appendOutput({
        echo: parsed.raw,
        tone: "warning",
        body: `Command \`/${parsed.command.name}\` isn't wired up yet.`,
      });
    }
  }
}

// renderCliInfo fetches the session's view of a CLI introspection topic
// (mcp / agents / skills / hooks / config / permissions) and renders it
// as a CommandOutput. Server-side does the filesystem reads against
// the session's configDir + cwd; here we just shape the JSON into
// markdown the chat bubble can render. Errors degrade to a tone:warning
// notice — better than a blank bubble that looks like nothing happened.
async function renderCliInfo(
  ctx: ChatCommandContext,
  parsed: ParsedCommand,
  topic: "mcp" | "agents" | "skills" | "hooks" | "config" | "permissions",
): Promise<void> {
  let data: unknown;
  try {
    const res = await fetch(
      `/api/chat/${ctx.session.id}/cli-info?topic=${topic}`,
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    data = await res.json();
  } catch (err) {
    ctx.appendOutput({
      echo: parsed.raw,
      tone: "error",
      body: `Failed to load \`/${topic}\`: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  const echo = parsed.raw;
  switch (topic) {
    case "mcp": {
      const { servers } = data as {
        servers: Array<{
          name: string;
          scope: string;
          type?: string;
          target?: string;
        }>;
      };
      // Group by scope so the output reads like the CLI's MCPListPanel:
      // "Project · 2 servers", "User · 4 servers". We don't probe live
      // connection status — the CLI panel does, but that needs the SDK
      // to round-trip per server and would block the chat thread —
      // so we surface the configuration scope as the actionable hint
      // instead. Listed in the same scope order the CLI uses.
      const order = ["project", "user", "enterprise", "dynamic", "claudeai"];
      const scopes = new Map<string, typeof servers>();
      for (const s of servers) {
        const key = scopes.get(s.scope) ?? [];
        key.push(s);
        scopes.set(s.scope, key);
      }
      const sections: string[] = [];
      for (const scope of order) {
        const list = scopes.get(scope);
        if (!list || list.length === 0) continue;
        sections.push(`**${scope.toUpperCase()}** _(${list.length})_`);
        for (const s of list) {
          const type = s.type ?? "stdio";
          const target = s.target ? ` · \`${s.target}\`` : "";
          sections.push(`• **${s.name}** _${type}_${target}`);
        }
      }
      // Anything in an unrecognised scope still surfaces below — better
      // to show "scope=foo" than silently drop the server.
      for (const [scope, list] of scopes) {
        if (order.includes(scope)) continue;
        sections.push(`**${scope.toUpperCase()}** _(${list.length})_`);
        for (const s of list) {
          sections.push(
            `• **${s.name}** _${s.type ?? "stdio"}_${s.target ? ` · \`${s.target}\`` : ""}`,
          );
        }
      }
      ctx.appendOutput({
        echo,
        subtitle: `${servers.length} MCP server${servers.length === 1 ? "" : "s"} · ${scopes.size} scope${scopes.size === 1 ? "" : "s"}`,
        body:
          servers.length === 0
            ? "_No MCP servers configured for this session._\n\n" +
              "Configure servers in `settings.json` under `mcpServers`, in `<cwd>/.mcp.json` for a project-scoped server, or via `claude mcp add` from a terminal. " +
              "The orchestrator's built-in plan/notes/leader tools are wired in automatically and don't show up here."
            : sections.join("\n\n"),
      });
      return;
    }
    case "agents": {
      const { agents } = data as {
        agents: Array<{
          name: string;
          scope: string;
          description?: string;
        }>;
      };
      ctx.appendOutput({
        echo,
        subtitle: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        body:
          agents.length === 0
            ? "_No subagents found in `~/.claude/agents/` or `.claude/agents/`._"
            : agents
                .map(
                  (a) =>
                    `**${a.name}** _(${a.scope})_${a.description ? ` — ${a.description}` : ""}`,
                )
                .join("\n\n"),
      });
      return;
    }
    case "skills": {
      const { skills } = data as {
        skills: Array<{
          name: string;
          scope: string;
          description?: string;
        }>;
      };
      ctx.appendOutput({
        echo,
        subtitle: `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
        body:
          skills.length === 0
            ? "_No skills found in `~/.claude/skills/` or `.claude/skills/`._"
            : skills
                .map(
                  (s) =>
                    `**${s.name}** _(${s.scope})_${s.description ? ` — ${s.description}` : ""}`,
                )
                .join("\n\n"),
      });
      return;
    }
    case "hooks": {
      const { hooks } = data as {
        hooks: Array<{ event: string; count: number }>;
      };
      ctx.appendOutput({
        echo,
        subtitle: `${hooks.length} hook event${hooks.length === 1 ? "" : "s"}`,
        body:
          hooks.length === 0
            ? "_No hooks configured in `settings.json`._\n\n" +
              "Hooks let you run shell commands on tool events (PreToolUse, PostToolUse, Stop, etc.). " +
              "Edit `~/.claude/settings.json` under the `hooks` key."
            : hooks
                .map((h) => `**${h.event}** — ${h.count} matcher${h.count === 1 ? "" : "s"}`)
                .join("\n\n"),
      });
      return;
    }
    case "permissions": {
      const { permissions } = data as {
        permissions: {
          default_mode?: string;
          allow: string[];
          deny: string[];
          ask: string[];
          additional_directories: string[];
        };
      };
      const rows = [
        {
          label: "Default mode",
          value: permissions.default_mode ?? "default",
        },
        { label: "Allow rules", value: String(permissions.allow.length) },
        { label: "Deny rules", value: String(permissions.deny.length) },
        { label: "Ask rules", value: String(permissions.ask.length) },
        {
          label: "Extra directories",
          value: String(permissions.additional_directories.length),
        },
      ];
      const sample = (label: string, list: string[]) =>
        list.length === 0
          ? ""
          : `\n\n**${label}** (first 5)\n${list
              .slice(0, 5)
              .map((r) => `- \`${r}\``)
              .join("\n")}`;
      ctx.appendOutput({
        echo,
        subtitle: "Permission rules",
        rows,
        body:
          (sample("Allow", permissions.allow) +
            sample("Deny", permissions.deny) +
            sample("Ask", permissions.ask)).trim() ||
          "_No persistent rules — every tool call goes through the in-chat dialog._",
      });
      return;
    }
    case "config": {
      const view = data as {
        paths: {
          user_settings: string;
          user_local_settings: string;
          project_settings: string;
        };
        loaded: { global: boolean; local: boolean };
        summary: {
          mcp_server_count: number;
          hook_event_count: number;
          permission_default_mode?: string;
        };
      };
      ctx.appendOutput({
        echo,
        subtitle: "Configuration",
        rows: [
          { label: "User settings", value: view.paths.user_settings },
          {
            label: "User local",
            value: `${view.paths.user_local_settings}${view.loaded.local ? "" : " _(none)_"}`,
          },
          { label: "Project", value: view.paths.project_settings },
          {
            label: "MCP servers",
            value: String(view.summary.mcp_server_count),
          },
          {
            label: "Hook events",
            value: String(view.summary.hook_event_count),
          },
          {
            label: "Default mode",
            value: view.summary.permission_default_mode ?? "default",
          },
        ],
      });
      return;
    }
  }
}

function extractLastAssistantText(history: SDKMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.type !== "assistant") continue;
    const parts: string[] = [];
    for (const block of msg.message.content) {
      if (block.type === "text") parts.push(block.text);
    }
    const joined = parts.join("\n\n").trim();
    return joined || null;
  }
  return null;
}

// findAccount picks the daemon-known account that backs this chat
// session. Match by config_dir first since that's what the session was
// created with; fall back to name to cover sessions started before the
// daemon snapshot rehydrated.
function findAccount(
  accounts: AccountState[] | undefined,
  configDir: string,
  name: string | undefined,
): AccountState | undefined {
  if (!accounts || accounts.length === 0) return undefined;
  const byDir = accounts.find((a) => a.config_dir === configDir);
  if (byDir) return byDir;
  if (name) return accounts.find((a) => a.name === name);
  return undefined;
}

// contextWindowUsed approximates current context size from one API
// call's usage (latest assistant message). Sum of the four fields ==
// total tokens the model processed for that call, which is also the
// size of the context window slot it occupies. We do NOT use
// result.usage here because that's a per-turn SUM across tool loops
// and would overcount cache_read.
function contextWindowUsed(u: SessionUsage | undefined): number {
  if (!u) return 0;
  return (
    u.input_tokens +
    u.output_tokens +
    u.cache_read_input_tokens +
    u.cache_creation_input_tokens
  );
}

// aggregateTokens sums per-turn token deltas across the whole session
// transcript. Used as the session-cumulative footer in /usage; the
// per-turn split lives in /context.
function aggregateTokens(history: SDKMessage[]): SessionUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  for (const m of history) {
    if (m.type !== "result") continue;
    const u = (m as { usage?: Partial<SessionUsage> }).usage;
    if (!u) continue;
    input += u.input_tokens ?? 0;
    output += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheCreate += u.cache_creation_input_tokens ?? 0;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

// humanTokens formats large token counts as compact units so bar metas
// don't blow past the right column. 18420 → "18.4K", 1_000_000 → "1.0M".
function humanTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

// formatReset turns an OAuth-quota reset timestamp into a tight right-
// aligned hint. Within an hour we show minutes; same calendar day shows
// HH:MM; otherwise short month + day. The ↻ glyph matches the bar
// preview the user picked.
function formatReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) return "↻ now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `↻ ${minutes}m`;
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `↻ ${date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return `↻ ${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;
}

// formatDuration prints a millisecond duration as "12.3s" / "1m 04s" so
// /cost rows don't surface bare millisecond counts.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// daemonOfflineHint shows a consistent subtitle when the daemon hasn't
// snapshotted the session's account yet. Distinguishes "nothing to show"
// from "I just don't know the limits yet" so the user can act on it.
function daemonOfflineHint(ctx: ChatCommandContext): string {
  if (!ctx.session.account_name) return "No account bound to this session";
  return `Daemon hasn't snapshotted ${ctx.session.account_name} yet`;
}
