import { HttpStrategy } from '../fetching/http.js';
import { extractContent } from './extract.js';
import { toMarkdown } from './markdown.js';
import { normaliseUrl } from './url.js';
import { judge } from './select.js';
import { defaultBrowserPool, type BrowserPool } from '../fetching/pool.js';
import { detectWall } from './wall.js';
import type { FetchStrategy } from '../fetching/strategy.js';
import { ScrapedDocumentSchema, type HtmlDocument, type ScrapedDocument } from './types.js';

/**
 * The core. Knows nothing about the CLI, and in Phase 3 it must still know
 * nothing about HTTP servers — that layering is the point of the whole project
 * (plan, Phase 3: "the single most transferable idea").
 *
 * This is already written. You only fill in the pieces it calls.
 */
export function scrapeHtml(doc: HtmlDocument): ScrapedDocument {
  const extracted = extractContent(doc);
  const converted = toMarkdown(extracted.html, doc.finalUrl);
  const wall = detectWall({
    title: extracted.title,
    markdown: converted.markdown,
    links: converted.links,
  });

  // Parse, don't validate: this is the boundary where our data becomes trusted.
  return ScrapedDocumentSchema.parse({
    url: doc.url,
    fetchedAt: doc.fetchedAt,
    fetchedWith: doc.fetchedWith,
    title: extracted.title,
    description: extracted.description,
    markdown: converted.markdown,
    links: converted.links,
    images: converted.images,
    structured: extracted.structured,
    feeds: extracted.feeds,
    wall,
  });
}

export interface ScrapeOptions {
  /**
   * `auto` (default) tries HTTP and retries with a browser when the result
   * looks empty; `never` is Phase 1's behaviour; `always` skips straight to the
   * browser for a page you already know needs one.
   */
  browser?: 'auto' | 'never' | 'always';
  /** Force a specific strategy. Overrides `browser`; mostly for tests. */
  strategy?: FetchStrategy;
  /** Where the "which path ran" line goes. Silent by default. */
  log?: (message: string) => void;
  /**
   * Shared browser, with its concurrency cap. Defaults to a process-wide pool
   * that closes the browser as soon as it goes idle; a server passes its own,
   * configured to stay warm between requests.
   */
  pool?: BrowserPool;
  /** Cancels the whole scrape, including a browser retry already under way. */
  signal?: AbortSignal;
  /**
   * How long a single fetch may take, in milliseconds. 30 seconds by default.
   *
   * Per fetch, not per scrape: an `auto` run that escalates spends this on the
   * HTTP attempt and again on the browser. The browser attempt is the one worth
   * budgeting for — it divides this between waiting for the page to go quiet
   * and a fallback for pages that never do, so the two together stay inside it.
   *
   * Anything enforcing a limit above this — a load balancer, a proxy, a client
   * — has to allow for the escalation and for the work after the page loads:
   * dismissing consent, expanding tabs. Leave it fifteen seconds of room and a
   * slow page reports a timeout instead of being killed mid-sentence by
   * something that cannot say why.
   */
  timeoutMs?: number;
}

const httpStrategy = new HttpStrategy();

/**
 * Fetch a page and turn it into a ScrapedDocument, choosing how to fetch it.
 *
 * The browser is imported dynamically, so a static scrape never loads
 * Playwright — that keeps `pnpm scrape` on a normal page as fast as it was in
 * Phase 1, and keeps the fast test suite free of a browser dependency.
 */
export async function scrape(
  rawUrl: string,
  options: ScrapeOptions = {},
): Promise<ScrapedDocument> {
  const {
    browser = 'auto',
    strategy,
    log = () => {},
    pool = defaultBrowserPool,
    signal,
    timeoutMs,
  } = options;
  const fetchOptions = {
    ...(signal ? { signal } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const url = normaliseUrl(rawUrl);

  if (strategy) {
    const doc = await strategy.fetch(url, fetchOptions);
    log(`fetched with ${strategy.name} (forced)`);
    return scrapeHtml(doc);
  }

  if (browser === 'always') {
    return scrapeWithBrowser(url, pool, log, 'requested', fetchOptions);
  }

  const httpDoc = await httpStrategy.fetch(url, fetchOptions);
  const scraped = scrapeHtml(httpDoc);

  if (browser === 'never') {
    log('fetched with http (browser disabled)');
    return scraped;
  }

  const verdict = judge(httpDoc, scraped);
  if (!verdict.needsBrowser) {
    log(`fetched with http — ${verdict.reason}`);
    return scraped;
  }

  return scrapeWithBrowser(url, pool, log, verdict.reason, fetchOptions);
}

/**
 * The retry. The pool owns the browser's lifetime and the concurrency cap, so
 * this no longer opens or closes anything — it queues for a slot and waits.
 */
async function scrapeWithBrowser(
  url: string,
  pool: BrowserPool,
  log: (message: string) => void,
  reason: string,
  fetchOptions: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ScrapedDocument> {
  const { queued } = pool.stats();
  log(`retrying with a browser — ${reason}${queued > 0 ? ` (${queued} waiting)` : ''}`);

  const scraped = scrapeHtml(await pool.fetch(url, fetchOptions));
  log(`fetched with browser — ${scraped.markdown.length} characters of markdown`);
  return scraped;
}
