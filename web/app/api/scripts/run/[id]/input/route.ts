import { NextResponse } from "next/server";
import { writeInput } from "@/lib/server/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Body {
  data?: string;
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.data !== "string") {
    return NextResponse.json({ error: "data required" }, { status: 400 });
  }
  const ok = writeInput(id, body.data);
  if (!ok) {
    return NextResponse.json(
      { error: "run not found, finished, or stdin closed" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
