import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findClaudeBinary } from "@/lib/server/claude-binary";
import { snapshotSession } from "@/lib/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

interface Ctx {
  params: Promise<{ id: string }>;
}

type Scope = "local" | "user" | "project";
const SCOPE_VALUES: ReadonlySet<string> = new Set(["local", "user", "project"]);

// "details" maps to `claude mcp get <name>` (works for stdio + remote;
// stdio servers get spawned for a health check by the CLI, which we
// accept — the CLI panel does the same thing).
//
// "remove" maps to `claude mcp remove <name> --scope <scope>`.
//
// "add_stdio" / "add_remote" map to `claude mcp add`. We don't expose
// `add-from-claude-desktop` (Mac/WSL only; reads disk state the user
// can equally well do from a terminal) or `add-json` (the equivalent
// of the structured form already).
type Action =
  | { kind: "details"; name: string }
  | { kind: "remove"; name: string; scope?: Scope }
  | {
      kind: "add_stdio";
      name: string;
      command: string;
      args: string[];
      env: Array<{ key: string; value: string }>;
      scope?: Scope;
    }
  | {
      kind: "add_remote";
      transport: "sse" | "http";
      name: string;
      url: string;
      headers: Array<{ key: string; value: string }>;
      scope?: Scope;
    };

// Shells out to `claude mcp …` against the session's CLAUDE_CONFIG_DIR
// so add/remove land in the same per-account settings the SDK uses
// when this session executes. Mirrors plugins/route.ts; the
// `claude mcp` namespace is — unlike `claude plugin` — properly scoped
// by CLAUDE_CONFIG_DIR, so we keep the override here.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const snap = snapshotSession(id);
  if (!snap) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const claude = findClaudeBinary();
  if (!claude) {
    return NextResponse.json(
      {
        error:
          "claude CLI not found on PATH — install Claude Code to manage MCP servers",
      },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const action = parseAction(body);
  if ("error" in action) {
    return NextResponse.json({ error: action.error }, { status: 400 });
  }

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: snap.summary.config_dir,
  };
  const argv = buildArgv(action);
  try {
    const out = await exec(claude, argv, {
      env,
      // `claude mcp get` and `claude mcp list` spawn stdio servers
      // for a health check — those can hang on a misconfigured
      // server. 30s cap keeps the dialog responsive without killing
      // the legitimate slow-starter case.
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return NextResponse.json({
      ok: true,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      code?: number | string;
    };
    return NextResponse.json(
      {
        error: e.message,
        stdout: e.stdout?.toString?.() ?? "",
        stderr: e.stderr?.toString?.() ?? "",
        exitCode: typeof e.code === "number" ? e.code : undefined,
      },
      { status: 500 },
    );
  }
}

function parseAction(body: unknown): Action | { error: string } {
  if (!body || typeof body !== "object")
    return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  switch (b.kind) {
    case "details": {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return { error: "name is required" };
      return { kind: "details", name };
    }
    case "remove": {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return { error: "name is required" };
      const scope = parseScope(b.scope);
      if (scope === "invalid")
        return { error: "scope must be local/user/project" };
      return { kind: "remove", name, scope };
    }
    case "add_stdio": {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return { error: "name is required" };
      const command = typeof b.command === "string" ? b.command.trim() : "";
      if (!command) return { error: "command is required" };
      const args = parseStringArray(b.args);
      if (args === null) return { error: "args must be an array of strings" };
      const env = parseKVList(b.env);
      if (env === null)
        return { error: "env must be an array of {key,value}" };
      const scope = parseScope(b.scope);
      if (scope === "invalid")
        return { error: "scope must be local/user/project" };
      return { kind: "add_stdio", name, command, args, env, scope };
    }
    case "add_remote": {
      const transport =
        b.transport === "sse" || b.transport === "http" ? b.transport : null;
      if (!transport) return { error: "transport must be sse or http" };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return { error: "name is required" };
      const url = typeof b.url === "string" ? b.url.trim() : "";
      if (!url) return { error: "url is required" };
      if (!/^https?:\/\//i.test(url))
        return { error: "url must start with http:// or https://" };
      const headers = parseKVList(b.headers);
      if (headers === null)
        return { error: "headers must be an array of {key,value}" };
      const scope = parseScope(b.scope);
      if (scope === "invalid")
        return { error: "scope must be local/user/project" };
      return { kind: "add_remote", transport, name, url, headers, scope };
    }
    default:
      return {
        error: "kind must be one of: details, remove, add_stdio, add_remote",
      };
  }
}

function parseScope(raw: unknown): Scope | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "invalid";
  return SCOPE_VALUES.has(raw) ? (raw as Scope) : "invalid";
}

function parseStringArray(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    if (v.length > 0) out.push(v);
  }
  return out;
}

function parseKVList(
  raw: unknown,
): Array<{ key: string; value: string }> | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: Array<{ key: string; value: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const o = entry as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.value !== "string") return null;
    const key = o.key.trim();
    if (!key) continue;
    out.push({ key, value: o.value });
  }
  return out;
}

function buildArgv(action: Action): string[] {
  switch (action.kind) {
    case "details":
      return ["mcp", "get", action.name];
    case "remove": {
      const argv = ["mcp", "remove", action.name];
      if (action.scope) argv.push("--scope", action.scope);
      return argv;
    }
    case "add_stdio": {
      // `claude mcp add <name> <command> [args...]` — env via -e KEY=val
      // pairs that the CLI applies to the spawned subprocess. Scope
      // defaults to local when omitted (matches CLI default).
      const argv = ["mcp", "add"];
      if (action.scope) argv.push("--scope", action.scope);
      for (const { key, value } of action.env) {
        argv.push("-e", `${key}=${value}`);
      }
      argv.push(action.name, action.command);
      if (action.args.length > 0) argv.push("--", ...action.args);
      return argv;
    }
    case "add_remote": {
      const argv = ["mcp", "add"];
      if (action.scope) argv.push("--scope", action.scope);
      argv.push("--transport", action.transport);
      for (const { key, value } of action.headers) {
        argv.push("-H", `${key}: ${value}`);
      }
      argv.push(action.name, action.url);
      return argv;
    }
  }
}
