"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useDaemonContext } from "@/lib/daemon-context";
import { Composer, type ComposerSubmit } from "@/components/composer/composer";
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

  const helper = active
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
          onModelChange={setModel}
          effort={effort}
          onEffortChange={setEffort}
          onConfigureOpenRouter={() => setOrDialogOpen(true)}
          orModels={orModels}
          permMode={mode}
          onPermModeChange={setMode}
          onSubmit={onSubmit}
          busy={busy}
          disabled={!active}
          commands={HOME_COMMANDS}
          // Persist the home draft too — bouncing between Home and a
          // chat is common, and losing the partial prompt on every
          // round-trip is annoying.
          draftKey="cm-draft:home"
          placeholder={
            active
              ? "Describe a task or ask a question · type / for commands"
              : "Waiting for an active account…"
          }
          helper={helper}
        />

        <OpenRouterDialog
          open={orDialogOpen}
          onOpenChange={setOrDialogOpen}
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
