import { snapshotSession, subscribe } from "@/lib/server/sessions";
import type { ChatEvent } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// Heartbeat keeps the EventSource connection alive across proxy
// idle-timeouts. 25s matches the daemon's choice.
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return new Response("session not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writeEvent = (event: ChatEvent) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ),
          );
        } catch {
          // Stream closed under us; subscriber cleanup handles the rest.
        }
      };

      // Replay history so a freshly opened or refreshed tab catches up.
      for (const msg of snap.history) {
        writeEvent({ type: "message", data: msg });
      }
      // Replay any handoff records so the chat panel can drop boundary
      // cards at the right indices on a fresh subscribe. Fired BEFORE
      // history_replayed so the reducer's handoff state is populated
      // by the time items array recomputes.
      for (const handoff of snap.summary.handoffs ?? []) {
        writeEvent({ type: "handoff", data: handoff });
      }
      // Sentinel marker: history replay is done. The client uses this
      // to know when it's safe to mount the virtualized list with the
      // correct bottom-anchor — heuristic timers (idle-window) fail
      // on bursty SSE delivery and the user lands mid-history.
      writeEvent({ type: "history_replayed", data: {} });
      writeEvent({ type: "status", data: { status: snap.summary.status } });
      // Replay the latest context-usage breakdown so a tab reload
      // doesn't show an empty meter until the next turn finishes.
      if (snap.summary.context_usage) {
        writeEvent({ type: "context_usage", data: snap.summary.context_usage });
      }
      // Replay /goal state so the header chip shows the live loop
      // (or its final outcome) right after reconnect instead of
      // waiting for the next mutation.
      if (snap.summary.goal) {
        writeEvent({ type: "goal_updated", data: snap.summary.goal });
      }
      if (snap.pending_permission) {
        writeEvent({ type: "permission_request", data: snap.pending_permission });
      }
      if (snap.pending_question) {
        writeEvent({ type: "ask_user_question", data: snap.pending_question });
      }
      if (snap.latest_plan) {
        // Replay as the matching event type so the client reducer ends up
        // in the right state (submitted vs approved vs failed) without
        // extra branching.
        const evType =
          snap.latest_plan.status === "approved"
            ? "plan_approved"
            : snap.latest_plan.status === "failed"
              ? "plan_failed"
              : "plan_submitted";
        writeEvent({ type: evType, data: snap.latest_plan });
      }

      const unsubscribe = subscribe(id, writeEvent);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // Same as writeEvent — controller may be torn down.
        }
      }, HEARTBEAT_MS);

      const onAbort = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
