import { NextResponse } from "next/server";
import { interruptTurn } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const result = interruptTurn(id);
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "session_missing") {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json({ error: "session not running" }, { status: 409 });
}
