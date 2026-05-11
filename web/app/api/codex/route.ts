import { NextResponse } from "next/server";

import { listAvailableCodexSlots } from "@/lib/server/sessions";

// GET /api/codex returns the authenticated codex (ChatGPT subscription)
// config dirs we discovered on disk. The handoff dialog reads this to
// render its "pick a codex account" list. Empty array means no
// auth.json files were found under ~/.codex* — the UI then prompts
// the user to run `codex login` first.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const slots = await listAvailableCodexSlots();
    return NextResponse.json({ slots });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
