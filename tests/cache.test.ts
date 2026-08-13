import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCache } from '../src/service/cache.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { loadFixture } from './fixtures.js';
import type { ScrapedDocument } from '../src/core/types.js';

const DOCUMENT: ScrapedDocument = scrapeHtml(loadFixture('blog-post'));
const URL_ = 'https://overreacted.io/the-wet-codebase/';

let clock = Date.parse('2026-08-14T12:00:00Z');
const now = () => clock;

const caches: SqliteCache[] = [];

/** In-memory, so every test gets a fresh database and nothing touches disk. */
function makeCache(ttlMs = 60_000): SqliteCache {
  const cache = new SqliteCache(':memory:', { ttlMs, now });
  caches.push(cache);
  return cache;
}

afterEach(() => {
  while (caches.length) caches.pop()?.close();
  clock = Date.parse('2026-08-14T12:00:00Z');
});

describe('storing and reading', () => {
  it('returns nothing for a url it has never seen', () => {
    expect(makeCache().get(URL_, 'auto')).toBeNull();
  });

  it('round-trips a document, dates included', () => {
    const cache = makeCache();
    cache.set(URL_, 'auto', DOCUMENT);

    const found = cache.get(URL_, 'auto');

    expect(found).toEqual(DOCUMENT);
    expect(found?.fetchedAt).toBeInstanceOf(Date);
    expect(found?.markdown).toBe(DOCUMENT.markdown);
  });

  it('overwrites rather than duplicating on a second write', () => {
    const cache = makeCache();
    cache.set(URL_, 'auto', DOCUMENT);
    cache.set(URL_, 'auto', { ...DOCUMENT, title: 'Updated' });

    expect(cache.size()).toBe(1);
    expect(cache.get(URL_, 'auto')?.title).toBe('Updated');
  });
});

describe('the key', () => {
  // The Phase 1 decision paying off: one page, one entry, whichever link
  // someone happened to follow.
  it('treats urls that normalise the same as one entry', () => {
    const cache = makeCache();
    cache.set(`${URL_}?utm_source=twitter`, 'auto', DOCUMENT);

    expect(cache.get(`${URL_}?utm_source=rss`, 'auto')).not.toBeNull();
    expect(cache.get(`${URL_}#section`, 'auto')).not.toBeNull();
    expect(cache.size()).toBe(1);
  });

  it('keeps different urls apart', () => {
    const cache = makeCache();
    cache.set(URL_, 'auto', DOCUMENT);

    expect(cache.get('https://overreacted.io/something-else/', 'auto')).toBeNull();
  });

  // browser=never on an SPA yields an empty shell. Serving an auto-fetched
  // document to that caller would hand back what they asked not to get.
  it('keeps fetch modes apart', () => {
    const cache = makeCache();
    cache.set(URL_, 'auto', DOCUMENT);

    expect(cache.get(URL_, 'never')).toBeNull();
    expect(cache.get(URL_, 'always')).toBeNull();
    expect(cache.get(URL_, 'auto')).not.toBeNull();
  });

  it('refuses a url it cannot normalise, rather than storing junk', () => {
    expect(() => makeCache().get('javascript:alert(1)', 'auto')).toThrow();
  });
});

describe('expiry', () => {
  it('stops serving an entry once its ttl has passed', () => {
    const cache = makeCache(60_000);
    cache.set(URL_, 'auto', DOCUMENT);

    clock += 59_000;
    expect(cache.get(URL_, 'auto')).not.toBeNull();

    clock += 2_000;
    expect(cache.get(URL_, 'auto')).toBeNull();
  });

  it('refreshes the ttl when a page is stored again', () => {
    const cache = makeCache(60_000);
    cache.set(URL_, 'auto', DOCUMENT);

    clock += 50_000;
    cache.set(URL_, 'auto', DOCUMENT);
    clock += 50_000;

    expect(cache.get(URL_, 'auto')).not.toBeNull();
  });

  it('purges expired rows on request', () => {
    const cache = makeCache(1_000);
    cache.set(URL_, 'auto', DOCUMENT);
    clock += 2_000;

    expect(cache.purge()).toBe(1);
    expect(cache.size()).toBe(0);
  });
});

describe('when the stored shape no longer matches', () => {
  /**
   * The migration story, in one test. A document written before a field
   * existed fails today's schema — and a failed parse is a *miss*, not a
   * crash. That is what makes adding a field to ScrapedDocument a non-event:
   * old rows quietly stop being served and get refetched.
   *
   * Uses a file database so a second connection can write the stale row, which
   * an in-memory one can't do.
   */
  it('treats a row from an older schema as a miss and drops it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'scrape-cache-'));
    const path = join(directory, 'cache.db');

    const cache = new SqliteCache(path, { now });
    caches.push(cache);
    cache.set(URL_, 'auto', DOCUMENT);
    expect(cache.get(URL_, 'auto')).not.toBeNull();

    // Yesterday's document: written before `structured` and `feeds` existed.
    const stale = { ...DOCUMENT } as Record<string, unknown>;
    delete stale.structured;
    delete stale.feeds;

    const writer = new Database(path);
    writer.prepare('update pages set document = ?').run(JSON.stringify(stale));
    writer.close();

    expect(cache.get(URL_, 'auto')).toBeNull();
    expect(cache.size()).toBe(0);

    cache.close();
    caches.pop();
    rmSync(directory, { recursive: true, force: true });
  });
});
