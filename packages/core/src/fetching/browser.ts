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
import { expandDisclosures } from './expand.js';
import { assertFetchable } from './ssrf.js';
import { USER_AGENT } from './user-agent.js';
import type { FetchOptions, FetchStrategy } from './strategy.js';
import type { HtmlDocument } from '../core/types.js';
import { inspectFormsOnPage, type BrowserFormInspection } from '../forms/live-inspector.js';
import { waitForDomQuiet } from '../forms/dom-readiness.js';

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
  /**
   * Flags passed to Chromium at launch. See `CONTAINER_CHROMIUM_ARGS`.
   *
   * Set on the strategy rather than per fetch: the browser is launched once and
   * shared, so the first caller's flags would silently become everyone's.
   */
  launchArgs?: string[];
  /**
   * Open tabs, accordions and `<details>` before reading the page.
   *
   * On by default, unlike `scrollPasses`, and the difference is what each one
   * costs when it is not needed. A scroll pass always spends its half-second;
   * this is one `querySelectorAll` on a page with no disclosures, and on a page
   * with them it is the difference between one tab and the whole document.
   *
   * See `expand.ts` for why clicking a stranger's page is safe here — briefly:
   * only elements that declare themselves as disclosures, in a context with no
   * cookies and so no session to act on.
   */
  expand?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const OPEN_CLOSED_SHADOW_ROOTS_SCRIPT = String.raw`(() => {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
    const wasClosed = init.mode === 'closed';
    const root = original.call(this, wasClosed ? { ...init, mode: 'open' } : init);
    if (wasClosed) this.setAttribute('data-scrape-original-closed-shadow', '');
    return root;
  };
})()`;

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

/**
 * Chromium flags a container needs and a laptop does not.
 *
 * `--no-sandbox` because a hardened runtime — Cloud Run, Fly, most Kubernetes —
 * denies the syscalls Chromium's own sandbox is built from, and it refuses to
 * start rather than run unsandboxed by accident. Dropping it is safe only
 * because the container is already the sandbox.
 *
 * `--disable-dev-shm-usage` because Docker gives `/dev/shm` 64MB by default and
 * Chromium will happily want more. Without it a page crashes partway through
 * rendering and the failure looks like a timeout, which sends you looking in
 * entirely the wrong place.
 *
 * Off by default, opt-in through `CHROMIUM_ARGS`, because a laptop needs
 * neither and `--no-sandbox` is not something to switch on quietly.
 */
