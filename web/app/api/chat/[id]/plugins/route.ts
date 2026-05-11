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

type Action =
  | { kind: "install"; pluginId: string; scope?: Scope }
  | { kind: "uninstall"; pluginId: string; scope?: Scope }
  | { kind: "marketplace_add"; source: string; scope?: MarketScope }
  | { kind: "marketplace_remove"; name: string };

type Scope = "user" | "project" | "local";
type MarketScope = "user" | "project" | "local";

const SCOPE_VALUES: ReadonlySet<string> = new Set(["user", "project", "local"]);

// Shells out to `claude plugin …` using the session's CLAUDE_CONFIG_DIR.
// We delegate to the CLI rather than re-implementing install — the
// settings-write + cache materialization + dependency reconciliation is
// non-trivial (see leaked services/plugins/pluginOperations.ts), and any
// drift between our re-implementation and the binary's expectations would
// silently corrupt the user's plugin state. The CLI is the source of truth.
//
// Identifiers travel through execFile's argv array — no shell parsing
// stage means no quoting bugs / injection risk even if a pluginId is wild.
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
          "claude CLI not found on PATH — install Claude Code to manage plugins",
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

  const argv = buildArgv(action);
  try {
    const out = await exec(claude, argv, {
      env: {
        ...process.env,
        // Pin to the session's account config dir so the install lands in
        // the right ~/.claude. Without this the CLI would fall back to
        // $CLAUDE_CONFIG_DIR/$HOME — wrong account when the user is
        // running multiple sessions across accounts.
        CLAUDE_CONFIG_DIR: snap.summary.config_dir,
      },
      // Generous: a fresh install can clone a marketplace repo on first
      // touch; a 60s cap covers slow networks without letting the request
      // hang forever on a stalled DNS.
      timeout: 60_000,
      // Plenty for the verbose CLI output without spending memory on
      // edge cases.
      maxBuffer: 4 * 1024 * 1024,
    });
    return NextResponse.json({
      ok: true,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
    });
  } catch (err) {
    // execFile rejects with the child's stdout/stderr attached on the
    // error. Forward both so the dialog can show the CLI's own error
    // message instead of a generic "command failed".
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
    case "install":
    case "uninstall": {
      const pluginId =
        typeof b.pluginId === "string" ? b.pluginId.trim() : "";
      if (!pluginId) return { error: "pluginId is required" };
      const scope = parseScope(b.scope);
      if (scope === "invalid") return { error: "scope must be user/project/local" };
      return { kind: b.kind, pluginId, scope };
    }
    case "marketplace_add": {
      const source = typeof b.source === "string" ? b.source.trim() : "";
      if (!source) return { error: "source is required" };
      const scope = parseScope(b.scope);
      if (scope === "invalid") return { error: "scope must be user/project/local" };
      return { kind: "marketplace_add", source, scope };
    }
    case "marketplace_remove": {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) return { error: "name is required" };
      return { kind: "marketplace_remove", name };
    }
    default:
      return {
        error:
          "kind must be one of: install, uninstall, marketplace_add, marketplace_remove",
      };
  }
}

// parseScope returns undefined when the caller omitted the field (caller
// gets the CLI default), the literal scope string when valid, or the
// sentinel "invalid" when it's a non-empty bad value.
function parseScope(raw: unknown): Scope | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return "invalid";
  return SCOPE_VALUES.has(raw) ? (raw as Scope) : "invalid";
}

function buildArgv(action: Action): string[] {
  switch (action.kind) {
    case "install": {
      const argv = ["plugin", "install", action.pluginId];
      if (action.scope) argv.push("--scope", action.scope);
      return argv;
    }
    case "uninstall": {
      // -y skips the prune confirmation prompt; we always pass it since
      // we never have a TTY to type at. --keep-data preserves user-
      // generated plugin state — uninstall is reversible from the user's
      // mental model (reinstall and your data's still there).
      const argv = [
        "plugin",
        "uninstall",
        action.pluginId,
        "-y",
        "--keep-data",
      ];
      if (action.scope) argv.push("--scope", action.scope);
      return argv;
    }
    case "marketplace_add": {
      const argv = ["plugin", "marketplace", "add", action.source];
      if (action.scope) argv.push("--scope", action.scope);
      return argv;
    }
    case "marketplace_remove":
      return ["plugin", "marketplace", "remove", action.name];
  }
}
