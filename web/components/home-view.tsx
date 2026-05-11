"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import { Composer, type ComposerSubmit } from "@/components/composer/composer";
import { HandoffDialog } from "@/components/chat/handoff-dialog";
import { OpenRouterDialog } from "@/components/openrouter-dialog";
import { SidebarTrigger } from "@/components/sidebar/sidebar-trigger";
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID } from "@/lib/models";
import {
  CHAT_COMMANDS,
  HOME_COMMANDS,
  parseSlashCommand,
} from "@/lib/slash-commands";
import type {
  Effort,
  PermissionMode,
  SessionSummary,
} from "@/lib/chat-types";

// HomeView is the empty-state landing of the workspace: a serif hero +
// the composer. Submitting creates a session against the active account
// (with the picked cwd / model / effort), pipes the first message through,
// and pushes the user into /chat/[id].
export function HomeView() {
  const { snapshot, status: daemonStatus } = useDaemonContext();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const [cwd, setCwd] = useState<string>("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [orModels, setOrModels] = useState<string[]>([]);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [orDialogOpen, setOrDialogOpen] = useState(false);
  // Direct-codex flow: picking a GPT model from the home picker either
  // (a) silently locks onto the lone authenticated codex account, or
  // (b) opens HandoffDialog in mode="start" when there's a choice to
  // make. The slot+model lands in `codexSelection`; the chip then
  // shows the codex selection and the next submit spawns a codex-
  // routed session.
  const [codexStartOpen, setCodexStartOpen] = useState(false);
  const [codexPreselectModel, setCodexPreselectModel] = useState<
    string | undefined
  >(undefined);
  const [codexSelection, setCodexSelection] = useState<
    | {
        codex_config_dir: string;
        codex_account_name?: string;
        codex_model: string;
      }
    | undefined
  >(undefined);
  // Pre-fetched codex slot catalog. We pull it on home mount so the
  // model picker can short-circuit the "Start with Codex" dialog when
  // there's only one authenticated codex account (the most common
  // case — power users with multiple slots still get the picker).
  interface CodexSlot {
    config_dir: string;
    name: string;
    models?: Array<{ slug: string }>;
  }
  const [codexSlots, setCodexSlots] = useState<CodexSlot[] | null>(null);

  // Always fetch the OR favorites — the unified model picker shows
  // them inline alongside native Anthropic models, so the list has
  // to be present whether or not the user has decided to route
  // through OR. Re-fetched whenever the OR settings dialog closes
  // (it's the only writer) so a fresh "Add model" appears in the
  // picker without a page reload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/openrouter");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          configured: boolean;
          has_key: boolean;
          models: string[];
          default_model?: string;
        };
        if (!cancelled) setOrModels(data.models);
      } catch {
        // Silent — picker just shows native models if we can't load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orDialogOpen]);

  // Prefetch authenticated codex slots so the picker can decide
  // whether to open the "Start with Codex" dialog or auto-confirm
  // against the only slot. Cheap call (reads ~/.codex* on disk).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/codex");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { slots?: CodexSlot[] };
        if (!cancelled) setCodexSlots(data.slots ?? []);
      } catch {
        if (!cancelled) setCodexSlots([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate the default cwd + recent list from existing sessions on mount.
  // Keeps the picker useful without forcing the user to type a path each
  // time they start a new chat.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/chat");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { sessions: SessionSummary[] };
        const seen = new Set<string>();
        const recents: string[] = [];
        for (const s of data.sessions) {
          if (!seen.has(s.cwd)) {
            seen.add(s.cwd);
            recents.push(s.cwd);
          }
          if (recents.length >= 8) break;
        }
        if (!cancelled) {
          setRecentCwds(recents);
          if (!cwd && recents[0]) setCwd(recents[0]);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
    // cwd is only set initially; subsequent user changes shouldn't re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = snapshot?.accounts.find((a) => a.active);

  const onSubmit = async ({ text, attachments }: ComposerSubmit) => {
    // Handle slash commands locally before spinning up a session — the
    // home composer has no chat to forward them to.
    const parsed = parseSlashCommand(text, HOME_COMMANDS);
    if (parsed) {
      if (parsed.command.name === "help") setHelpOpen(true);
      // /clear is a no-op here: Composer wipes the textarea once
      // onSubmit resolves successfully, which is the desired effect.
      return;
    }

    // Codex direct-start: no claude account needed. The codex slot was
    // already validated when the user confirmed the dialog earlier in
    // the session; we just POST with provider="codex" and the codex
    // credentials. If we somehow ended up here without a slot (race
    // between picker click and submit, or codexSelection cleared by a
    // back-and-forth model switch), resolve in this priority:
    //   - one authenticated slot → use it silently
    //   - otherwise → open the dialog so the user picks
    const wantsCodex = /^gpt-/i.test(model);
    if (wantsCodex) {
      let selection = codexSelection;
      if (!selection || selection.codex_model !== model) {
        if (codexSlots && codexSlots.length === 1) {
          const only = codexSlots[0];
          selection = {
            codex_config_dir: only.config_dir,
            codex_account_name: only.name,
            codex_model: model,
          };
          setCodexSelection(selection);
        } else {
          setCodexPreselectModel(model);
          setCodexStartOpen(true);
          return;
        }
      }
      setBusy(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config_dir: selection.codex_config_dir,
            account_name: selection.codex_account_name,
            cwd: cwd || undefined,
            codex_model: selection.codex_model,
            effort,
            provider: "codex",
          }),
        });
        if (!res.ok) {
          throw new Error(`${res.status}: ${await res.text()}`);
        }
        const summary = (await res.json()) as SessionSummary;
        const sendRes = await fetch(`/api/chat/${summary.id}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            attachments,
            client_request_id:
              globalThis.crypto?.randomUUID?.() ??
              `${Date.now()}-${Math.random()}`,
          }),
        });
        if (!sendRes.ok) {
          throw new Error(`send: ${sendRes.status}: ${await sendRes.text()}`);
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("cm:session-subagents", {
              detail: { sessionId: summary.id },
            }),
          );
        }
        router.push(`/chat/${summary.id}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!active) throw new Error("no active account");
    setBusy(true);
    // Provider is derived from the picked model id: any id in the OR
    // favorites list (or anything with a vendor "/" prefix) routes
    // through OpenRouter; everything else is native Anthropic. There's
    // no separate provider toggle — the unified picker is the only
    // affordance.
    const provider =
      orModels.includes(model) || model.includes("/")
        ? "openrouter"
        : "anthropic";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config_dir: active.config_dir,
          account_name: active.name,
          cwd: cwd || undefined,
          model,
          effort,
          provider,
          permission_mode: mode,
        }),
      });
      if (!res.ok) {
        throw new Error(`${res.status}: ${await res.text()}`);
      }
      const summary = (await res.json()) as SessionSummary;
      // Send the first turn before navigating so the chat panel mounts
      // with the response already streaming via SSE.
      const sendRes = await fetch(`/api/chat/${summary.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          attachments,
          client_request_id:
            globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        }),
      });
      if (!sendRes.ok) {
        throw new Error(`send: ${sendRes.status}: ${await sendRes.text()}`);
      }
      // Nudge the sidebar's session list to refetch so the new chat's
      // row appears (and is already in "Working…" state) before the
      // user lands on it. Without this the row pops in on the 5s
      // poll-interval boundary which feels broken on a snappy create-
      // and-go flow.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("cm:session-subagents", {
            detail: { sessionId: summary.id },
          }),
        );
      }
      router.push(`/chat/${summary.id}`);
    } finally {
      setBusy(false);
    }
  };

  // Codex direct-start bypasses the claude account requirement. When the
  // picker is currently pointing at a GPT model and a slot has been
  // confirmed, the helper text reflects the codex routing instead of
  // the active claude account.
  const usingCodex = /^gpt-/i.test(model) && codexSelection !== undefined;
  const helper = usingCodex
    ? `Talking to Codex via ${codexSelection?.codex_account_name ?? "default"} · ${codexSelection?.codex_model} · Shift+Enter to send`
    : active
      ? `Talking through ${active.name} · Shift+Enter to send · drop or paste files into the composer`
      : daemonStatus === "open"
        ? "No active account — open the accounts panel to swap."
        : daemonStatus === "connecting"
          ? "Connecting to daemon…"
          : "Daemon offline. Run `claude-monitor --serve 127.0.0.1:8788`.";

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-4 sm:px-6">
      {/* Mobile hamburger — absolute so it doesn't push the centered
          hero down. Hidden on md+ where the rail is permanent. */}
      <div
        className="absolute top-2 left-2 z-10 md:hidden"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <SidebarTrigger />
      </div>
      <div className="w-full max-w-3xl">
        <div className="mb-6 text-center sm:mb-8">
          <h1 className="font-display text-3xl font-normal tracking-tight sm:text-5xl">
            What can Claude help you build?
          </h1>
          <p className="mt-2 text-xs text-muted-foreground sm:mt-3 sm:text-sm">
            Pick a working folder and a model, then describe the task.
          </p>
        </div>

        <Composer
          mode="home"
          cwd={cwd || ""}
          onCwdChange={setCwd}
          recentCwds={recentCwds}
          model={model}
          onModelChange={(id) => {
            // Switching back to a non-GPT model invalidates the stashed
            // codex slot — clearing it avoids the next submit firing
            // against codex when the user wanted anthropic/OR.
            if (!/^gpt-/i.test(id)) {
              setCodexSelection(undefined);
            }
            setModel(id);
          }}
          effort={effort}
          onEffortChange={setEffort}
          onConfigureOpenRouter={() => setOrDialogOpen(true)}
          orModels={orModels}
          permMode={mode}
          onPermModeChange={setMode}
          onPickCodexModel={(id) => {
            // Skip the "Start with Codex" dialog when we already have
            // a stashed selection — just update the model on the
            // existing slot and surface it via the chip. The user can
            // still swap codex accounts via the accounts sidebar.
            if (codexSelection) {
              setCodexSelection({ ...codexSelection, codex_model: id });
              setModel(id);
              return;
            }
            // Lone authenticated codex slot → auto-confirm. Common case
            // for users with a single ChatGPT subscription; no reason
            // to make them click through a one-option picker.
            if (codexSlots && codexSlots.length === 1) {
              const only = codexSlots[0];
              setCodexSelection({
                codex_config_dir: only.config_dir,
                codex_account_name: only.name,
                codex_model: id,
              });
              setModel(id);
              return;
            }
            // No slots yet (still loading) or multiple slots → ask the
            // user. The dialog also handles the "no codex accounts
            // authenticated" empty state.
            setCodexPreselectModel(id);
            setCodexStartOpen(true);
          }}
          onSubmit={onSubmit}
          busy={busy}
          // Allow submit when either a claude account is active OR a
          // codex slot has been confirmed for the current model — a
          // user who's only logged into codex shouldn't see the chat
          // box disabled.
          disabled={!active && !usingCodex}
          commands={HOME_COMMANDS}
          // Persist the home draft too — bouncing between Home and a
          // chat is common, and losing the partial prompt on every
          // round-trip is annoying.
          draftKey="cm-draft:home"
          placeholder={
            active || usingCodex
              ? "Describe a task or ask a question · type / for commands"
              : "Waiting for an active account…"
          }
          helper={helper}
        />

        <OpenRouterDialog
          open={orDialogOpen}
          onOpenChange={setOrDialogOpen}
        />

        <HandoffDialog
          mode="start"
          open={codexStartOpen}
          onOpenChange={(o) => {
            setCodexStartOpen(o);
            if (!o) setCodexPreselectModel(undefined);
          }}
          initialModel={codexPreselectModel}
          onConfirmStart={async (picked) => {
            // Persist the slot+model selection so the next submit
            // bypasses re-asking. Re-syncing `model` mirrors the chip
            // back to the slug the dialog finalized on (which can
            // differ from codexPreselectModel if the user switched
            // models inside the dialog).
            setCodexSelection(picked);
            setModel(picked.codex_model);
          }}
        />

        {helpOpen && (
          <div className="mt-4 rounded-lg border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Slash commands</div>
                <div className="text-xs text-muted-foreground">
                  Available once a chat is open. Type{" "}
                  <span className="font-mono">/</span> in any chat to filter.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                aria-label="Close"
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {CHAT_COMMANDS.filter((c) => !c.hidden).map((c) => (
                <li key={c.name} className="flex items-baseline gap-2">
                  <span className="font-mono text-foreground">
                    /{c.name}
                    {c.argHint && (
                      <span className="text-muted-foreground">
                        {" "}
                        {c.argHint}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {c.description}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
