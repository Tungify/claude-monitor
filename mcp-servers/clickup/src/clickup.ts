const V2_BASE = "https://api.clickup.com/api/v2";
const V3_BASE = "https://api.clickup.com/api/v3";

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];
export type Query = Record<string, QueryValue>;

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

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(`${key}[]`, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class ClickUpClient {
  constructor(
    private readonly apiKey: string,
    private readonly defaultTeamId?: string,
  ) {}

  teamId(override?: string): string {
    const id = override ?? this.defaultTeamId;
    if (!id) {
      throw new Error(
        "team_id is required (pass it explicitly or set CLICKUP_TEAM_ID env var).",
      );
    }
    return id;
  }

  private async request<T>(
    base: string,
    path: string,
    query?: Query,
  ): Promise<T> {
    const url = `${base}${path}${buildQuery(query)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.apiKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ClickUpError(res.status, url, body);
    }
    return (await res.json()) as T;
  }

  v2<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>(V2_BASE, path, query);
  }

  v3<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>(V3_BASE, path, query);
  }
}

// SpaceCache resolves space_id → name with two fallback paths:
//
//  1. Direct `GET /space/{id}` — succeeds for spaces the personal API
//     token directly owns.
//  2. `GET /list/{list_id}` — lifts `space.name` off the list payload
//     when direct space access is denied (ClickUp's "shared with me" /
//     guest-only spaces return 401 on the space endpoint but still
//     leak their name through the list metadata of any task the user
//     can see).
//
// Cost: at most one direct + one list call per unique space across the
// process lifetime, deduped via promise caching. Negative results
// (both endpoints failed) are cached too — we don't re-try on every
// summarize call.
//
// Lookups never throw: errors become a cached `undefined` so the
// summarize path keeps the raw id instead of crashing.
export class SpaceCache {
  private cache = new Map<string, Promise<string | undefined>>();
  constructor(private client: ClickUpClient) {}

  resolveName(spaceId: string, listIdHint?: string): Promise<string | undefined> {
    if (!this.cache.has(spaceId)) {
      this.cache.set(spaceId, this.fetchOne(spaceId, listIdHint));
    }
    return this.cache.get(spaceId)!;
  }

  private async fetchOne(spaceId: string, listIdHint?: string): Promise<string | undefined> {
    try {
      type SpaceResp = { id?: string; name?: string };
      const data = await this.client.v2<SpaceResp>(`/space/${spaceId}`);
      if (data.name) return data.name;
    } catch {
      // Access denied or transient — fall through to list-based lookup.
    }
    if (listIdHint) {
      try {
        type ListResp = { space?: { id?: string; name?: string } };
        const data = await this.client.v2<ListResp>(`/list/${listIdHint}`);
        if (data.space?.name) return data.space.name;
      } catch {
        // Both paths failed — return undefined so caller keeps raw id.
      }
    }
    return undefined;
  }
}
