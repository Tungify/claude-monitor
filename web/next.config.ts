import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Next 16 dev refuses /_next/* requests originating from
  // a hostname that doesn't match its `Local:` print, breaking HMR when
  // you open the app via 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // /daemon/* is proxied via the App Router route at app/daemon/[...path]/
  // — a custom handler instead of `rewrites` because rewrites buffer SSE
  // bodies, breaking EventSource for the daemon's /api/events stream.
  //
  // Standalone output produces `.next/standalone/server.js` with only
  // the runtime deps copied in (no full node_modules). Lets the release
  // bundle ship as one ~50MB tarball instead of dragging the full
  // ~940MB pnpm store. The Go launcher (`internal/web/launcher.go`)
  // detects server.js and spawns `node server.js`; falls back to
  // `next start` for the legacy dev layout.
  output: "standalone",
};

export default nextConfig;