export const CONTAINER_CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

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
    return this.#visit(url, options, false, (_page, document) => document);
  }

  /**
   * Fetch and inspect forms before the live page is closed.
   *
   * `page.content()` deliberately remains the fetch contract, but it cannot
   * contain shadow roots or iframe documents. Form inspection therefore gets
   * this dedicated operation while sharing the same guarded browser lifetime.
   */
  async inspectForms(
    url: string,
    options: BrowserFetchOptions = {},
  ): Promise<BrowserFormInspection> {
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Leave enough time for the inspector to return its partial result and
    // budget warning before the request's hard deadline closes the context.
    const inspectionReserveMs = Math.min(500, Math.max(100, timeoutMs / 4));
    return this.#visit(url, options, true, async (page, document, deadline) => ({
      document,
      spec: await inspectFormsOnPage(page, document, {
        deadline: deadline - inspectionReserveMs,
      }),
    }));
  }

  async #visit<Result>(
    url: string,
    options: BrowserFetchOptions,
    openClosedShadowRoots: boolean,
    read: (page: Page, document: HtmlDocument, deadline: number) => Result | Promise<Result>,
  ): Promise<Result> {
    const {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      waitUntil = 'networkidle',
      dismissConsent = true,
      scrollPasses = 0,
      expand = true,
      allowPrivate,
      signal,
    } = { ...this.defaults, ...options };
    const deadline = Date.now() + timeoutMs;

    // Same guard as the HTTP path, and the browser needs it more: Chromium
    // follows its own redirects, so the check has to live on each navigation
    // rather than only on the url we were handed.
    const guard = allowPrivate === undefined ? {} : { allowPrivate };
    await beforeDeadline(assertFetchable(url, guard), deadline, url, timeoutMs);

    const browser = await beforeDeadline(this.#launch(), deadline, url, timeoutMs);

    // A fresh context per fetch: no cookies or storage leak between pages.
    // Cheap — unlike a browser, a context is just an isolated profile.
    const contextPromise = browser.newContext({ userAgent: USER_AGENT });
    const context: BrowserContext = await beforeDeadline(
      contextPromise,
      deadline,
      url,
      timeoutMs,
    ).catch((error) => {
      void contextPromise.then((lateContext) => lateContext.close()).catch(() => {});
      throw error;
    });
    const page = await beforeDeadline(context.newPage(), deadline, url, timeoutMs).catch(
      (error) => {
        void context.close().catch(() => {});
        throw error;
      },
    );
    let deadlineExpired = false;
    const deadlineTimer = setTimeout(
      () => {
        deadlineExpired = true;
        void context.close().catch(() => {});
      },
      Math.max(1, deadline - Date.now()),
    );

    // Every document navigation is re-checked, which is what catches a public
    // page redirecting to 127.0.0.1 inside the browser where we cannot see it.
    let blocked: Error | null = null;
    // Closing the context is how a navigation gets cancelled: Playwright has no
    // abort on goto(), so the page has to go away underneath it.
    const abort = () => void context.close().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });

    try {
      if (openClosedShadowRoots) {
        // Closed roots deliberately disappear from every normal DOM interface.
        // Install before site scripts run, and mark each affected host so the
        // result can explain that replaying the locator needs the same hook.
        await context.addInitScript(OPEN_CLOSED_SHADOW_ROOTS_SCRIPT);
      }

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

      const response = await navigate(page, url, waitUntil, remaining(deadline, url, timeoutMs));
      if (!response) throw new NetworkError(url, new Error('navigation produced no response'));

      const status = response.status();
      if (status < 200 || status >= 300) throw new HttpStatusError(url, status);

      const contentType = response.headers()['content-type'] ?? '';
      if (!/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType.trim())) {
        throw new UnsupportedContentTypeError(url, contentType);
      }

      if (dismissConsent) await dismissConsentBanner(page, deadline);
      if (scrollPasses > 0) await scrollThrough(page, scrollPasses, deadline);
      // Last, so it acts on the whole page: after the consent overlay is gone,
      // and after scrolling has appended whatever it is going to append.
      if (expand) {
        await expandDisclosures(page, {
          budgetMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }

      // After expanding, so anything we just opened counts as visible.
      await markInvisible(page);

      const document: HtmlDocument = {
        url,
        fetchedWith: 'browser',
        // page.url() after navigation — redirects and pushState both land here.
        finalUrl: page.url(),
        html: await page.content(),
        contentType,
        status,
        fetchedAt: new Date(),
      };

      const result = await read(page, document, deadline);
      if (Date.now() >= deadline) throw new FetchTimeoutError(url, timeoutMs);
      return result;
    } catch (error) {
      // A navigation we aborted surfaces as a generic net::ERR — report the
      // reason we aborted it, not the symptom.
      if (blocked) throw blocked;
      if (deadlineExpired) throw new FetchTimeoutError(url, timeoutMs);
      throw translate(error, url, timeoutMs);
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', abort);
      await context.close().catch(() => {});
    }
  }

  /** Launched on first use, so constructing a strategy costs nothing. */
  async #launch(): Promise<Browser> {
    const args = this.defaults.launchArgs ?? [];
    this.#browser ??= chromium.launch({
      headless: true,
      // Spread rather than passing `[]`, so the default launch is byte-for-byte
      // what it was before this option existed.
      ...(args.length > 0 ? { args } : {}),
    });
    return this.#browser;
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser) await (await browser).close();
  }
}

/**
 * Share of the budget the first attempt may spend.
 *
 * The rest is held back for the fallback, so the two together stay inside the
 * caller's timeout. Weighted towards the first because that is the one expected
 * to succeed: `networkidle` settles in a couple of seconds on most pages, and
 * the fallback only has to wait for `domcontentloaded`, which has usually
 * already happened by the time it runs.
 */
const READINESS_SHARE = 0.6;

/**
 * Navigate once, then wait separately for the requested readiness signal.
 *
 * `networkidle` is the only wait that reliably sees a rendered SPA, but a page
 * that polls — a chat widget, an analytics heartbeat, a live ticker — never
 * reaches it, and waiting for something that will not happen is not a reason
 * to return nothing. On that timeout we settle for `domcontentloaded` and take
 * whatever has rendered, which is usually the whole page.
 *
 * Retrying `page.goto()` reloads the site and can double both latency and side
 * effects. DOMContentLoaded obtains the response once; readiness is then a
 * bounded wait on that same document. Polling pages fall back to DOM mutation
 * quietness, which is the signal form extraction actually needs.
 *
 * A timeout with no response at all is still a timeout, and still throws.
 */
