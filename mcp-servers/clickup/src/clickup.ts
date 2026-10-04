const V2_BASE = "https://api.clickup.com/api/v2";
const V3_BASE = "https://api.clickup.com/api/v3";

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];
export type Query = Record<string, QueryValue>;
type Raw = Record<string, any>;

export class ClickUpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`ClickUp API ${status} on ${url}: ${body.slice(0, 500)}`);
    this.name = "ClickUpError";
  }
}

// Array values repeat the key verbatim: v2 filter params are declared
// as "statuses[]" by the caller, while endpoints like bulk time-in-
// status want a plain repeated "task_ids".
function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface RequestOpts {
  query?: Query;
  body?: unknown;
  form?: FormData;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Native task ids are bare alphanumerics ("86c1x2y3z"); custom ids carry
// a prefix and a dash ("DEV-1234").
export const isCustomTaskId = (id: string) => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(id);

export class ClickUpClient {
  private teamsP?: Promise<Raw[]>;
  private meP?: Promise<Raw>;
  private customIds = new Map<string, string>();
  private spaceNames = new Map<string, Promise<string | undefined>>();
  private taskTypeCache = new Map<string, Promise<Raw[]>>();
  private hierarchy = new Map<string, { at: number; p: Promise<Raw[]> }>();

  constructor(
    private readonly apiKey: string,
    readonly defaultTeamId?: string,
  ) {}

  // Only for fetching private attachment URLs on ClickUp hosts.
  apiKeyHeader(): string {
    return this.apiKey;
  }

  async request<T = Raw>(method: string, url: string, opts: RequestOpts = {}): Promise<T> {
    const full = `${url}${buildQuery(opts.query)}`;
    const headers: Record<string, string> = { Authorization: this.apiKey, Accept: "application/json" };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(full, { method, headers, body });
      if (res.status === 429 && attempt < 2) {
        const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        const wait = reset ? Math.min(Math.max(reset - Date.now(), 500), 15000) : 2000;
        await sleep(wait);
        continue;
      }
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new ClickUpError(res.status, full, text);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return { text } as T;
      }
    }
  }

  v2<T = Raw>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", V2_BASE + path, { query });
  }
  v3<T = Raw>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", V3_BASE + path, { query });
  }
  send2<T = Raw>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>(method, V2_BASE + path, { body, query });
  }
  send3<T = Raw>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>(method, V3_BASE + path, { body, query });
  }
  form2<T = Raw>(path: string, form: FormData, query?: Query): Promise<T> {
    return this.request<T>("POST", V2_BASE + path, { form, query });
  }

  teams(): Promise<Raw[]> {
    this.teamsP ??= this.v2<{ teams: Raw[] }>("/team").then((r) => r.teams ?? []);
    this.teamsP.catch(() => (this.teamsP = undefined));
    return this.teamsP;
  }

  // ws resolves the workspace id: explicit arg, then CLICKUP_TEAM_ID,
  // then the only workspace the token can see.
  async ws(override?: string): Promise<string> {
    const id = override || this.defaultTeamId;
    if (id) return id;
    const teams = await this.teams();
    if (teams.length === 1) return String(teams[0].id);
    throw new Error(
      `workspace_id required: ${teams.map((t) => `${t.name}=${t.id}`).join(", ")}`,
    );
  }

  me(): Promise<Raw> {
    this.meP ??= this.v2<{ user: Raw }>("/user").then((r) => r.user);
    this.meP.catch(() => (this.meP = undefined));
    return this.meP;
  }

  async members(wsId?: string): Promise<Raw[]> {
    const id = await this.ws(wsId);
    const team = (await this.teams()).find((t) => String(t.id) === id);
    if (!team) throw new Error(`Workspace ${id} not visible to this token`);
    return (team.members ?? []).map((m: Raw) => m.user).filter(Boolean);
  }

  async userLabel(userId: unknown, wsId?: string): Promise<string | undefined> {
    if (userId === undefined || userId === null || userId === "") return undefined;
    try {
      const u = (await this.members(wsId)).find((m) => String(m.id) === String(userId));
      return u?.username || u?.email || String(userId);
    } catch {
      return String(userId);
    }
  }

  // resolveUser maps an id, email, username or "me" to a numeric id.
  async resolveUser(q: string | number, wsId?: string): Promise<number> {
    const s = String(q).trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (s.toLowerCase() === "me") return Number((await this.me()).id);
    const hits = findMembers(await this.members(wsId), s);
    if (hits.length === 1) return Number(hits[0].id);
    if (!hits.length) throw new Error(`No workspace member matches "${s}"`);
    throw new Error(
      `"${s}" is ambiguous: ${hits.slice(0, 5).map((h) => `${h.username}=${h.id}`).join(", ")}`,
    );
  }

  resolveUsers(list: (string | number)[] | undefined, wsId?: string): Promise<number[]> {
    return Promise.all((list ?? []).map((a) => this.resolveUser(a, wsId)));
  }

  // taskQuery returns the query flags a single-task endpoint needs when
  // task_id is a custom id.
  async taskQuery(taskId: string, wsId?: string): Promise<Query> {
    return isCustomTaskId(taskId) ? { custom_task_ids: true, team_id: await this.ws(wsId) } : {};
  }

  // resolveTaskId turns a custom id into the native one (cached). Used
  // by endpoints that take several task ids at once.
  async resolveTaskId(taskId: string, wsId?: string): Promise<string> {
    if (!isCustomTaskId(taskId)) return taskId;
    const hit = this.customIds.get(taskId.toUpperCase());
    if (hit) return hit;
    const t = await this.v2<Raw>(`/task/${taskId}`, await this.taskQuery(taskId, wsId));
    this.customIds.set(taskId.toUpperCase(), String(t.id));
    return String(t.id);
  }

  // spaceName fills the name ClickUp omits from task payloads. Falls
  // back to the list payload for spaces the token can't open directly
  // (guest / shared-with-me spaces 401 on /space but leak the name via
  // /list). Failures cache as undefined so callers keep the raw id.
  spaceName(spaceId: string, listIdHint?: string): Promise<string | undefined> {
    let p = this.spaceNames.get(spaceId);
    if (!p) {
      p = (async () => {
        try {
          const s = await this.v2<Raw>(`/space/${spaceId}`);
          if (s.name) return s.name as string;
        } catch {}
        if (listIdHint) {
          try {
            const l = await this.v2<Raw>(`/list/${listIdHint}`);
            if (l.space?.name) return l.space.name as string;
          } catch {}
        }
        return undefined;
      })();
      this.spaceNames.set(spaceId, p);
    }
    return p;
  }

  async taskTypes(wsId?: string): Promise<Raw[]> {
    const id = await this.ws(wsId);
    let p = this.taskTypeCache.get(id);
    if (!p) {
      p = this.v2<{ custom_items: Raw[] }>(`/team/${id}/custom_item`).then((r) => r.custom_items ?? []);
      p.catch(() => this.taskTypeCache.delete(id));
      this.taskTypeCache.set(id, p);
    }
    return p;
  }

  // tree returns spaces with their folders (each carrying its lists) and
  // folderless lists. Cached for 5 minutes per workspace; name lookups
  // (space_name / folder_name / list_name) resolve against it.
  async tree(wsId?: string, fresh = false): Promise<Raw[]> {
    const id = await this.ws(wsId);
    const hit = this.hierarchy.get(id);
    if (hit && !fresh && Date.now() - hit.at < 300_000) return hit.p;
    const p = (async () => {
      const { spaces = [] } = await this.v2<{ spaces: Raw[] }>(`/team/${id}/space`);
      return Promise.all(
        spaces.map(async (s: Raw) => {
          const [f, l] = await Promise.all([
            this.v2<{ folders: Raw[] }>(`/space/${s.id}/folder`).catch(() => ({ folders: [] })),
            this.v2<{ lists: Raw[] }>(`/space/${s.id}/list`).catch(() => ({ lists: [] })),
          ]);
          return { id: s.id, name: s.name, folders: f.folders ?? [], lists: l.lists ?? [] };
        }),
      );
    })();
    p.catch(() => this.hierarchy.delete(id));
    this.hierarchy.set(id, { at: Date.now(), p });
    return p;
  }

  invalidateTree() {
    this.hierarchy.clear();
  }

  async spaceIdByName(name: string, wsId?: string): Promise<string> {
    const spaces = await this.tree(wsId);
    return String(pickByName(spaces, name, "space").id);
  }

  async listIdByName(name: string, wsId?: string): Promise<string> {
    const lists: Raw[] = [];
    for (const s of await this.tree(wsId)) {
      for (const l of s.lists) lists.push({ ...l, where: s.name });
      for (const f of s.folders) for (const l of f.lists ?? []) lists.push({ ...l, where: `${s.name}/${f.name}` });
    }
    return String(pickByName(lists, name, "list").id);
  }
}

export function findMembers(members: Raw[], q: string): Raw[] {
  const s = q.toLowerCase();
  if (s.includes("@")) return members.filter((m) => m.email?.toLowerCase() === s);
  const exact = members.filter((m) => m.username?.toLowerCase() === s);
  if (exact.length) return exact;
  return members.filter(
    (m) => m.username?.toLowerCase().includes(s) || m.email?.toLowerCase().split("@")[0] === s,
  );
}

// pickByName prefers an exact (case-insensitive) match, then a unique
// substring match; anything else is an error listing candidates.
export function pickByName(items: Raw[], name: string, kind: string): Raw {
  const s = name.trim().toLowerCase();
  const exact = items.filter((i) => String(i.name).toLowerCase() === s);
  const hits = exact.length ? exact : items.filter((i) => String(i.name).toLowerCase().includes(s));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No ${kind} named "${name}"`);
  throw new Error(
    `${kind} "${name}" is ambiguous: ${hits
      .slice(0, 8)
      .map((h) => `${h.where ? h.where + "/" : ""}${h.name}=${h.id}`)
      .join(", ")}`,
  );
}
