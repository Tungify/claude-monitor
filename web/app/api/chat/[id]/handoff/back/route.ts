import { NextResponse } from "next/server";

import { handoffFromCodex } from "@/lib/server/sessions";
import type { SessionProvider } from "@/lib/chat-types";

// POST /api/chat/<id>/handoff/back drives the reverse provider switch:
// the session is currently routed through codex and the user wants
// claude (anthropic or openrouter) to take over again. Body shape:
//
//   {
//     "model": "claude-opus-4-7[1m]",   // required
//     "provider": "anthropic"           // optional, defaults to anthropic
//   }
//
// On success the response carries the new HandoffRecord; the chat panel
// uses the same record (received via SSE `handoff` event) to render the
// boundary card and re-enable Claude-only affordances.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface HandoffBackBody {
  model?: string;
  provider?: SessionProvider;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as HandoffBackBody;
  if (!body.model || typeof body.model !== "string") {
    return NextResponse.json(
      { error: "model is required" },
      { status: 400 },
    );
  }
  if (
    body.provider &&
    body.provider !== "anthropic" &&
    body.provider !== "openrouter"
  ) {
    return NextResponse.json(
      { error: "provider must be anthropic or openrouter" },
      { status: 400 },
    );
  }
  try {
    const record = await handoffFromCodex(id, {
      model: body.model,
      provider: body.provider,
    });
    return NextResponse.json(record, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "session not found" ? 404 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