async function navigate(
  page: Page,
  url: string,
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle',
  timeoutMs: number,
): Promise<Response_ | null> {
  const deadline = Date.now() + timeoutMs;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (waitUntil === 'domcontentloaded') return response;

  try {
    await page.waitForLoadState(waitUntil, {
      timeout: Math.max(
        1,
        Math.min(deadline - Date.now(), Math.round(timeoutMs * READINESS_SHARE)),
      ),
    });
  } catch (error) {
    if (waitUntil !== 'networkidle' || !(error instanceof Error) || error.name !== 'TimeoutError') {
      throw error;
    }
    await waitForDomQuiet(page, Math.max(1, Math.min(2_000, deadline - Date.now())));
  }
  return response;
}

/**
 * Best effort, and cheap when there is nothing to do — which is the common case.
 *
 * `isVisible()` answers from the current DOM without waiting, so a page with no
 * banner costs six near-instant checks rather than six timeouts.
 */
async function dismissConsentBanner(page: Page, deadline: number): Promise<void> {
  for (const selector of CONSENT_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if (!(await button.isVisible())) continue;

      await button.click({
        timeout: Math.max(1, Math.min(CONSENT_CLICK_TIMEOUT_MS, deadline - Date.now())),
      });
      // One banner, one click. Anything still overlaying is not a cookie notice.
      return;
    } catch {
      continue;
    }
  }
}

/**
 * Tag the dialogs a page ships but is not showing, for extraction to drop.
 *
 * A single page can carry a dozen of these — "Something went wrong", "Are you
 * sure you want to sign out?", "You need to sign in before applying" — hidden
 * with CSS. Extraction runs on HTML with no stylesheet and no layout, so to it
 * those are ordinary headings, and they arrive at the top of the markdown as if
 * the page had said them. Only a real browser can tell, and this is the one
 * place in the pipeline that has one.
 *
 * ## Why not simply drop everything that is hidden
 *
 * Because most hidden text is *collapsed*, not junk. myscheme.gov.in builds its
 * FAQ from plain `<div class="cursor-pointer">` with no role, no
 * `aria-expanded`, nothing — so the expander cannot open it, and dropping every
 * hidden element took all nine answers with it. Losing real content silently is
 * a far worse failure than printing a stale dialog, and it is the one nobody
 * notices.
 *
 * So the rule is narrow, and it is about *layout* rather than visibility alone:
 * an overlay is taken out of the flow — `position: fixed` — or says outright
 * that it is a dialog. Collapsed content sits in normal flow and is kept, junk
 * and all.
 *
 * Marked, not removed, and that distinction is the contract: `html` stays what
 * the browser actually had, so Phase 4's form walker still finds the hidden
 * inputs it is supposed to find. Whether something is *prose* is extraction's
 * decision, and it drops `[data-scrape-hidden]` along with the rest of the junk.
 */
async function markInvisible(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      // `display: none` is simply what these are, and one of them — JSON-LD —
      // is content read on purpose.
      const metadata = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
      const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

      for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
        if (metadata.has(element.tagName)) continue;
        // Our own rescued panels are parked off-screen on purpose.
        if (element.closest('#scrape-revealed')) continue;

        const style = getComputedStyle(element);
        if (style.display !== 'none' && style.visibility !== 'hidden') continue;

        if (style.position === 'fixed' || element.matches(DIALOG)) {
          element.setAttribute('data-scrape-hidden', '');
        }
      }
    })
    .catch(() => {});
}

/**
 * Scroll to the bottom `passes` times, giving the page a moment to append.
 *
 * Stops early when the height stops growing — a finite page is done, and there
 * is no point paying for the remaining passes.
 */
async function scrollThrough(page: Page, passes: number, deadline: number): Promise<void> {
  let previousHeight = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    if (Date.now() >= deadline) return;
    const height = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.body.scrollHeight;
    });

    if (height === previousHeight) return;
    previousHeight = height;

    await page.waitForTimeout(Math.max(1, Math.min(500, deadline - Date.now())));
  }
}

function remaining(deadline: number, url: string, timeoutMs: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new FetchTimeoutError(url, timeoutMs);
  return value;
}

async function beforeDeadline<Result>(
  work: Promise<Result>,
  deadline: number,
  url: string,
  timeoutMs: number,
): Promise<Result> {
  const timeout = remaining(deadline, url, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FetchTimeoutError(url, timeoutMs)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
