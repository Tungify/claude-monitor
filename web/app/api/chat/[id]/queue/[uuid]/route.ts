import { NextResponse } from "next/server";
import {
  cancelQueuedMessage,
  editQueuedMessage,
} from "@/lib/server/sessions";
import type { Attachment, SendInputRequest } from "@/lib/chat-types";

// Edit / cancel a queued user message — i.e. one the SDK iterator
// hasn't yet pulled. Once the SDK starts processing a message, the
// only way to take it back is /api/chat/[id] DELETE (full session
// stop) or sending the SDK an interrupt; both are heavy and not what
// we want here. So this route returns 409 Conflict when the message
// has already moved past the queue.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; uuid: string }>;
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id, uuid } = await params;
  let body: Partial<SendInputRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as Attachment[])
    : undefined;
  if (!text && !attachments?.length) {
    return NextResponse.json(
      { error: "text or attachments required" },
      { status: 400 },
    );
  }
  try {
    const result = editQueuedMessage(id, uuid, text, attachments);
    if (result.edited) return NextResponse.json({ ok: true });
    if (result.reason === "session_missing") {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    // not_queued: the message has already been pulled by the SDK and
    // is either in flight or done. Surface as Conflict so the client
    // can show a "too late" toast and re-render with the latest state.
    return NextResponse.json(
      { error: "message is no longer queued (already processing)" },
      { status: 409 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id, uuid } = await params;
  try {
    const result = cancelQueuedMessage(id, uuid);
    if (result.cancelled) return NextResponse.json({ ok: true });
    if (result.reason === "session_missing") {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "message is no longer queued (already processing)" },
      { status: 409 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 422 },
    );
  }
}
