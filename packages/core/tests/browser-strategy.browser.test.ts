import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserStrategy, CONTAINER_CHROMIUM_ARGS } from '../src/fetching/browser.js';
import { HttpStrategy } from '../src/fetching/http.js';
import {
  FetchTimeoutError,
  HttpStatusError,
  UnsupportedContentTypeError,
  NetworkError,
} from '../src/core/errors.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { describeFetchStrategyContract } from './strategy-contract.js';
import { startTestServer, type TestServer } from './test-server.js';

/**
 * Runs a real Chromium against a real local server, so it is slower than the
 * rest of the suite and lives outside `pnpm test`. Run it with
 * `pnpm test:browser`.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('BrowserStrategy satisfies the FetchStrategy contract', () => {
  describeFetchStrategyContract(async () => ({
    strategy: new BrowserStrategy(),
    url: `${server.origin}/`,
    expectedHtml: 'Static Article',
  }));
});

describe('the reason this class exists', () => {
  it('sees content that only exists after JavaScript runs', async () => {
    const browser = new BrowserStrategy();
    try {
      const doc = await browser.fetch(`${server.origin}/spa`);
      expect(doc.html).toContain('Rendered By JavaScript');
    } finally {
      await browser.close();
    }
  });

  // Compared through the pipeline, not on raw HTML: the words *are* in the
  // response, sitting inside a <script> as source code. What differs is
  // whether they are content, and only extraction can answer that.
  it('while the HTTP path gets nothing a reader would want', async () => {
    const http = new HttpStrategy();
    const scraped = scrapeHtml(await http.fetch(`${server.origin}/spa`));
    await http.close();

    expect(scraped.markdown).not.toContain('Rendered By JavaScript');
    expect(scraped.markdown.length).toBeLessThan(20);
  });

  // The payoff of the seam: the same downstream code, both strategies.
  it('feeds the identical pipeline, producing real markdown from an SPA', async () => {
    const browser = new BrowserStrategy();
    try {
      const scraped = scrapeHtml(await browser.fetch(`${server.origin}/spa`));

      expect(scraped.title).toBe('Client Rendered');
      expect(scraped.markdown).toContain('# Rendered By JavaScript');
      expect(scraped.markdown).toContain('did not exist in the HTML response');
    } finally {
      await browser.close();
    }
  });
});

describe('the failure modes real pages have', () => {
  // A consent overlay commonly renders *instead of* the article. Without a
  // click, the page we scrape is the banner.
  it('dismisses a consent banner and reads what was behind it', async () => {
    const strategy = new BrowserStrategy();
    try {
      const scraped = scrapeHtml(await strategy.fetch(`${server.origin}/consent`));

      expect(scraped.markdown).toContain('Behind The Banner');
      expect(scraped.markdown).toContain('only readable once the consent banner');
    } finally {
      await strategy.close();
    }
  });

  it('leaves the banner alone when asked not to touch it', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/consent`, { dismissConsent: false });

      expect(doc.html).toContain('id="cookie-banner"');
    } finally {
      await strategy.close();
    }
  });

  it('reads a page that never goes idle, instead of timing out on it', async () => {
    const strategy = new BrowserStrategy();
    try {
      // Well under the 30s a polling page would otherwise burn.
      const scraped = scrapeHtml(
        await strategy.fetch(`${server.origin}/never-idle`, { timeoutMs: 3_000 }),
      );

      expect(scraped.title).toBe('Never Idle');
      expect(scraped.markdown).toContain('never stops talking to the server');
    } finally {
      await strategy.close();
    }
  });

  /**
   * The fallback used to get a full fresh timeout of its own, so `timeoutMs`
   * meant "up to twice this". Nobody notices until something upstream enforces
   * the number you passed: on Lambda a 30s budget produced a 60.3s invocation
   * against a 60s limit, which reads as a hung page and is arithmetic.
   *
   * A polling page is the case that takes both attempts, so it is the one that
   * has to stay inside the budget.
   */
  it('spends one budget across both navigation attempts, not two', async () => {
    const strategy = new BrowserStrategy();
    try {
      const started = Date.now();
      await strategy.fetch(`${server.origin}/never-idle`, { timeoutMs: 3_000 });
      const elapsed = Date.now() - started;

      // Generous headroom for the browser launch and the expansion pass; the
      // point is that it is nowhere near 6_000.
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await strategy.close();
    }
  });

  it('collects more of an infinite feed when given scroll passes', async () => {
    const strategy = new BrowserStrategy();
    try {
      const without = await strategy.fetch(`${server.origin}/infinite`, { timeoutMs: 5_000 });
      const with_ = await strategy.fetch(`${server.origin}/infinite`, {
        timeoutMs: 5_000,
        scrollPasses: 3,
      });

      expect(countItems(with_.html)).toBeGreaterThan(countItems(without.html));
    } finally {
      await strategy.close();
    }
  });

  it('stops scrolling early when the page stops growing', async () => {
    const strategy = new BrowserStrategy();
    try {
      const started = Date.now();
      // A finite page: 20 passes must not cost 20 waits.
      await strategy.fetch(`${server.origin}/`, { scrollPasses: 20 });

      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await strategy.close();
    }
  });
});

