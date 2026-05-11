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

  // Plugin marketplace state (known_marketplaces.json, installed_plugins.json,
  // marketplace caches) is written under $CLAUDE_CONFIG_DIR/plugins/,
  // which defaults to $HOME/.claude/plugins when CLAUDE_CONFIG_DIR is
  // unset. cli-introspect reads from $HOME/.claude/plugins, so the
  // catalog the user sees in this dialog is the $HOME view.
  //
  // We deliberately do NOT scope plugin commands by the session's per-
  // account CLAUDE_CONFIG_DIR: doing so points the binary at an empty
  // per-account plugin DB (zero marketplaces), so a "skill-creator@
  // claude-plugins-official" install fails with "marketplace not found"
  // even though the catalog clearly shows that marketplace. Mirror the
  // catalog's scope so what's visible is also actionable. snap above
  // is kept for its session-existence guard.
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  const argv = buildArgv(action);
  try {
    const out = await runClaudePlugin(claude, argv, env);
    return NextResponse.json({
      ok: true,
      stdout: out.stdout,
      stderr: out.stderr,
    });
  } catch (err) {
    const e = asExecError(err);
    // The CLI marketplace cache is local — it gets stale as upstream
    // adds new plugins. On a "plugin not found in marketplace … local
    // copy may be out of date" failure, refresh that marketplace once
    // and retry transparently. Anything else (network 5xx, settings
    // permission, etc.) propagates as-is so the dialog shows the real
    // error.
    if (action.kind === "install" && isStaleMarketplaceErr(e)) {
      const marketplace = parseMarketplaceFromPluginId(action.pluginId);
      if (marketplace) {
        try {
          await runClaudePlugin(
            claude,
            ["plugin", "marketplace", "update", marketplace],
            env,
          );
          const retry = await runClaudePlugin(claude, argv, env);
          return NextResponse.json({
            ok: true,
            stdout: retry.stdout,
            stderr: retry.stderr,
            refreshedMarketplace: marketplace,
          });
        } catch (retryErr) {
          const r = asExecError(retryErr);
          return NextResponse.json(
            {
              error: r.message,
              stdout: r.stdout?.toString?.() ?? "",
              stderr: r.stderr?.toString?.() ?? "",
              exitCode: typeof r.code === "number" ? r.code : undefined,
              attemptedMarketplaceRefresh: marketplace,
            },
            { status: 500 },
          );
        }
      }
    }
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

type ExecError = NodeJS.ErrnoException & {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  code?: number | string;
};

function asExecError(err: unknown): ExecError {
  return err as ExecError;
}

async function runClaudePlugin(
  claude: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
) {
  const out = await exec(claude, argv, {
    env,
    // Generous: a fresh install can clone a marketplace repo on first
    // touch, and a marketplace refresh re-syncs the whole index;
    // 60s covers slow networks without letting the request hang
    // forever on a stalled DNS.
    timeout: 60_000,
    // Plenty for the verbose CLI output without spending memory on
    // edge cases.
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: out.stdout.toString(), stderr: out.stderr.toString() };
}

function isStaleMarketplaceErr(e: ExecError): boolean {
  const blob = `${e.message ?? ""}\n${e.stdout?.toString?.() ?? ""}\n${e.stderr?.toString?.() ?? ""}`;
  return (
    /not found in marketplace/i.test(blob) &&
    /(out of date|marketplace update)/i.test(blob)
  );
}

// Plugin IDs the catalog hands us are typically "<plugin>@<marketplace>".
// Bare "<plugin>" would mean "install whichever marketplace has it" —
// no marketplace to refresh in that case, so we return null and let the
// regular error path surface.
function parseMarketplaceFromPluginId(pluginId: string): string | null {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) return null;
  return pluginId.slice(at + 1);
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
