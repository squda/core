import { ScrapedDocumentSchema, type ScrapedDocument } from '../core/types.js';
import { normaliseUrl } from '../core/url.js';

/**
 * Phase 3, step 3 — don't fetch the same page twice.
 *
 * Async because the store behind it may be over a network. Memory answers
 * immediately and still returns a promise: one interface, so swapping the
 * store is a constructor change rather than an edit to every caller.
 */

export interface ScrapeCache {
  get(url: string, mode: string): Promise<ScrapedDocument | null>;
  set(url: string, mode: string, document: ScrapedDocument): Promise<void>;
  close(): Promise<void>;
}

const HOUR_MS = 60 * 60 * 1000;

export interface MemoryCacheOptions {
  /** How long an entry stays fresh. Default one hour. */
  ttlMs?: number;
  /** Injectable so tests can age entries without waiting. */
  now?: () => number;
  /** Entries held before the oldest is dropped. A process is not a disk. */
  maxEntries?: number;
}

interface Entry {
  expiresAt: number;
  /** Stored as JSON so a caller cannot mutate what the next reader gets. */
  document: string;
}

/**
 * The cache for a run with no Supabase configured — a CLI-shaped process, or a
 * dev loop with no credentials.
 *
 * This used to be SQLite. A file on one machine's disk was already the wrong
 * shape for a service (Phase 9 step 5 says so), and once Postgres arrived the
 * only thing the local store still had to do was stop a dev loop refetching
 * the same page — which does not need a native module, a build approval, or a
 * pin to a Node version. Insertion order gives us the eviction order for free.
 */
export class MemoryCache implements ScrapeCache {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? HOUR_MS;
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 500;
  }

  async get(url: string, mode: string): Promise<ScrapedDocument | null> {
    const entry = this.#entries.get(key(url, mode));
    if (!entry) return null;

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key(url, mode));
      return null;
    }

    // Parse on the way out, as the Postgres store does: same discipline, and
    // it keeps the two implementations honest about returning the same shape.
    const parsed = ScrapedDocumentSchema.safeParse(JSON.parse(entry.document));
    if (!parsed.success) {
      this.#entries.delete(key(url, mode));
      return null;
    }
    return parsed.data;
  }

  async set(url: string, mode: string, document: ScrapedDocument): Promise<void> {
    const identity = key(url, mode);

    // Re-inserting moves it to the end, so a page that keeps being asked for
    // is also the last to be evicted.
    this.#entries.delete(identity);
    this.#entries.set(identity, {
      expiresAt: this.#now() + this.#ttlMs,
      document: JSON.stringify(document),
    });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Drops expired entries. The read path already ignores them. */
  purge(): number {
    const now = this.#now();
    let dropped = 0;
    for (const [identity, entry] of this.#entries) {
      if (entry.expiresAt > now) continue;
      this.#entries.delete(identity);
      dropped += 1;
    }
    return dropped;
  }

  size(): number {
    return this.#entries.size;
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

/**
 * Fetch mode plus normalised url.
 *
 * The mode belongs in the key because it changes the answer: `browser=never`
 * on an SPA yields an empty shell, and serving an auto-fetched document to
 * that caller hands back exactly what they asked not to get. Normalisation is
 * what makes `?utm_source=twitter` and `?utm_source=rss` one entry.
 */
function key(url: string, mode: string): string {
  return `${mode}\n${normaliseUrl(url)}`;
}
