import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lightweight in-memory cache so the catalog page render isn't
// hitting OR for every keystroke. The model list rarely changes —
// 5 minutes is plenty fresh for a settings dialog. Sits in module
// scope so it survives across requests; HMR resets it which is
// fine.
interface CacheEntry {
  fetchedAt: number;
  payload: CatalogModel[];
}
let cache: CacheEntry | null = null;
const TTL_MS = 5 * 60 * 1000;

// Trimmed shape we send to the client. The raw OR response carries a
// lot of fields (per-provider routing, deprecated flags, ...) that
// the picker doesn't render — drop them so the JSON stays small.
interface CatalogModel {
  id: string;
  name: string;
  context_length: number;
  // Per-token prices in USD as strings (OR returns scientific notation
  // strings). Forwarded verbatim so the picker can format consistently.
  prompt_price?: string;
  completion_price?: string;
  // Free-text description, often empty. The picker uses it as the
  // hover tooltip / second-line summary when present.
  description?: string;
  // Best-effort vendor tag pulled from the id prefix ("openai/", "google/",
  // ...) so the UI can group / show a vendor chip.
  vendor: string;
}

// We proxy the OR /models endpoint server-side to keep the browser
// off OR's CORS surface and to amortize the fetch across users on a
// shared daemon.
export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return NextResponse.json({ models: cache.payload, cached: true });
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      // OR's catalog is public — no auth needed. Setting an explicit
      // User-Agent helps if OR rate-limits anonymous traffic later.
      headers: { "User-Agent": "claude-monitor/openrouter-catalog" },
      // Leave next.js's data cache alone; we manage TTL ourselves so
      // the cache is shared across requests in the same process.
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`upstream ${res.status}: ${await res.text()}`);
    }
    const raw = (await res.json()) as { data: RawModel[] };
    const models = raw.data
      .map((m): CatalogModel => {
        const slash = m.id.indexOf("/");
        return {
          id: m.id,
          name: m.name ?? m.id,
          context_length: m.context_length ?? 0,
          prompt_price: m.pricing?.prompt,
          completion_price: m.pricing?.completion,
          description: m.description,
          vendor: slash > 0 ? m.id.slice(0, slash) : "",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    cache = { fetchedAt: now, payload: models };
    return NextResponse.json({ models, cached: false });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

// Loose typing for the OR response; we only read the fields above and
// pass the rest through. Pinning it tighter would couple us to OR's
// schema for no benefit.
interface RawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}
