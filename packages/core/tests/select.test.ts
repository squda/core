import { describe, expect, it } from 'vitest';
import { judge } from '../src/core/select.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { htmlDocument } from './helpers.js';
import { loadFixture } from './fixtures.js';

/** A fetched page, optionally one the browser produced. */
const page = (html: string, fetchedWith: 'http' | 'browser' = 'http') =>
  htmlDocument(html, { fetchedWith });

/** Judge a fixture exactly as scrape() does: fetch result plus what we got out. */
function judgeFixture(name: string) {
  const doc = loadFixture(name);
  return judge(doc, scrapeHtml(doc));
}

describe('against the real fixtures', () => {
  it.each(['blog-post', 'wikipedia', 'docs-page', 'news-article', 'form-page'])(
    'keeps the http result for %s',
    (name) => {
      expect(judgeFixture(name).needsBrowser).toBe(false);
    },
  );

  it('retries the client-rendered page', () => {
    const verdict = judgeFixture('spa-empty-root');

    expect(verdict.needsBrowser).toBe(true);
    expect(verdict.reason).toContain('empty mount point');
  });

  // form-page is the thinnest real page in the set at 181 characters, and the
  // SPA is 12. The threshold has to sit between them, and this is the test
  // that fails if someone moves it too far in either direction.
  it('leaves a gap between the thinnest real page and the empty one', () => {
    const thinnest = scrapeHtml(loadFixture('form-page')).markdown.length;
    const empty = scrapeHtml(loadFixture('spa-empty-root')).markdown.length;

    expect(empty).toBeLessThan(50);
    expect(thinnest).toBeGreaterThan(150);
  });
});

describe('mount points', () => {
  it.each(['root', 'app', '__next', '__nuxt'])('spots an empty #%s', (id) => {
    const verdict = judge(page(`<body><div id="${id}"></div></body>`), scrapeHtml(page('')));

    expect(verdict.needsBrowser).toBe(true);
    expect(verdict.reason).toContain(id);
  });

  it('ignores whitespace inside the mount point', () => {
    expect(judge(page('<div id="root">\n  \n</div>'), scrapeHtml(page(''))).needsBrowser).toBe(
      true,
    );
  });

  // A server-rendered React app puts its markup in exactly this element.
  // Retrying those would double the cost of every Next.js page on the web.
  it('leaves a server-rendered mount point alone', () => {
    const html =
      '<html><body><div id="root"><article>' +
      '<p>This came off the wire already rendered, which is what SSR means.</p>'.repeat(4) +
      '</article></div></body></html>';

    expect(judge(page(html), scrapeHtml(page(html))).needsBrowser).toBe(false);
  });
});

describe('other signals', () => {
  it('retries a page that produced almost no markdown', () => {
    const html = '<html><body><p>Hi.</p></body></html>';
    const verdict = judge(page(html), scrapeHtml(page(html)));

    expect(verdict.needsBrowser).toBe(true);
    expect(verdict.reason).toContain('characters of markdown');
  });

  it('retries a page that says it needs JavaScript', () => {
    const html =
      '<html><body><noscript>You need to enable JavaScript to run this app.</noscript>' +
      '<p>A paragraph long enough to clear the thinness threshold on its own, so the only reason left to retry is the noscript banner sitting above it.</p>'.repeat(
        2,
      ) +
      '</body></html>';

    expect(judge(page(html), scrapeHtml(page(html))).reason).toContain('requires JavaScript');
  });

  it('retries a shell that wrapped a hydration payload in chrome', () => {
    const verdict = judgeFixture('spa-hydrated-shell');

    expect(verdict.needsBrowser).toBe(true);
    expect(verdict.reason).toContain('__NEXT_DATA__');
  });

  // The point of the signal. This page defeats all three of the older checks:
  // its mount point holds a loading skeleton so it is not empty, its noscript
  // is an <img> fallback rather than a banner, and its footer alone clears the
  // thinness floor twice over. Without the payload check it reads as a page
  // that said something, when it said nothing at all.
  it('catches a shell that clears the thinness floor on footer text alone', () => {
    const doc = loadFixture('spa-hydrated-shell');
    const scraped = scrapeHtml(doc);

    expect(scraped.markdown.length).toBeGreaterThan(150);
    expect(doc.html).not.toMatch(/<div[^>]*id=["']__next["'][^>]*>\s*<\/div>/i);
    expect(judge(doc, scraped).needsBrowser).toBe(true);
  });

  it('ignores a noscript block that is just a tracking pixel', () => {
    const html =
      '<html><body><noscript><img src="https://analytics.test/p.gif"></noscript>' +
      '<p>A paragraph long enough to clear the thinness threshold on its own, so nothing here should trigger a browser retry at all.</p>'.repeat(
        2,
      ) +
      '</body></html>';

    expect(judge(page(html), scrapeHtml(page(html))).needsBrowser).toBe(false);
  });
});

describe('a strong signal beats a weak one', () => {
  // MDN's noscript is about one widget on a page full of documentation.
  it('ignores a JavaScript banner on a page that already said plenty', () => {
    const doc = loadFixture('docs-page');
    const scraped = scrapeHtml(doc);

    expect(doc.html).toContain('Enable JavaScript');
    expect(scraped.markdown.length).toBeGreaterThan(1000);
    expect(judge(doc, scraped).needsBrowser).toBe(false);
  });

  // Server-rendered Next.js ships __NEXT_DATA__ with the content already in the
  // HTML. Retrying those would put a Chromium behind a large share of the web.
  it('ignores a hydration payload on a page that already said plenty', () => {
    const html =
      '<html><body><div id="__next">' +
      '<p>Server-rendered markup, delivered complete, on a page that also ships a hydration payload so the client can take over.</p>'.repeat(
        12,
      ) +
      '</div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>';
    const scraped = scrapeHtml(page(html));

    expect(scraped.markdown.length).toBeGreaterThan(1000);
    expect(judge(page(html), scraped).needsBrowser).toBe(false);
  });
});

describe('the loop guard', () => {
  it('never asks for a browser twice', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    const verdict = judge(page(html, 'browser'), scrapeHtml(page(html, 'browser')));

    expect(verdict.needsBrowser).toBe(false);
    expect(verdict.reason).toBe('already fetched with a browser');
  });
});

describe('the verdict itself', () => {
  it('explains why it left a page alone, not only why it retried', () => {
    const verdict = judgeFixture('blog-post');

    expect(verdict.reason).toMatch(/\d+ characters of markdown/);
  });
});
