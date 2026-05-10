import { NextResponse } from "next/server";
import {
  snapshotSession,
  stopSession,
  updateSessionOptions,
} from "@/lib/server/sessions";
import type { Effort, PermissionMode, SessionProvider } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  return NextResponse.json(snap);
}

interface PatchBody {
  model?: string;
  effort?: Effort;
  permission_mode?: PermissionMode;
  // Provider switch (anthropic ↔ openrouter). Triggers a full SDK
  // Query respawn server-side because the env vars that route traffic
  // are baked into the spawned binary's process env. Passed alongside
  // a model id when the user picks an OR favorite from a session that
  // was started against Anthropic (or vice versa).
  provider?: SessionProvider;
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PatchBody;
  if (!body.model && !body.effort && !body.permission_mode && !body.provider) {
    return NextResponse.json(
      { error: "model, effort, permission_mode, or provider required" },
      { status: 400 },
    );
  }
  try {
    const summary = await updateSessionOptions(id, {
      model: body.model,
      effort: body.effort,
      permissionMode: body.permission_mode,
      provider: body.provider,
    });
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "session not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await stopSession(id);
  return NextResponse.json({ ok: true });
}
