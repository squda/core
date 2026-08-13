import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response as Response_,
} from 'playwright';
import {
  FetchTimeoutError,
  HttpStatusError,
  NetworkError,
  UnsupportedContentTypeError,
} from '../core/errors.js';
import { assertFetchable } from './ssrf.js';
import { USER_AGENT } from './user-agent.js';
import type { FetchOptions, FetchStrategy } from './strategy.js';
import type { HtmlDocument } from '../core/types.js';

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
  /**
   * Click a cookie/consent button if one is in the way.
   *
   * Not cosmetic: consent overlays commonly render *instead of* the article
   * until dismissed, so without this the page we scrape is the banner.
   */
  dismissConsent?: boolean;
  /**
   * Scroll to the bottom this many times, waiting for content after each.
   *
   * Zero by default. Infinite-scroll pages never end, so this is a budget, not
   * a "load everything" — there is no everything.
   */
  scrollPasses?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Consent buttons, in the order worth trying.
 *
 * The named ones are the two platforms behind a large share of the web's
 * banners; the rest are generic accept-shaped buttons. Accepting is the choice
 * that reveals content — and it is a choice, made once, here, rather than
 * silently in five places.
 */
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '[aria-label="Accept all"]',
  'button[id*="accept" i]:visible',
  'button:has-text("Accept all")',
  'button:has-text("I agree")',
];

/**
 * How long to wait for a click, once a button is known to be there.
 *
 * Note what this is *not*: a per-selector wait. Waiting 1.5s on each of six
 * selectors added nine seconds to every page that had no banner at all —
 * which is most pages, and which showed up as the concurrency test timing out
 * rather than as anything resembling a consent bug.
 */
const CONSENT_CLICK_TIMEOUT_MS = 1_000;

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
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      waitUntil = 'networkidle',
      dismissConsent = true,
      scrollPasses = 0,
      allowPrivate,
    } = { ...this.defaults, ...options };

    // Same guard as the HTTP path, and the browser needs it more: Chromium
    // follows its own redirects, so the check has to live on each navigation
    // rather than only on the url we were handed.
    const guard = allowPrivate === undefined ? {} : { allowPrivate };
    await assertFetchable(url, guard);

    const browser = await this.#launch();

    // A fresh context per fetch: no cookies or storage leak between pages.
    // Cheap — unlike a browser, a context is just an isolated profile.
    const context: BrowserContext = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    // Every document navigation is re-checked, which is what catches a public
    // page redirecting to 127.0.0.1 inside the browser where we cannot see it.
    let blocked: Error | null = null;
    await context.route('**/*', async (route, request) => {
      if (!request.isNavigationRequest()) return route.continue();
      try {
        await assertFetchable(request.url(), guard);
        return route.continue();
      } catch (error) {
        blocked = error as Error;
        return route.abort('blockedbyclient');
      }
    });

    // Closing the context is how a navigation gets cancelled: Playwright has no
    // abort on goto(), so the page has to go away underneath it.
    const abort = () => void context.close().catch(() => {});
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await navigate(page, url, waitUntil, timeoutMs);
      if (!response) throw new NetworkError(url, new Error('navigation produced no response'));

      const status = response.status();
      if (status < 200 || status >= 300) throw new HttpStatusError(url, status);

      const contentType = response.headers()['content-type'] ?? '';
      if (!/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType.trim())) {
        throw new UnsupportedContentTypeError(url, contentType);
      }

      if (dismissConsent) await dismissConsentBanner(page);
      if (scrollPasses > 0) await scrollThrough(page, scrollPasses);

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
      // A navigation we aborted surfaces as a generic net::ERR — report the
      // reason we aborted it, not the symptom.
      if (blocked) throw blocked;
      throw translate(error, url, timeoutMs);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await context.close().catch(() => {});
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
 * Navigate, with a fallback for pages that never go quiet.
 *
 * `networkidle` is the only wait that reliably sees a rendered SPA, but a page
 * that polls — a chat widget, an analytics heartbeat, a live ticker — never
 * reaches it, and waiting for something that will not happen is not a reason
 * to return nothing. On that timeout we settle for `domcontentloaded` and take
 * whatever has rendered, which is usually the whole page.
 *
 * A timeout with no response at all is still a timeout, and still throws.
 */
async function navigate(
  page: Page,
  url: string,
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle',
  timeoutMs: number,
): Promise<Response_ | null> {
  try {
    return await page.goto(url, { waitUntil, timeout: timeoutMs });
  } catch (error) {
    if (waitUntil !== 'networkidle' || !(error instanceof Error) || error.name !== 'TimeoutError') {
      throw error;
    }
    // Already navigated; this resolves against the load that did happen.
    return page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }
}

/**
 * Best effort, and cheap when there is nothing to do — which is the common case.
 *
 * `isVisible()` answers from the current DOM without waiting, so a page with no
 * banner costs six near-instant checks rather than six timeouts.
 */
async function dismissConsentBanner(page: Page): Promise<void> {
  for (const selector of CONSENT_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if (!(await button.isVisible())) continue;

      await button.click({ timeout: CONSENT_CLICK_TIMEOUT_MS });
      // One banner, one click. Anything still overlaying is not a cookie notice.
      return;
    } catch {
      continue;
    }
  }
}

/**
 * Scroll to the bottom `passes` times, giving the page a moment to append.
 *
 * Stops early when the height stops growing — a finite page is done, and there
 * is no point paying for the remaining passes.
 */
async function scrollThrough(page: Page, passes: number): Promise<void> {
  let previousHeight = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    const height = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });

    if (height === previousHeight) return;
    previousHeight = height;

    await page.waitForTimeout(500);
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
