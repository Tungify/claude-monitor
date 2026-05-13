import { NextResponse } from "next/server";
import { stopBackgroundTask } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; taskId: string }>;
}

// Bridge for the BackgroundDock's kill button. The SDK exposes
// query.stopTask(taskId) which terminates a running background task
// directly — no need to round-trip through the model. The resulting
// task_notification (status "stopped") propagates back through the
// SDK message stream and the dock card updates via SSE.
export async function POST(_req: Request, { params }: Ctx) {
  const { id, taskId } = await params;
  const result = await stopBackgroundTask(id, taskId);
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "session_missing") {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  if (result.reason === "unsupported") {
    return NextResponse.json(
      { error: "SDK build does not expose stopTask" },
      { status: 501 },
    );
  }
  return NextResponse.json(
    { error: result.error ?? "stop failed" },
    { status: 500 },
  );
}
