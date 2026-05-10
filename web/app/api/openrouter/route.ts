import { NextResponse } from "next/server";

import {
  loadOpenRouterConfig,
  saveOpenRouterConfig,
  statusFor,
  type OpenRouterConfig,
} from "@/lib/server/openrouter-config";

// Reads/writes touch the filesystem; force Node so the route doesn't
// land on the edge runtime where fs is unavailable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = await loadOpenRouterConfig();
  return NextResponse.json(statusFor(config));
}

interface PutBody {
  api_key?: string;
  // Sentinel: when true the entire OR block is wiped. Used by the
  // "Disconnect" button so a separate DELETE route isn't needed.
  clear?: boolean;
  models?: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
  };
}

export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (body.clear) {
    await saveOpenRouterConfig(undefined);
    return NextResponse.json(statusFor(undefined));
  }

  // We round-trip the existing config so a partial PUT (just the models
  // map, leaving the key alone) doesn't wipe the api_key. The dialog
  // does this on save: only sends a non-empty api_key when the user
  // typed a new one.
  const existing = await loadOpenRouterConfig();
  const next: OpenRouterConfig = {
    api_key: body.api_key && body.api_key.length > 0
      ? body.api_key
      : existing?.api_key ?? "",
    models: {
      opus: body.models?.opus ?? existing?.models.opus,
      sonnet: body.models?.sonnet ?? existing?.models.sonnet,
      haiku: body.models?.haiku ?? existing?.models.haiku,
    },
  };

  if (!next.api_key) {
    return NextResponse.json(
      { error: "api_key required (or pass clear:true to remove)" },
      { status: 400 },
    );
  }

  await saveOpenRouterConfig(next);
  return NextResponse.json(statusFor(next));
}
