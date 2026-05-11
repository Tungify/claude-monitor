"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, GitBranch, Mic, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  Attachment,
  ContextUsageBreakdown,
  Effort,
  SessionProvider,
  SessionUsage,
} from "@/lib/chat-types";
import { modelById } from "@/lib/models";
import {
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommand,
} from "@/lib/slash-commands";
import { fileToAttachment } from "./attachments";
import { AttachmentChip } from "./attachment-chip";
import { ContextMeter } from "./context-meter";
import { FolderPicker } from "./folder-picker";
import { ModelEffortPicker } from "./model-effort-picker";
import { ModePicker, type PermissionMode } from "./mode-picker";
import { ModeBanner } from "./mode-banner";
import { MultiPhaseToggle, hintForMultiPhase } from "./intent-picker";
import { useGitBranch } from "@/hooks/use-git-branch";
import { SlashCommandMenu } from "./slash-command-menu";

export interface ComposerSubmit {
  text: string;
  attachments: Attachment[];
}

interface CommonProps {
  effort: Effort;
  onEffortChange: (e: Effort) => void;
  model: string;
  onModelChange: (id: string) => void;
  // Optional metadata for the OR-aware model chip. Both must be
  // provided together: activeProvider tells the picker which routing
  // is in effect (so the chip recolors and lists the user's OR
  // favorites instead of the Anthropic lineup), and orModels supplies
  // those favorites as full OR ids. Home view fetches both; the chat
  // session reads them off the session summary + same /api/openrouter
  // GET.
  activeProvider?: SessionProvider;
  orModels?: string[];
  // Optional: parent provides this to expose the Codex model section
  // in the picker. The composer doesn't need to know about handoffs —
  // it just forwards picked codex ids. Pre-handoff sessions take the
  // model + open the HandoffDialog; post-handoff sessions hot-swap.
  onPickCodexModel?: (id: string) => void;
  onSubmit: (payload: ComposerSubmit) => Promise<void> | void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  helper?: string;
  // Optional usage payload used as the context-meter fallback before
  // the SDK has shipped a real breakdown.
  usage?: SessionUsage;
  // Authoritative context breakdown from the SDK. When present, it
  // drives the meter directly (matches the CLI's /context view).
  contextUsage?: ContextUsageBreakdown | null;
  // Slash-command registry. When provided, the composer pops an
  // autocomplete menu while the user is typing a leading "/name". Command
  // execution itself stays the parent's responsibility — the composer
  // just hands the raw text back through onSubmit.
  commands?: SlashCommand[];
  // Permission mode + change handler. Optional so callers that don't
  // wire it up just don't render the mode pill. Named permMode to
  // avoid colliding with the home|session discriminator on Props.
  permMode?: PermissionMode;
  // Returning a Promise lets callers await the actual server PATCH
  // before continuing — the multi-phase flow needs the mode flip to
  // land *before* the message arrives at the SDK so the leader's plan
  // research is read-only-gated. Fire-and-forget callers (ModePicker)
  // ignore the promise.
  onPermModeChange?: (m: PermissionMode) => void | Promise<void>;
  // localStorage key for draft persistence. When provided, the
  // composer hydrates `text` from storage on mount + writes back on
  // every change (debounced) + clears the entry on successful submit.
  // Switching between chats remounts ChatPanel, so each session's
  // unfinished draft survives the navigation.
  draftKey?: string;
}

interface HomeProps extends CommonProps {
  mode: "home";
  cwd: string;
  onCwdChange: (p: string) => void;
  recentCwds?: string[];
  // Opens the global OR settings dialog. Wired through to the
  // ModelEffortPicker's "Manage" link so the user can add/remove
  // favorites without leaving the home view. Provider routing for the
  // new session is derived from whichever model id the user picks —
  // there's no separate provider toggle.
  onConfigureOpenRouter: () => void;
}

interface SessionProps extends CommonProps {
  mode: "session";
  cwd: string;
}

