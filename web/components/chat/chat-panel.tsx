"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { SessionSummary } from "@/lib/chat-types";
import { MessageBubble } from "./message-bubble";
import { PermissionDialog } from "./permission-dialog";
import { PlanCard } from "./plan-card";

interface Props {
  session: SessionSummary;
}

export function ChatPanel({ session }: Props) {
  const chat = useChatSession(session.id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages. Skipping when the user has scrolled up
  // would be nicer but the cost/value isn't worth it for M3.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.history.length]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setDraft("");
    try {
      await chat.send(text);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter newline. Matches the muscle memory of
    // Claude Code's terminal prompt and most chat UIs.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  const closed = chat.status === "closed" || chat.status === "errored";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Link href="/chat" className="text-sm text-muted-foreground hover:underline">
              ← Sessions
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              {session.id.slice(0, 8)}
            </span>
            <StatusBadge status={chat.status} />
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            {session.cwd}
            {session.account_name && <> · {session.account_name}</>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!closed && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => chat.stop()}
            >
              Stop
            </Button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-3">
          {chat.history.length === 0 && chat.status === "starting" && (
            <div className="text-center text-sm text-muted-foreground">
              Starting Claude Code…
            </div>
          )}
          {chat.history.map((msg, i) => (
            <MessageBubble key={msg.uuid ?? `m${i}`} msg={msg} />
          ))}
          {chat.latestPlan && (
            <PlanCard plan={chat.latestPlan} onApprove={chat.approvePlan} />
          )}
          {chat.errors.map((err, i) => (
            <div
              key={`e${i}`}
              className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {err}
            </div>
          ))}
        </div>
      </div>

      <footer className="border-t bg-background px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              closed
                ? "Session ended — start a new one"
                : "Type a message. Enter to send, Shift+Enter for newline."
            }
            disabled={closed || sending}
            rows={2}
            className="resize-none"
          />
          <Button onClick={onSend} disabled={!draft.trim() || closed || sending}>
            Send
          </Button>
        </div>
      </footer>

      <PermissionDialog request={chat.pendingPermission} onDecide={chat.decide} />
    </div>
  );
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
