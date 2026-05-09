import { NextResponse } from "next/server";
import { findPlanById } from "@/lib/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// GET /api/plans/<id>
// Resolves a plan by id alone — server scans ~/.claude/projects/*/plans/
// since we don't carry the encoded cwd through the URL. PhaseBoard at
// /plans/[id] uses this on initial load; live status comes from
// /api/chat (per-session) which the client polls.
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const plan = await findPlanById(id);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }
  return NextResponse.json(plan);
}
