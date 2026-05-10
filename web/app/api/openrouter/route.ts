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
  // Full replacement for the favorites list. We always take the array
  // wholesale (rather than diff against existing) because the dialog
  // already has the canonical state — letting the server merge would
  // race with concurrent edits in another tab. Pass an empty array to
  // wipe all favorites without disconnecting.
  models?: string[];
  // The OR id to default new sessions to. Cleared if not present in
  // models (server enforces — the dialog also enforces but defense in
  // depth).
  default_model?: string;
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
  // list, leaving the key alone) doesn't wipe the api_key. The dialog
  // does this on save: only sends a non-empty api_key when the user
  // typed a new one.
  const existing = await loadOpenRouterConfig();
  const apiKey =
    body.api_key && body.api_key.length > 0
      ? body.api_key
      : (existing?.api_key ?? "");
  const models = Array.isArray(body.models) ? body.models : (existing?.models ?? []);
  // Accept default_model only when it's in the favorites list; otherwise
  // fall back to the existing default if still valid, then to the first
  // favorite. Stops the dialog from leaving a dangling pointer when the
  // user removes a model that was previously default.
  const requestedDefault = body.default_model ?? existing?.default_model;
  const defaultModel = requestedDefault && models.includes(requestedDefault)
    ? requestedDefault
    : models[0];
  const next: OpenRouterConfig = {
    api_key: apiKey,
    models,
    default_model: defaultModel,
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
