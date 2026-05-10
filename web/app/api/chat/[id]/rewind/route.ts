import { NextResponse } from "next/server";
import {
  listFileSnapshots,
  rewindSession,
  snapshotSession,
} from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/chat/[id]/rewind — returns the file-history snapshot list
// for the picker. We don't filter or shape much: the picker joins
// each snapshot's parentMessageId against in-memory history (which
// the chat panel already has) to label rows with user-message text.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  try {
    const snapshots = await listFileSnapshots(id);
    return NextResponse.json({ snapshots });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface PostBody {
  snapshot_id?: string;
  mode?: "code" | "conversation" | "both";
}

// POST /api/chat/[id]/rewind — runs the restore. Body picks:
//   - snapshot_id: which file-history entry to roll back to
//   - mode: code | conversation | both
//
// Conversation mode aborts the live query, truncates history at the
// snapshot's parent user message, rewrites the on-disk transcript, and
// schedules a re-resume on the next user input. Code mode walks the
// file backups and writes them back over the working tree.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const snapshotId = body.snapshot_id;
  const mode = body.mode;
  if (!snapshotId || !mode) {
    return NextResponse.json(
      { error: "snapshot_id + mode required" },
      { status: 400 },
    );
  }
  try {
    const result = await rewindSession(id, { snapshotId, mode });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
