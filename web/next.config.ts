import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Without this, Next 16 dev refuses /_next/* requests originating from
  // a hostname that doesn't match its `Local:` print, breaking HMR when
  // you open the app via 127.0.0.1 instead of localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],
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
  // @openai/codex-sdk spawns the codex binary via
  // createRequire(import.meta.url).resolve(`@openai/codex-${platform}-${arch}/package.json`).
  // The platform package id is built at runtime from process.platform +
  // process.arch, so Next's static tracer can't follow it — the
  // codex-darwin-arm64 / codex-linux-x64 / ... packages get dropped
  // from the standalone bundle, and findCodexPath() throws "Unable to
  // locate Codex CLI binaries" on the first turn.
  //
  // serverExternalPackages keeps the SDK as a real CommonJS require at
  // runtime instead of inlining it, so createRequire(import.meta.url)
  // points at the real .next/standalone/node_modules layout. Combined
  // with the explicit outputFileTracingIncludes entries below, the
  // binary survives the build.
  serverExternalPackages: [
    "@openai/codex-sdk",
    "@openai/codex",
    "@openai/codex-darwin-arm64",
    "@openai/codex-darwin-x64",
    "@openai/codex-linux-arm64",
    "@openai/codex-linux-x64",
    "@openai/codex-win32-arm64",
    "@openai/codex-win32-x64",
  ],
  // Vendored Claude Code skills (web/skills/*) ship with the daemon so
  // the skills-installer can mirror them into ~/.claude/skills/ on
  // first boot. Without this include the tracer drops the dir from
  // the standalone bundle and the installer silently no-ops in
  // production. Keyed off /api/** because that's the entry point the
  // launcher hits on cold start, which is when init runs.
  //
  // The @openai/codex* globs cover both the wrapper package and every
  // platform-specific binary package; the tracer keeps whatever's
  // actually installed on the build host (so a darwin-arm64 dev
  // machine ships only that binary, not the 6-platform full set).
  outputFileTracingIncludes: {
    "/api/**": [
      "./skills/**",
      "./node_modules/@openai/codex/**",
      "./node_modules/@openai/codex-sdk/**",
      "./node_modules/@openai/codex-darwin-arm64/**",
      "./node_modules/@openai/codex-darwin-x64/**",
      "./node_modules/@openai/codex-linux-arm64/**",
      "./node_modules/@openai/codex-linux-x64/**",
      "./node_modules/@openai/codex-win32-arm64/**",
      "./node_modules/@openai/codex-win32-x64/**",
    ],
  },
};

export default nextConfig;
