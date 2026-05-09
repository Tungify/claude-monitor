import path from "node:path";
import { type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { NextResponse } from "next/server";

// Sibling of /api/fs/validate. The composer's FolderBrowserDialog drills
// down through the local filesystem one directory at a time — the
// browser can't (the File System Access API never exposes absolute
// paths), so we expose readdir over HTTP and let the dialog render the
// listing as a tree.
//
// Lists ONLY directories. Hidden entries (dot-prefix) are returned with
// a flag so the UI can offer a "Show hidden" toggle without filtering
// them away on this side.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Entry {
  name: string;
  hidden: boolean;
}

interface OkPayload {
  ok: true;
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
}

interface ErrPayload {
  ok: false;
  error: string;
  path?: string;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path")?.trim() ?? "";
  const home = homedir();

  // Resolve the requested path: empty → home, leading "~" → expand,
  // anything else must already be absolute. We resolve afterward to
  // collapse "..", trailing slashes, etc. before stat'ing.
  let target: string;
  if (!raw) {
    target = home;
  } else if (raw === "~" || raw.startsWith("~/")) {
    target = path.join(home, raw.slice(1));
  } else if (!path.isAbsolute(raw)) {
    return NextResponse.json<ErrPayload>({
      ok: false,
      error: "path must be absolute",
    });
  } else {
    target = raw;
  }
  target = path.resolve(target);

  try {
    const s = await stat(target);
    if (!s.isDirectory()) {
      return NextResponse.json<ErrPayload>({
        ok: false,
        error: "not a directory",
        path: target,
      });
    }
  } catch (err) {
    return NextResponse.json<ErrPayload>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      path: target,
    });
  }

  // Force the string-encoded overload — without an explicit encoding,
  // TS picks the Dirent<NonSharedBuffer> variant (since one of the
  // ambient overloads matches { withFileTypes: true } only) and we end
  // up unable to call .startsWith on entry names.
  let raw_entries: Dirent<string>[];
  try {
    raw_entries = await readdir(target, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch (err) {
    // Permission errors land here (e.g. /private on macOS, /root on
    // Linux). Surface as a non-200-but-ok=false so the UI can show
    // the message instead of a generic "fetch failed".
    return NextResponse.json<ErrPayload>({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      path: target,
    });
  }

  const entries: Entry[] = [];
  for (const it of raw_entries) {
    if (it.isDirectory()) {
      entries.push({ name: it.name, hidden: it.name.startsWith(".") });
      continue;
    }
    // Symlinks: stat through to see if the target is a directory. We
    // include valid symlink-to-dir so the user can navigate into them
    // (common pattern: ~/Workspace pointing into iCloud / Sync).
    if (it.isSymbolicLink()) {
      try {
        const linked = await stat(path.join(target, it.name));
        if (linked.isDirectory()) {
          entries.push({ name: it.name, hidden: it.name.startsWith(".") });
        }
      } catch {
        // Broken symlink — silently drop. Showing it as a navigable
        // entry would just frustrate the user when click-to-drill
        // 404s.
      }
    }
  }

  // Sort: visible first, then hidden; alphabetical within each group.
  // Case-insensitive so "README" and "readme" don't sort to opposite
  // ends of the list.
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  // path.dirname of "/" is "/". Detect that and report null parent so
  // the UI can disable the "Up" button at the root.
  const parent = path.dirname(target);
  return NextResponse.json<OkPayload>({
    ok: true,
    path: target,
    parent: parent === target ? null : parent,
    home,
    entries,
  });
}
