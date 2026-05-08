import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Next 16 dev refuses /_next/* requests originating from
  // a hostname that doesn't match its `Local:` print, breaking HMR when
  // you open the app via 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // /daemon/* is proxied via the App Router route at app/daemon/[...path]/
  // — a custom handler instead of `rewrites` because rewrites buffer SSE
  // bodies, breaking EventSource for the daemon's /api/events stream.
};

export default nextConfig;
