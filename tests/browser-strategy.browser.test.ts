import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserStrategy } from '../src/browser-strategy.js';
import { HttpStrategy } from '../src/http-strategy.js';
import {
  FetchTimeoutError,
  HttpStatusError,
  UnsupportedContentTypeError,
  NetworkError,
} from '../src/errors.js';
import { scrapeHtml } from '../src/scrape.js';
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