type Props = HomeProps | SessionProps;

// Composer is the unified prompt box used on the home view (mode="home")
// and inside an open session (mode="session"). The visual frame is
// identical; only the top-row chips differ — home gets the folder + model
// pickers (those choices freeze on session creation), session shows a
// read-only label.
//
// Behavior change vs the old composer: per the user's request, Enter
// inserts a newline and Shift+Enter (or the send button) submits.
export function Composer(props: Props) {
  // Start empty so SSR and the first client render agree: reading
  // localStorage in the useState initializer would diverge from the
  // server's empty string and cascade into a hydration mismatch on
  // every downstream attribute (the Send button's `disabled` flips on
  // text length). The draft is rehydrated in an effect below, post-
  // mount, so the textarea picks it up on the next paint.
  const [text, setText] = useState<string>("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // One-shot toggle: when true, the next message is prefixed with the
  // multi-phase directive (see hintForMultiPhase) and the leader is
  // expected to call submit_plan instead of editing files. Resets to
  // false after submit so follow-up messages on the same task aren't
  // re-tagged once the multi-phase flow is already running.
  const [multiPhase, setMultiPhase] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Guard against concurrent submits: a slow onSubmit + a quick
  // double-Enter could fire props.onSubmit twice for the same text
  // before the textarea cleared. The ref short-circuits the second
  // call without depending on React state, which wouldn't have
  // updated yet on the same keystroke.
  const submittingRef = useRef(false);

  // Load the persisted draft post-mount. Runs on first render (initial
  // draftKey) so the textarea picks up the stored value as soon as
  // hydration completes, and again whenever draftKey changes (e.g. home
  // view → another route → home view, where the component stays mounted
  // across page transitions). Reading localStorage here — not in the
  // useState initializer — is what keeps SSR and client hydration in
  // sync; see the `text` state declaration above.
  useEffect(() => {
    if (!props.draftKey) return;
    const stored = readDraft(props.draftKey);
    if (stored) setText(stored);
    // Don't trigger a write back here; useEffect for persistence
    // (below) will no-op if the value matches storage already.
  }, [props.draftKey]);

  // Persist draft on every text change. We debounce so rapid typing
  // doesn't slam localStorage; 300ms is below human "I lost my work"
  // threshold but above keystroke cadence so the writes coalesce.
  useEffect(() => {
    if (!props.draftKey) return;
    const key = props.draftKey;
    const trimmed = text;
    const id = setTimeout(() => writeDraft(key, trimmed), 300);
    return () => clearTimeout(id);
  }, [props.draftKey, text]);

  // Keep the textarea height in sync with content. Capping at ~12 rows
  // matches Claude.ai's behavior — past that we scroll inside the field.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text]);

  // Recompute the autocomplete list every render. matchSlashCommands
  // returns [] when the menu shouldn't be visible (no leading slash, or
  // the user typed past the name into argument territory). Esc dismissal
  // is a separate flag so backspacing past the slash + retyping it
  // re-opens the menu.
  const menuMatches = useMemo<SlashCommand[]>(() => {
    if (!props.commands || menuDismissed) return [];
    return matchSlashCommands(text, props.commands);
  }, [props.commands, text, menuDismissed]);
  const menuOpen = menuMatches.length > 0;
  // The lowercased substring after the leading slash — what the menu is
  // filtering by. Passed through so each row can bold the matched
  // prefix. Whitespace means the user has moved into arg territory, in
  // which case the menu is hidden anyway.
  const menuQuery = useMemo(() => {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) return "";
    if (/\s/.test(trimmed)) return "";
    return trimmed.slice(1).toLowerCase();
  }, [text]);

  // Reset highlight + dismissal whenever the visible list changes shape:
  // out-of-range index becomes a no-op selection, and re-opening the menu
  // should clear a stale dismiss.
  useEffect(() => {
    if (menuIndex >= menuMatches.length) setMenuIndex(0);
  }, [menuMatches.length, menuIndex]);
  useEffect(() => {
    // Re-arming the dismissal once the user has cleared the slash entirely
    // means typing "/" again opens a fresh menu.
    if (!text.trimStart().startsWith("/")) setMenuDismissed(false);
  }, [text]);

  const canSend =
    !props.busy &&
    !props.disabled &&
    (text.trim().length > 0 || attachments.length > 0);

  // submitText accepts an optional override so the slash-menu can submit
  // the canonical "/<name>" string for the highlighted command without
  // first round-tripping through React state (which wouldn't be visible
  // synchronously on the same keystroke).
  const submitText = async (override?: string) => {
    if (props.busy || props.disabled) return;
    if (submittingRef.current) return;
    const textToSend = (override ?? text).trim();
    if (textToSend.length === 0 && attachments.length === 0) return;
    submittingRef.current = true;
    // Capture-and-clear immediately so the textarea reflects "sent"
    // even while the network call is still in flight. On error we
    // restore the text so the user can retry.
    const restoreText = text;
    const restoreAtt = attachments;
    setText("");
    setAttachments([]);
    setMenuDismissed(false);
    // Wipe the persisted draft now that we've committed the text.
    // The 300ms debounce on `text` would race with this otherwise —
    // forcing a write here keeps the storage in sync with what's
    // actually in the textarea (empty).
    if (props.draftKey) writeDraft(props.draftKey, "");
    // Splice the multi-phase directive ahead of the user's text when
    // the toggle is on. Slash commands (override path) bypass the
    // prefix entirely since they're CLI directives, not natural-
    // language tasks. Reset the toggle so the next message defaults
    // back to single-session.
    const isSlashOverride =
      override !== undefined && override.trimStart().startsWith("/");
    const hint = !isSlashOverride && multiPhase ? hintForMultiPhase() : null;
    const finalText = hint ? `${hint}\n\n${textToSend}` : textToSend;
    if (multiPhase) setMultiPhase(false);
    try {
      // Multi-phase flow: flip the session into permissionMode "plan"
      // before the message arrives so the leader's research phase is
      // read-only-gated (matches Claude Code CLI plan mode). submit_plan
      // still runs because canUseTool auto-allows it past the read-only
      // gate. Skip when already in plan mode or when no permMode plumbing
      // exists (e.g. home composer pre-session). We deliberately don't
      // restore the prior mode after approval — the leader keeps a
      // read-only stance and the user can override via ModePicker.
      if (
        hint &&
        props.permMode &&
        props.permMode !== "plan" &&
        props.onPermModeChange
      ) {
        await props.onPermModeChange("plan");
      }
      await props.onSubmit({ text: finalText, attachments: restoreAtt });
    } catch (e) {
      // Restore so the user keeps their draft on failure.
      setText(restoreText);
      setAttachments(restoreAtt);
      setErrors((prev) =>
        [e instanceof Error ? e.message : String(e), ...prev].slice(0, 3),
      );
    } finally {
      submittingRef.current = false;
    }
  };

  // pickCommand replaces the slash-prefix with the chosen command's
  // canonical name. Used for Tab (complete) and click-when-args-needed —
  // it does NOT submit. Enter on the menu submits via submitText instead,
  // matching Claude CLI: highlighted item runs immediately on Enter.
  const pickCommand = (cmd: SlashCommand) => {
    const trailing = cmd.argHint ? " " : "";
    const next = `/${cmd.name}${trailing}`;
    setText(next);
    setMenuDismissed(false);
    // Defer the focus + caret move until after React applies the state —
    // otherwise the cursor lands at position 0 because the textarea hasn't
    // re-rendered with the new value yet.
    queueMicrotask(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const end = next.length;
      ta.setSelectionRange(end, end);
    });
  };

  // chooseFromMenu fires the highlighted command. For commands with args
  // (argHint set) we just complete + leave the cursor for typing — sending
  // them with no args would silently produce a usage message and surprise
  // the user. For arg-less commands we submit immediately.
  const chooseFromMenu = (cmd: SlashCommand) => {
    if (cmd.argHint) {
      pickCommand(cmd);
      return;
    }
    void submitText(`/${cmd.name}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex(
          (i) => (i - 1 + menuMatches.length) % menuMatches.length,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const choice = menuMatches[menuIndex];
        if (choice) chooseFromMenu(choice);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const choice = menuMatches[menuIndex];
        if (choice) pickCommand(choice);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    // Enter on a recognized slash command submits, even when the menu
    // is closed (user dismissed it with Esc, or typed past the name
    // into arg territory like "/model claude-sonnet-4"). Without this,
    // plain Enter falls through to the default newline behavior and
    // the command sits in the input looking like it wasn't received.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      props.commands &&
      parseSlashCommand(text, props.commands)
    ) {
      e.preventDefault();
      void submitText();
      return;
    }
    // Enter inserts newline (default browser behavior). Shift+Enter sends.
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      void submitText();
    }
  };

  const ingest = async (files: File[]) => {
    const next: Attachment[] = [];
    const failures: string[] = [];
    for (const f of files) {
      const r = await fileToAttachment(f);
      if (r.ok) next.push(r.attachment);
      else failures.push(`${r.filename}: ${r.reason}`);
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
    if (failures.length) setErrors((prev) => [...failures, ...prev].slice(0, 3));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.files);
    if (items.length === 0) return;
    e.preventDefault();
    void ingest(items);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.files);
    if (items.length) void ingest(items);
  };

  const model = modelById(props.model);
  const contextWindow = model?.contextWindow ?? 200_000;
  const branchInfo = useGitBranch(props.cwd);

  return (
    <div
      className={cn(
        "relative rounded-2xl border bg-card shadow-sm transition-colors",
        dragOver && "border-primary bg-primary/[0.04]",
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {menuOpen && (
        <SlashCommandMenu
          commands={menuMatches}
          selectedIndex={menuIndex}
          onHover={setMenuIndex}
          onSelect={chooseFromMenu}
          query={menuQuery}
        />
      )}
      {/* Top chip row — folder + (model when home) */}
      <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
        {props.mode === "home" ? (
          <>
            <FolderPicker
              value={props.cwd}
              onChange={props.onCwdChange}
              recents={props.recentCwds}
            />
            <BranchChip info={branchInfo} />
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {shorten(props.cwd)}
            </span>
            <BranchChip info={branchInfo} />
          </>
        )}
      </div>

      {/* Attachment chip strip */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pt-2">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.type}-${i}-${"filename" in a ? a.filename : ""}`}
              attachment={a}
              onRemove={() =>
                setAttachments((prev) => prev.filter((_, idx) => idx !== i))
              }
            />
          ))}
        </div>
      )}

      {/* Permission-mode banner — mirrors the Claude Code CLI's
          "⏸ plan mode on" / "⏵⏵ accept edits on" footer line. Only
          renders when permMode != "default" so the chrome stays
          quiet otherwise. */}
      {props.permMode && <ModeBanner mode={props.permMode} />}

      {/* Textarea */}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={props.placeholder ?? "Describe a task or ask a question"}
        rows={2}
        disabled={props.disabled}
        // Native form autofill races our Tab handler when the user has
        // submitted `/rewind` before — the browser inserts its remembered
        // completion at the cursor while our handler also rewrites the
        // value, producing artifacts like "/rewindre". Disable browser
        // assistance across the board; the slash menu IS our autocomplete.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        className="block w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-0 disabled:opacity-60"
      />

      {/* Bottom toolbar. Two flex clusters: utilities (paperclip + mic)
          on the left, options (meter + pickers + send) push-right via
          `ms-auto`. flex-wrap on the outer row lets the right cluster
          drop to its own line on narrow phones rather than overflowing
          or squashing the send button off-screen. */}
      <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:size-7"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,text/*,.md,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.go,.py,.rs,.rb,.php,.java,.cs,.swift,.kt,.html,.css,.scss,.sql,.graphql,.xml,.csv,.tsv,.proto,.sh,.bash,.lua,.scala,.c,.h,.cpp,.hpp"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void ingest(files);
              e.currentTarget.value = "";
            }}
          />
          {/* Mic is disabled (coming soon) and consumes precious row
              space on phones where wrapping is already tight. Hide
              below sm so the picker chips have room to breathe. */}
          <button
            type="button"
            aria-label="Voice input (coming soon)"
            disabled
            className="hidden size-7 items-center justify-center rounded-md text-muted-foreground/50 sm:flex"
          >
            <Mic className="size-4" />
          </button>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <ContextMeter
            breakdown={props.contextUsage}
            usage={props.usage}
            contextWindow={contextWindow}
          />
          {props.permMode && props.onPermModeChange && (
            <ModePicker
              mode={props.permMode}
              onChange={props.onPermModeChange}
            />
          )}
          <MultiPhaseToggle active={multiPhase} onChange={setMultiPhase} />
          <ModelEffortPicker
            modelId={props.model}
            effort={props.effort}
            onModelChange={props.onModelChange}
            onEffortChange={props.onEffortChange}
            // Home mode leaves provider undefined → picker shows both
            // sections; the parent infers provider from the picked id
            // when it spawns the session. Session mode locks to the
            // session's provider so the user can't pick a model the
            // already-spawned binary can't reach.
            provider={
              props.mode === "session" ? props.activeProvider : undefined
            }
            orModels={props.orModels}
            onConfigureOpenRouter={
              props.mode === "home"
                ? props.onConfigureOpenRouter
                : undefined
            }
            onPickCodexModel={props.onPickCodexModel}
          />

          <Button
            size="icon"
            onClick={() => void submitText()}
            disabled={!canSend}
            aria-label="Send (Shift+Enter)"
            className="ml-1 rounded-full sm:size-7"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>

      {(props.helper || errors.length > 0) && (
        <div className="space-y-0.5 px-3 pb-2 text-[11px]">
          {props.helper && (
            <div className="text-muted-foreground">{props.helper}</div>
          )}
          {errors.map((e, i) => (
            <div key={i} className="text-destructive">
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// BranchChip renders next to the folder label so the user can tell at
// a glance which branch their working folder is on. Hides itself when
// the path isn't a git repo (BranchInfo carries branch=null), so
// non-git folders don't get a sad "—" chip.
function BranchChip({
  info,
}: {
  info: ReturnType<typeof useGitBranch>;
}) {
  if (info.loading) return null;
  if (!info.branch && !info.detached) return null;
  const text = info.branch ?? `det@${info.detached}`;
  return (
    <span
      title={info.branch ?? `Detached HEAD at ${info.detached}`}
      className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 font-mono text-[11px] text-muted-foreground"
    >
      <GitBranch className="size-3 shrink-0 opacity-70" aria-hidden />
      <span className="max-w-[160px] truncate">{text}</span>
    </span>
  );
}

function shorten(p: string): string {
  if (!p) return "";
  const m = /^\/Users\/[^/]+/.exec(p);
  const compact = m ? "~" + p.slice(m[0].length) : p;
  if (compact.length <= 40) return compact;
  const parts = compact.split("/").filter(Boolean);
  if (parts.length <= 2) return compact;
  return ".../" + parts.slice(-2).join("/");
}

// readDraft / writeDraft: tiny localStorage wrappers so the composer
// can persist the user's in-progress text across chat switches. We
// catch around access because Safari's "private mode" throws on
// localStorage and we'd rather lose drafts than lose the chat.
function readDraft(key: string | undefined): string {
  if (!key || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded / storage disabled — best-effort.
  }
}
