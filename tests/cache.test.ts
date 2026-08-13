import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/service/cache.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { loadFixture } from './fixtures.js';
import type { ScrapedDocument } from '../src/core/types.js';

const DOCUMENT: ScrapedDocument = scrapeHtml(loadFixture('blog-post'));
const URL_ = 'https://overreacted.io/the-wet-codebase/';

let clock = Date.parse('2026-08-14T12:00:00Z');
const now = () => clock;

const caches: MemoryCache[] = [];

function makeCache(ttlMs = 60_000): MemoryCache {
  const cache = new MemoryCache({ ttlMs, now });
  caches.push(cache);
  return cache;
}

afterEach(() => {
  while (caches.length) void caches.pop()?.close();
  clock = Date.parse('2026-08-14T12:00:00Z');
});

describe('storing and reading', () => {
  it('returns nothing for a url it has never seen', async () => {
    expect(await makeCache().get(URL_, 'auto')).toBeNull();
  });

  it('round-trips a document, dates included', async () => {
    const cache = makeCache();
    await cache.set(URL_, 'auto', DOCUMENT);

    const found = await cache.get(URL_, 'auto');

    expect(found).toEqual(DOCUMENT);
    expect(found?.fetchedAt).toBeInstanceOf(Date);
    expect(found?.markdown).toBe(DOCUMENT.markdown);
  });

  it('overwrites rather than duplicating on a second write', async () => {
    const cache = makeCache();
    await cache.set(URL_, 'auto', DOCUMENT);
    await cache.set(URL_, 'auto', { ...DOCUMENT, title: 'Updated' });

    expect(cache.size()).toBe(1);
    expect((await cache.get(URL_, 'auto'))?.title).toBe('Updated');
  });
});

describe('the key', () => {
  // The Phase 1 decision paying off: one page, one entry, whichever link
  // someone happened to follow.
  it('treats urls that normalise the same as one entry', async () => {
    const cache = makeCache();
    await cache.set(`${URL_}?utm_source=twitter`, 'auto', DOCUMENT);

    expect(await cache.get(`${URL_}?utm_source=rss`, 'auto')).not.toBeNull();
    expect(await cache.get(`${URL_}#section`, 'auto')).not.toBeNull();
    expect(cache.size()).toBe(1);
  });

  it('keeps different urls apart', async () => {
    const cache = makeCache();
    await cache.set(URL_, 'auto', DOCUMENT);

    expect(await cache.get('https://overreacted.io/something-else/', 'auto')).toBeNull();
  });

  // browser=never on an SPA yields an empty shell. Serving an auto-fetched
  // document to that caller would hand back what they asked not to get.
  it('keeps fetch modes apart', async () => {
    const cache = makeCache();
    await cache.set(URL_, 'auto', DOCUMENT);

    expect(await cache.get(URL_, 'never')).toBeNull();
    expect(await cache.get(URL_, 'always')).toBeNull();
    expect(await cache.get(URL_, 'auto')).not.toBeNull();
  });

  it('refuses a url it cannot normalise, rather than storing junk', async () => {
    await expect(makeCache().get('javascript:alert(1)', 'auto')).rejects.toThrow();
  });
});

describe('expiry', () => {
  it('stops serving an entry once its ttl has passed', async () => {
    const cache = makeCache(60_000);
    await cache.set(URL_, 'auto', DOCUMENT);

    clock += 59_000;
    expect(await cache.get(URL_, 'auto')).not.toBeNull();

    clock += 2_000;
    expect(await cache.get(URL_, 'auto')).toBeNull();
  });

  it('refreshes the ttl when a page is stored again', async () => {
    const cache = makeCache(60_000);
    await cache.set(URL_, 'auto', DOCUMENT);

    clock += 50_000;
    await cache.set(URL_, 'auto', DOCUMENT);
    clock += 50_000;

    expect(await cache.get(URL_, 'auto')).not.toBeNull();
  });

  it('purges expired rows on request', async () => {
    const cache = makeCache(1_000);
    await cache.set(URL_, 'auto', DOCUMENT);
    clock += 2_000;

    expect(cache.purge()).toBe(1);
    expect(cache.size()).toBe(0);
  });
});

describe('when the stored shape no longer matches', () => {
  /**
   * The migration story. A document written before a field existed fails
   * today's schema — and a failed parse is a *miss*, not a crash, so the entry
   * is dropped and the page refetched. That is what makes adding a field to
   * ScrapedDocument a non-event, here and in Postgres alike.
   */
  it('treats an entry from an older shape as a miss and drops it', async () => {
    const cache = makeCache();
    const stale = { ...DOCUMENT } as Record<string, unknown>;
    delete stale.structured;
    delete stale.feeds;

    await cache.set(URL_, 'auto', stale as never);

    expect(await cache.get(URL_, 'auto')).toBeNull();
    expect(cache.size()).toBe(0);
  });
});

describe('bounded size', () => {
  // A process is not a disk: without a bound this is a memory leak that only
  // shows up after a long run over many urls.
  it('evicts the least recently stored entry past its limit', async () => {
    const cache = new MemoryCache({ maxEntries: 2, now });

    await cache.set('https://a.test/', 'auto', DOCUMENT);
    await cache.set('https://b.test/', 'auto', DOCUMENT);
    await cache.set('https://c.test/', 'auto', DOCUMENT);

    expect(cache.size()).toBe(2);
    expect(await cache.get('https://a.test/', 'auto')).toBeNull();
    expect(await cache.get('https://c.test/', 'auto')).not.toBeNull();
  });

  it('keeps a page that is asked for again', async () => {
    const cache = new MemoryCache({ maxEntries: 2, now });

    await cache.set('https://a.test/', 'auto', DOCUMENT);
    await cache.set('https://b.test/', 'auto', DOCUMENT);
    await cache.set('https://a.test/', 'auto', DOCUMENT);
    await cache.set('https://c.test/', 'auto', DOCUMENT);

    expect(await cache.get('https://a.test/', 'auto')).not.toBeNull();
    expect(await cache.get('https://b.test/', 'auto')).toBeNull();
  });
});
