import { NextResponse } from "next/server";

import { setSessionGoal } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  // Non-empty text → arm/replace the loop. Empty/missing + clear:true
  // → cancel any active loop and keep the historical record. The
  // route refuses an ambiguous body (neither field) so client bugs
  // surface as 400 instead of silent no-ops.
  text?: string;
  clear?: boolean;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const wantClear = body.clear === true;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!wantClear && text === "") {
    return NextResponse.json(
      { error: "either `text` or `clear: true` is required" },
      { status: 400 },
    );
  }
  try {
    const goal = setSessionGoal(id, wantClear || text === "" ? null : text);
    return NextResponse.json({ goal });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "session not found") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
