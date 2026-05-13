import { NextResponse } from "next/server";
import { listScripts } from "@/lib/server/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd || !cwd.startsWith("/")) {
    return NextResponse.json(
      { error: "cwd must be an absolute path" },
      { status: 400 },
    );
  }
  try {
    const result = await listScripts(cwd);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
