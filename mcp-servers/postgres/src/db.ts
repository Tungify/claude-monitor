import pg from "pg";

// Every query runs over the extended protocol. A user-supplied WHERE
// fragment can then never smuggle a second statement (e.g.
// `1=1; COMMIT; DROP TABLE x`) — Postgres rejects multiple commands
// in one prepared statement. @types/pg doesn't declare queryMode yet.
type ExtendedQuery = pg.QueryConfig & { queryMode: "extended" };

const STATEMENT_TIMEOUT_MS = 30_000;

export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(table: string, schema?: string): string {
  return `${ident(schema || "public")}.${ident(table)}`;
}

export class Db {
  private readonly pool: pg.Pool;

  constructor(uri: string) {
    this.pool = new pg.Pool({ connectionString: uri, max: 3 });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  // read runs fn inside a READ ONLY transaction that is always rolled
  // back, so even a write slipped into a WHERE fragment cannot land.
  async read<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.tx("BEGIN READ ONLY", fn, false);
  }

  // write commits only when fn returns; any throw rolls back.
  async write<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.tx("BEGIN", fn, true);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(
    begin: string,
    fn: (q: Querier) => Promise<T>,
    commit: boolean,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(begin);
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const result = await fn(new Querier(client));
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

export class Querier {
  constructor(private readonly client: pg.PoolClient) {}

  async rows(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
    const config: ExtendedQuery = { text, values, queryMode: "extended" };
    return this.client.query(config);
  }
}
