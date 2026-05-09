import { notFound } from "next/navigation";
import { snapshotSession } from "@/lib/server/sessions";
import { ChatPanel } from "@/components/chat/chat-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ChatSessionPage({ params }: Props) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) notFound();
  // key={id} forces a clean remount when the user switches sidebar
  // tabs. Without it, React reconciles by component type and the
  // previous session's reducer state (history, streamingBlocks,
  // commandLog, scroll position) leaks into the next one — the user
  // sees mixed history and a stale scroll anchor.
  return <ChatPanel key={id} session={snap.summary} />;
}
