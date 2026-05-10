import path from "node:path";
import { NextResponse } from "next/server";
import { createSession, listSessions } from "@/lib/server/sessions";
import type { CreateSessionRequest } from "@/lib/chat-types";

// SDK spawns a `claude` child process — Node runtime required.
export const runtime = "nodejs";
// Each request must hit our handler; we manage state in module scope.
export const dynamic = "force-dynamic";

// Default cwd is the parent of the Next.js project — i.e. the
// claude-monitor repo root when `pnpm dev` runs from web/. Worktree
// support (one cwd per phase) is M4; for M3 a single hard-coded default
// keeps the surface minimal.
const DEFAULT_CWD = path.resolve(process.cwd(), "..");

export async function GET() {
  return NextResponse.json({ sessions: listSessions() });
}

export async function POST(req: Request) {
  let body: Partial<CreateSessionRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.config_dir) {
    return NextResponse.json(
      { error: "config_dir is required" },
      { status: 400 },
    );
  }
  try {
    const summary = createSession({
      cwd: body.cwd?.trim() || DEFAULT_CWD,
      configDir: body.config_dir,
      accountName: body.account_name,
      model: body.model,
      effort: body.effort,
      provider: body.provider,
      permissionMode: body.permission_mode,
      planId: body.plan_id,
      phaseSlug: body.phase_slug,
    });
    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