function countItems(html: string): number {
  return (html.match(/of an endless feed/g) ?? []).length;
}

describe('lifecycle', () => {
  it('launches one browser and reuses it across fetches', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const strategy = new BrowserStrategy();

    try {
      await strategy.fetch(`${server.origin}/`);
      await strategy.fetch(`${server.origin}/spa`);

      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await strategy.close();
      launch.mockRestore();
    }
  });

  it('shares one launch between concurrent fetches', async () => {
    const launch = vi.spyOn(chromium, 'launch');
    const strategy = new BrowserStrategy();

    try {
      await Promise.all([strategy.fetch(`${server.origin}/`), strategy.fetch(`${server.origin}/`)]);

      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await strategy.close();
      launch.mockRestore();
    }
  });

  it('launches again after being closed', async () => {
    const strategy = new BrowserStrategy();

    await strategy.fetch(`${server.origin}/`);
    await strategy.close();

    await expect(strategy.fetch(`${server.origin}/`)).resolves.toMatchObject({ status: 200 });
    await strategy.close();
  });
});

describe('failures map to the same taxonomy as the HTTP path', () => {
  it('throws HttpStatusError on a 404', async () => {
    const strategy = new BrowserStrategy();
    const error = await strategy.fetch(`${server.origin}/missing`).catch((e: unknown) => e);
    await strategy.close();

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ kind: 'http-status', status: 404 });
  });

  it('throws UnsupportedContentTypeError on a PDF', async () => {
    const strategy = new BrowserStrategy();
    const error = await strategy.fetch(`${server.origin}/paper.pdf`).catch((e: unknown) => e);
    await strategy.close();

    expect(error).toBeInstanceOf(UnsupportedContentTypeError);
  });

  it('throws FetchTimeoutError on a page that never responds', async () => {
    const strategy = new BrowserStrategy();
    const error = await strategy
      .fetch(`${server.origin}/hang`, { timeoutMs: 1000 })
      .catch((e: unknown) => e);
    await strategy.close();

    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect(error).toMatchObject({ kind: 'timeout', timeoutMs: 1000 });
  });

  it('throws NetworkError when the host does not resolve', async () => {
    const strategy = new BrowserStrategy();
    const error = await strategy.fetch('http://does-not-exist.invalid/').catch((e: unknown) => e);
    await strategy.close();

    expect(error).toBeInstanceOf(NetworkError);
  });

  it('follows a redirect and reports where it landed', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/moved`);

      expect(doc.url).toBe(`${server.origin}/moved`);
      expect(doc.finalUrl).toBe(`${server.origin}/`);
    } finally {
      await strategy.close();
    }
  });
});

describe('content that is only there after a click', () => {
  it('opens tabs, accordions and details, and keeps what each revealed', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/disclosures`);
      const markdown = scrapeHtml(doc).markdown;

      // The tab that was open on arrival.
      expect(markdown).toContain('OverviewOnly');
      // The two that were not — and whose panels the page unmounts as soon as
      // another tab opens, so these only survive if they were collected while
      // on screen rather than read off the final DOM.
      expect(markdown).toContain('EligibilityOnly');
      expect(markdown).toContain('DocumentsOnly');
      // aria-expanded, and <details>.
      expect(markdown).toContain('AccordionOnly');
      expect(markdown).toContain('DetailsOnly');
    } finally {
      await strategy.close();
    }
  });

  /**
   * The accordion's panel stays in the DOM once opened, so the copy taken to
   * rescue it from being unmounted is a copy of something that was never lost.
   * Keeping both prints the section twice, which reads as a scraper bug rather
   * than a quirk of the page.
   */
  it('prints each revealed section once', async () => {
    const strategy = new BrowserStrategy();
    try {
      const markdown = scrapeHtml(await strategy.fetch(`${server.origin}/disclosures`)).markdown;

      for (const marker of ['OverviewOnly', 'EligibilityOnly', 'DocumentsOnly', 'AccordionOnly']) {
        expect(markdown.split(marker)).toHaveLength(2);
      }
    } finally {
      await strategy.close();
    }
  });

  /**
   * The test that matters most here. "Sign out" is a plain button with plain
   * text and no disclosure attribute — indistinguishable from "Show more" to
   * any rule loose enough to catch phrasing. It must never be clicked.
   */
  it('leaves alone a button that never said it reveals anything', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/disclosures`);
      const markdown = scrapeHtml(doc).markdown;

      // Compared through the pipeline, like the SPA test above and for the same
      // reason: the word is in the raw HTML either way, sitting in the onclick
      // handler as source. What matters is whether it became the page.
      expect(markdown).not.toContain('SignedOutNow');
      expect(markdown).toContain('Sign out');
      // Clicking it would have replaced the whole body.
      expect(markdown).toContain('Behind A Click');
    } finally {
      await strategy.close();
    }
  });

  it('can be turned off', async () => {
    const strategy = new BrowserStrategy();
    try {
      const markdown = scrapeHtml(
        await strategy.fetch(`${server.origin}/disclosures`, { expand: false }),
      ).markdown;

      expect(markdown).toContain('OverviewOnly');
      expect(markdown).not.toContain('EligibilityOnly');
    } finally {
      await strategy.close();
    }
  });

  // A page with nothing to open must not pay for the pass, and must not have
  // its markup altered by it — no stash element, no marker attributes.
  it('changes nothing on a page with no disclosures', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/`);

      expect(doc.html).toContain('Static Article');
      expect(doc.html).not.toContain('scrape-revealed');
      expect(doc.html).not.toContain('data-scrape-expanded');
    } finally {
      await strategy.close();
    }
  });
});

