// Token-lean output helpers. Every tool response funnels through here:
// JSON is pruned (no null/empty/false noise) and minified, lists render
// as pipe tables with all-empty columns dropped, timestamps become
// local "YYYY-MM-DD HH:MM" (readable, and the same shape the tools
// accept as input).

export type Raw = Record<string, any>;

export function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = v.map(prune).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out: Raw = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (v === null || v === undefined || v === "" || v === false) return undefined;
  return v;
}

export function json(v: unknown): string {
  return JSON.stringify(prune(v) ?? {});
}

export function clip(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n…[+${s.length - n} chars; pass full:true]`;
}

function cell(v: unknown): string {
  if (v === undefined || v === null || v === false) return "";
  if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && x !== "").join(",");
  return String(v).replace(/\s*\n\s*/g, " ").replace(/\|/g, "/");
}

// table renders rows as "a | b | c" lines under a header, dropping
// columns that are empty in every row. For 100 tasks this is roughly
// half the tokens of the equivalent JSON array.
export function table(rows: Raw[], cols: string[]): string {
  const used = cols.filter((c) => rows.some((r) => cell(r[c]) !== ""));
  const lines = [used.join(" | ")];
  for (const r of rows) lines.push(used.map((c) => cell(r[c])).join(" | "));
  return lines.join("\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

// fmtDate renders a ClickUp ms timestamp in local time. Midnight is
// shown as a bare date since ClickUp uses it for "no time set".
export function fmtDate(ms: unknown): string | undefined {
  if (ms === null || ms === undefined || ms === "") return undefined;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date(n);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getHours() === 0 && d.getMinutes() === 0) return day;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

// parseDate accepts "YYYY-MM-DD", "YYYY-MM-DD HH:MM" (local time) or a
// raw ms epoch. endOfDay pushes date-only values to 23:59:59.999 so
// "_to" filters are inclusive.
export function parseDate(
  s: string | number | undefined,
  endOfDay = false,
): { ms: number; time: boolean } | undefined {
  if (s === undefined || s === "") return undefined;
  if (typeof s === "number" || /^\d{10,}$/.test(s)) return { ms: Number(s), time: true };
  const m = DATE_RE.exec(s.trim());
  if (!m) throw new Error(`Bad date "${s}" — use YYYY-MM-DD or YYYY-MM-DD HH:MM`);
  const [, y, mo, d, h, mi] = m;
  if (h !== undefined) {
    return { ms: new Date(+y, +mo - 1, +d, +h, +mi).getTime(), time: true };
  }
  const date = endOfDay
    ? new Date(+y, +mo - 1, +d, 23, 59, 59, 999)
    : new Date(+y, +mo - 1, +d);
  return { ms: date.getTime(), time: false };
}

export const ms = (s: string | undefined, endOfDay = false) => parseDate(s, endOfDay)?.ms;

// fmtDuration renders milliseconds as "2d 3h 5m" (minute precision).
export function fmtDuration(msVal: unknown): string | undefined {
  const n = Math.abs(Number(msVal));
  if (!Number.isFinite(n)) return undefined;
  return fmtMinutes(Math.round(n / 60000));
}

export function fmtMinutes(min: number): string {
  if (min < 1) return "0m";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ");
}

// parseDuration accepts "1h 30m", "90m", "2h", "1.5h" or bare minutes.
export function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 60000);
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)/g)) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === "d" ? n * 86400000 : m[2] === "h" ? n * 3600000 : n * 60000;
  }
  if (!matched) throw new Error(`Bad duration "${s}" — use e.g. "1h 30m" or "90m"`);
  return Math.round(total);
}

export const PRIORITY: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

export function priorityName(p: unknown): string | undefined {
  if (!p) return undefined;
  if (typeof p === "object") return (p as Raw).priority ?? undefined;
  return String(p);
}

export function statusName(s: unknown): string | undefined {
  if (!s) return undefined;
  return typeof s === "object" ? (s as Raw).status : String(s);
}

export function userName(u: unknown): string | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r = u as Raw;
  return r.username || r.email || (r.id !== undefined ? String(r.id) : undefined);
}

export function fmtBytes(b: unknown): string | undefined {
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}KB` : `${(n / 1048576).toFixed(1)}MB`;
}

export function taskUrl(id: string): string {
  return `https://app.clickup.com/t/${id}`;
}
