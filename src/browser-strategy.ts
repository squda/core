import { chromium, type Browser, type BrowserContext } from 'playwright';
import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from './errors.js';
import { USER_AGENT } from './user-agent.js';
import type { FetchOptions, FetchStrategy } from './strategy.js';
import type { HtmlDocument } from './types.js';

/**
 * Phase 2 — the same page, fetched by a real browser.
 *
 * Everything downstream is untouched: this returns the identical HtmlDocument
 * shape, and throws the identical error classes as the HTTP path. A caller
 * cannot tell which strategy ran except by asking `name`, which is the point.
 */

export interface BrowserFetchOptions extends FetchOptions {
  /**
   * Which lifecycle event counts as "loaded".
   *
   * - `domcontentloaded` — HTML parsed. Too early for an SPA.
   * - `load` — images and stylesheets done. Still before React has rendered.
   * - `networkidle` — no requests for 500ms. Right for SPAs, and the reason
   *   this class exists; it also never settles on pages that poll, which is
   *   what the timeout is for.
   */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class BrowserStrategy implements FetchStrategy {
  readonly name = 'browser';

  /**
   * One browser, reused across fetches. Launching Chromium costs ~200ms and a
   * process; doing it per request is the difference between a scraper and a
   * fork bomb. Held as a promise so two concurrent fetches share one launch
   * instead of racing to start two.
   */
  #browser: Promise<Browser> | null = null;

  constructor(private readonly defaults: BrowserFetchOptions = {}) {}

  async fetch(url: string, options: BrowserFetchOptions = {}): Promise<HtmlDocument> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, waitUntil = 'networkidle' } = {
      ...this.defaults,
      ...options,
    };

    const browser = await this.#launch();

    // A fresh context per fetch: no cookies or storage leak between pages.
    // Cheap — unlike a browser, a context is just an isolated profile.
    const context: BrowserContext = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    try {
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      if (!response) throw new NetworkError(url, new Error('navigation produced no response'));

      const status = response.status();
      if (status < 200 || status >= 300) throw new HttpStatusError(url, status);

      const contentType = response.headers()['content-type'] ?? '';
      if (!/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType.trim())) {
        throw new UnsupportedContentTypeError(url, contentType);
      }

      return {
        url,
        fetchedWith: 'browser',
        // page.url() after navigation — redirects and pushState both land here.
        finalUrl: page.url(),
        html: await page.content(),
        contentType,
        status,
        fetchedAt: new Date(),
      };
    } catch (error) {
      throw translate(error, url, timeoutMs);
    } finally {
      await context.close();
    }
  }

  /** Launched on first use, so constructing a strategy costs nothing. */
  async #launch(): Promise<Browser> {
    this.#browser ??= chromium.launch({ headless: true });
    return this.#browser;
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser) await (await browser).close();
  }
}

/**
 * Playwright's failures become the same errors the HTTP path throws, so the
 * CLI's exit codes and Phase 3's status mapping work identically either way.
 */
function translate(error: unknown, url: string, timeoutMs: number): unknown {
  if (
    error instanceof FetchTimeoutError ||
    error instanceof HttpStatusError ||
    error instanceof UnsupportedContentTypeError ||
    error instanceof NetworkError
  ) {
    return error;
  }

  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return new FetchTimeoutError(url, timeoutMs);
    // net::ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED, ERR_CERT_*, …
    if (error.message.includes('net::')) return new NetworkError(url, error);

    // A browser doesn't refuse a PDF, it downloads it — so the content-type
    // check above never runs and Playwright aborts the navigation instead.
    // Same conclusion as the HTTP path, reached by a different road.
    if (error.message.includes('Download is starting')) {
      return new UnsupportedContentTypeError(url, 'a file the browser downloaded instead');
    }
  }

  return error;
}
