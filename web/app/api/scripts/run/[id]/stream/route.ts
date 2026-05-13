import { snapshotRun, subscribeRun } from "@/lib/server/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotRun(id);
  if (!snap) return new Response("run not found", { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: string, payload: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
            ),
          );
        } catch {
          // Controller already closed.
        }
      };

      // Replay the buffered output + run metadata so a freshly opened
      // viewer doesn't start from the middle of the log.
      write("snapshot", {
        id: snap.id,
        kind: snap.kind,
        name: snap.name,
        startedAt: snap.startedAt,
        endedAt: snap.endedAt,
        exitCode: snap.exitCode,
        signal: snap.signal,
        truncated: snap.truncated,
        output: snap.output,
        running: snap.running,
      });

      // Already-finished runs only need the snapshot — close immediately.
      if (!snap.running) {
        try {
          controller.close();
        } catch {
          // already closed
        }
        return;
      }

      let unsubscribe: () => void = () => {};
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // controller torn down
        }
      }, HEARTBEAT_MS);

      const finalize = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      unsubscribe = subscribeRun(id, (ev) => {
        write(ev.type, ev.data);
        if (ev.type === "exit") finalize();
      });

      // Race guard: the run could have finished between the snapshot
      // read above and the subscribe call here. In that case `finish()`
      // already fanned its `exit` out to listeners (we weren't in the
      // set yet) and our subscriber would sit idle until the client
      // disconnects. Re-read the status; if it ended, synthesize the
      // exit event from the recorded fields and close.
      const recheck = snapshotRun(id);
      if (recheck && !recheck.running) {
        write("exit", {
          code: recheck.exitCode,
          signal: recheck.signal,
          durationMs:
            (recheck.endedAt ?? Date.now()) - recheck.startedAt,
        });
        finalize();
        return;
      }

      const onAbort = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
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
