import { NextResponse } from "next/server";
import { open, stat } from "node:fs/promises";
import { getBackgroundTask } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; taskId: string }>;
}

// Tail the last MAX_BYTES of the task's output file. Default sized so
// the dock popover renders fast even for chatty dev servers; clients
// that want a full transcript can request bytes via the `tail` query
// param. We read from the end of the file (positional read) rather
// than streaming the whole thing into memory — Bash background runs
// can dump tens of MB and we only care about the tail.
const DEFAULT_TAIL = 64 * 1024;
const MAX_TAIL = 1024 * 1024;

export async function GET(req: Request, { params }: Ctx) {
  const { id, taskId } = await params;
  const task = getBackgroundTask(id, taskId);
  if (!task) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const path = task.output_file;
  if (!path) {
    // No on-disk file yet (the SDK only ships a path on subsequent
    // tool round-trips, not at task_started). Fall back to the
    // inline stdout/stderr snapshot we captured from the latest
    // tool_use_result — that's empty during the very first beats
    // but gets populated as soon as the SDK ships its first
    // TaskOutput-style result back to the model.
    const fallback = task.summary ?? "";
    return NextResponse.json({
      task_id: taskId,
      status: task.status,
      output: fallback,
      size: fallback.length,
      truncated: false,
    });
  }
  const url = new URL(req.url);
  const tailRaw = url.searchParams.get("tail");
  const tail = Math.min(
    Math.max(parseInt(tailRaw ?? "", 10) || DEFAULT_TAIL, 1024),
    MAX_TAIL,
  );
  let st;
  try {
    st = await stat(path);
  } catch {
    return NextResponse.json({
      task_id: taskId,
      status: task.status,
      output: "",
      size: 0,
      truncated: false,
    });
  }
  const size = st.size;
  const offset = Math.max(0, size - tail);
  const len = size - offset;
  if (len === 0) {
    return NextResponse.json({
      task_id: taskId,
      status: task.status,
      output: "",
      size,
      truncated: false,
    });
  }
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return NextResponse.json({
      task_id: taskId,
      status: task.status,
      output: buf.toString("utf8"),
      size,
      truncated: offset > 0,
    });
  } finally {
    await fh.close();
  }
}
