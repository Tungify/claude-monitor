import "server-only";

// Streaming proxy for the claude-monitor daemon. The browser hits
// /daemon/api/* (same-origin, avoids EventSource cross-port quirks);
// we forward to the daemon process and pipe the response body back so
// SSE chunks flush immediately. Using a Route Handler instead of
// next.config rewrites because dev-mode rewrites buffer the response,
// which breaks `event:` chunk delivery for /api/events.

const DAEMON_URL =
  process.env.DAEMON_INTERNAL_URL ?? "http://127.0.0.1:8788";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

// Hop-by-hop headers and a few that node-fetch sets itself; we don't
// want to forward them from the incoming request, or echo them back
// from the upstream response.
const STRIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);
const STRIP_RES_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "keep-alive",
]);

function buildHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  const incoming = new URL(req.url);
  const target = `${DAEMON_URL}/${path.join("/")}${incoming.search}`;

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: buildHeaders(req.headers, STRIP_REQ_HEADERS),
    redirect: "manual",
    signal: req.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Required when streaming a request body in Node's fetch.
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildHeaders(upstream.headers, STRIP_RES_HEADERS),
  });
}

export async function GET(req: Request, ctx: Ctx) {
  return proxy(req, ctx);
}
export async function POST(req: Request, ctx: Ctx) {
  return proxy(req, ctx);
}
export async function PUT(req: Request, ctx: Ctx) {
  return proxy(req, ctx);
}
export async function DELETE(req: Request, ctx: Ctx) {
  return proxy(req, ctx);
}
export async function PATCH(req: Request, ctx: Ctx) {
  return proxy(req, ctx);
}
