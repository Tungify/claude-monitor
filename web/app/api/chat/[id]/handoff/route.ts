import { NextResponse } from "next/server";

import { handoffToCodex } from "@/lib/server/sessions";

// POST /api/chat/<id>/handoff routes a live claude (or openrouter)
// session through OpenAI Codex via a one-time mid-session handoff.
// Body shape:
//
//   {
//     "codex_config_dir": "/Users/.../.codex-work",
//     "codex_account_name": "work",      // optional, UI display only
//     "codex_model": "gpt-5.5"           // optional, defaults to gpt-5.5
//   }
//
// On success the response carries the new HandoffRecord; the chat panel
// uses the same record (received via SSE `handoff` event) to render the
// boundary card and flip composer affordances.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface HandoffBody {
  codex_config_dir?: string;
  codex_account_name?: string;
  codex_model?: string;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as HandoffBody;
  if (!body.codex_config_dir || typeof body.codex_config_dir !== "string") {
    return NextResponse.json(
      { error: "codex_config_dir is required" },
      { status: 400 },
    );
  }
  try {
    const record = await handoffToCodex(id, {
      codex_config_dir: body.codex_config_dir,
      codex_account_name: body.codex_account_name,
      codex_model: body.codex_model,
    });
    return NextResponse.json(record, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 404 only for the literal "session not found" — auth / config
    // problems surface as 422 so the UI can render a specific banner
    // without confusing them with route-level 404s.
    const status = message === "session not found" ? 404 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
