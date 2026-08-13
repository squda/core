import { ScrapedDocumentSchema, type ScrapedDocument } from '../core/types.js';
import { normaliseUrl } from '../core/url.js';
import type { ScrapeCache } from './cache.js';
import type { SupabaseClient } from './supabase.js';

/**
 * The page cache in Postgres instead of a file on one machine's disk.
 *
 * Same contract as SqliteCache, same key, same "a failed parse is a miss"
 * migration story — the difference is that two instances now share it, which
 * is what the SQLite version could never do.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface SupabaseCacheOptions {
  ttlMs?: number;
  now?: () => number;
  /** Somewhere to report a store that is misbehaving. A cache must not be fatal. */
  onError?: (error: unknown) => void;
}

export class SupabaseCache implements ScrapeCache {
  readonly #client: SupabaseClient;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  constructor(client: SupabaseClient, options: SupabaseCacheOptions = {}) {
    this.#client = client;
    this.#ttlMs = options.ttlMs ?? HOUR_MS;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  async get(url: string, mode: string): Promise<ScrapedDocument | null> {
    const { data, error } = await this.#client
      .from('scrape_cache')
      .select('document')
      .eq('key', key(url, mode))
      .gt('expires_at', new Date(this.#now()).toISOString())
      .maybeSingle();

    if (error) {
      // A cache that is down is a slow scraper, not a broken one.
      this.#onError(error);
      return null;
    }
    if (!data) return null;

    // Parse, don't validate: a database is an outside system too, and this is
    // the migration story — a row written before a field existed fails today's
    // parse, and a failed parse is simply a miss.
    const parsed = ScrapedDocumentSchema.safeParse(data.document);
    if (!parsed.success) {
      await this.#drop(url, mode);
      return null;
    }
    return parsed.data;
  }

  async set(url: string, mode: string, document: ScrapedDocument): Promise<void> {
    const storedAt = this.#now();

    const { error } = await this.#client.from('scrape_cache').upsert(
      {
        key: key(url, mode),
        url: normaliseUrl(url),
        mode,
        document,
        stored_at: new Date(storedAt).toISOString(),
        expires_at: new Date(storedAt + this.#ttlMs).toISOString(),
      },
      { onConflict: 'key' },
    );

    if (error) this.#onError(error);
  }

  /** Drops rows that expired. Nothing calls it yet; the read path ignores them. */
  async purge(): Promise<void> {
    const { error } = await this.#client
      .from('scrape_cache')
      .delete()
      .lte('expires_at', new Date(this.#now()).toISOString());

    if (error) this.#onError(error);
  }

  async close(): Promise<void> {
    // Nothing to close: supabase-js holds no pool of its own.
  }

  async #drop(url: string, mode: string): Promise<void> {
    const { error } = await this.#client.from('scrape_cache').delete().eq('key', key(url, mode));
    if (error) this.#onError(error);
  }
}

/**
 * Fetch mode plus normalised url — the same identity the SQLite cache uses,
 * so `?utm_source=twitter` and `?utm_source=rss` are one row either way.
 */
function key(url: string, mode: string): string {
  return `${mode}\n${normaliseUrl(url)}`;
}
