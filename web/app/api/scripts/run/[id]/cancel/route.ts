import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/server/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const ok = cancelRun(id);
  if (!ok) {
    return NextResponse.json(
      { error: "run not found or already finished" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
