import { NextResponse } from "next/server";
import { startRun } from "@/lib/server/scripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  cwd?: string;
  kind?: "npm" | "make";
  name?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { cwd, kind, name } = body;
  if (!cwd || !cwd.startsWith("/")) {
    return NextResponse.json(
      { error: "cwd must be an absolute path" },
      { status: 400 },
    );
  }
  if (kind !== "npm" && kind !== "make") {
    return NextResponse.json(
      { error: "kind must be 'npm' or 'make'" },
      { status: 400 },
    );
  }
  if (typeof name !== "string" || !name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  // Defense in depth: the name comes from a server-provided list but
  // a malicious client could POST anything. Reject characters that
  // shell-quote args would have to escape. npm/make accept dashes,
  // dots, slashes (for nested scripts like `lint:fix`), and colons.
  if (!/^[A-Za-z0-9_./:-]+$/.test(name)) {
    return NextResponse.json({ error: "name has illegal chars" }, { status: 400 });
  }
  try {
    const result = await startRun(cwd, kind, name);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
