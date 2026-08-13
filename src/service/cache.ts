import Database, { type Database as Db } from 'better-sqlite3';
import { ScrapedDocumentSchema, type ScrapedDocument } from '../core/types.js';
import { normaliseUrl } from '../core/url.js';

/**
 * Phase 3, step 3 — don't fetch the same page twice.
 *
 * The SQL here is written by hand on purpose. Phase 5 puts Drizzle over this
 * same database, and the contrast is the lesson: you will know what the ORM
 * bought you because you will have done it without one.
 */

/**
 * Async because the store behind it may be over a network. SQLite answers
 * immediately and still returns a promise: one interface, so swapping the
 * store is a constructor change rather than an edit to every caller.
 */
export interface ScrapeCache {
  get(url: string, mode: string): Promise<ScrapedDocument | null>;
  set(url: string, mode: string, document: ScrapedDocument): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
  create table if not exists pages (
    key         text primary key,
    url         text not null,
    mode        text not null,
    stored_at   integer not null,
    expires_at  integer not null,
    document    text not null
  );
  create index if not exists pages_expires_at on pages (expires_at);
`;

const HOUR_MS = 60 * 60 * 1000;

export interface SqliteCacheOptions {
  /** How long an entry stays fresh. Default one hour. */
  ttlMs?: number;
  /** Injectable so tests can age entries without waiting. */
  now?: () => number;
}

export class SqliteCache implements ScrapeCache {
  readonly #db: Db;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(path = ':memory:', options: SqliteCacheOptions = {}) {
    this.#db = new Database(path);
    this.#ttlMs = options.ttlMs ?? HOUR_MS;
    this.#now = options.now ?? Date.now;

    // WAL lets a reader and a writer coexist, which the job queue in step 4
    // will need the moment two scrapes finish at once.
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(SCHEMA);
  }

  async get(url: string, mode: string): Promise<ScrapedDocument | null> {
    const row = this.#db
      .prepare<[string, number], { document: string }>(
        'select document from pages where key = ? and expires_at > ?',
      )
      .get(this.#key(url, mode), this.#now());

    if (!row) return null;

    // Parse, don't validate — a database is an outside system too. This is
    // also the schema-migration story: a document written before a field was
    // added fails the parse, and a failed parse is simply a miss.
    const parsed = ScrapedDocumentSchema.safeParse(JSON.parse(row.document));
    if (!parsed.success) {
      this.#db.prepare('delete from pages where key = ?').run(this.#key(url, mode));
      return null;
    }

    return parsed.data;
  }

  async set(url: string, mode: string, document: ScrapedDocument): Promise<void> {
    const storedAt = this.#now();

    this.#db
      .prepare(
        `insert into pages (key, url, mode, stored_at, expires_at, document)
         values (?, ?, ?, ?, ?, ?)
         on conflict(key) do update set
           stored_at = excluded.stored_at,
           expires_at = excluded.expires_at,
           document = excluded.document`,
      )
      .run(
        this.#key(url, mode),
        normaliseUrl(url),
        mode,
        storedAt,
        storedAt + this.#ttlMs,
        JSON.stringify(document),
      );
  }

  /** Drop expired rows. Nothing calls this yet; the read path already ignores them. */
  purge(): number {
    return this.#db.prepare('delete from pages where expires_at <= ?').run(this.#now()).changes;
  }

  size(): number {
    return this.#db.prepare<[], { n: number }>('select count(*) as n from pages').get()?.n ?? 0;
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  /**
   * Normalised URL plus fetch mode.
   *
   * The mode belongs in the key because it changes the answer: `browser=never`
   * on an SPA yields an empty shell, and serving that from a cache filled by an
   * `auto` request would hand back a document the caller explicitly asked not
   * to get. Normalisation is what makes `?utm_source=twitter` and `?utm_source=rss`
   * one entry rather than two.
   */
  #key(url: string, mode: string): string {
    return `${mode}\n${normaliseUrl(url)}`;
  }
}