describe('dialogs the page ships but does not show', () => {
  it('keeps them out of the markdown', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/hidden-dialogs`);
      const markdown = scrapeHtml(doc).markdown;

      // display: none, and visibility: hidden — both applied by a stylesheet,
      // which is what extraction cannot see on its own.
      expect(markdown).not.toContain('SomethingWentWrong');
      expect(markdown).not.toContain('AreYouSure');
      // Declared a dialog, so its position does not matter.
      expect(markdown).not.toContain('PleaseSignIn');
      expect(markdown).toContain('Real Article');
    } finally {
      await strategy.close();
    }
  });

  /**
   * The rule this is narrow for. Collapsed content is hidden too, and most of
   * it is real — myscheme.gov.in builds its FAQ from divs with no role and no
   * `aria-expanded`, so the expander cannot open them. Dropping every hidden
   * element took all nine answers with it, which is silent loss of exactly the
   * content someone came for. An overlay is out of the flow; this is not.
   */
  it('keeps collapsed content that nothing marks as expandable', async () => {
    const strategy = new BrowserStrategy();
    try {
      const markdown = scrapeHtml(await strategy.fetch(`${server.origin}/hidden-dialogs`)).markdown;

      expect(markdown).toContain('CollapsedAnswer');
    } finally {
      await strategy.close();
    }
  });

  /**
   * The invariant that makes marking the right move instead of removing:
   * `html` stays what the browser had, so Phase 4 still finds hidden inputs.
   * Deleting them here would break form extraction from two rooms away.
   */
  it('leaves the document itself intact for the form walker', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/hidden-dialogs`);

      expect(doc.html).toContain('name="csrf"');
      expect(doc.html).toContain('SomethingWentWrong');
    } finally {
      await strategy.close();
    }
  });

  it('marks nothing on a page where everything is visible', async () => {
    const strategy = new BrowserStrategy();
    try {
      const doc = await strategy.fetch(`${server.origin}/`);

      expect(doc.html).not.toContain('data-scrape-hidden');
    } finally {
      await strategy.close();
    }
  });
});

describe('launch flags for a container', () => {
  // --no-sandbox is what a hardened runtime needs and a laptop does not, so it
  // has to be provable that passing it still produces a working browser.
  it('launches and fetches with the container flags applied', async () => {
    const strategy = new BrowserStrategy({ launchArgs: CONTAINER_CHROMIUM_ARGS });
    try {
      const doc = await strategy.fetch(`${server.origin}/`);

      expect(doc.status).toBe(200);
      expect(doc.html).toContain('Static Article');
    } finally {
      await strategy.close();
    }
  });
});
