import { HttpStrategy } from './http-strategy.js';
import { extractContent } from './extract.js';
import { toMarkdown } from './markdown.js';
import { normaliseUrl } from './url.js';
import { judge } from './select.js';
import { detectWall } from './wall.js';
import type { FetchStrategy } from './strategy.js';
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
  const { browser = 'auto', strategy, log = () => {} } = options;
  const url = normaliseUrl(rawUrl);

  if (strategy) {
    const doc = await strategy.fetch(url);
    log(`fetched with ${strategy.name} (forced)`);
    return scrapeHtml(doc);
  }

  if (browser === 'always') {
    return scrapeWithBrowser(url, log, 'requested');
  }

  const httpDoc = await httpStrategy.fetch(url);
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

  return scrapeWithBrowser(url, log, verdict.reason);
}

/**
 * The retry. Its own function because the browser has to be closed on every
 * path out of it, including the one where it fails.
 */
async function scrapeWithBrowser(
  url: string,
  log: (message: string) => void,
  reason: string,
): Promise<ScrapedDocument> {
  log(`retrying with a browser — ${reason}`);

  const { BrowserStrategy } = await import('./browser-strategy.js');
  const strategy = new BrowserStrategy();

  try {
    const doc = await strategy.fetch(url);
    const scraped = scrapeHtml(doc);
    log(`fetched with browser — ${scraped.markdown.length} characters of markdown`);
    return scraped;
  } finally {
    await strategy.close();
  }
}
