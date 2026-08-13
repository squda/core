import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { extractFeeds, extractStructured } from '../src/structured.js';
import { extractContent } from '../src/extract.js';
import { scrapeHtml } from '../src/scrape.js';
import type { HtmlDocument } from '../src/types.js';
import { loadFixture } from './fixtures.js';

function ldPage(...blocks: unknown[]): cheerio.CheerioAPI {
  const scripts = blocks
    .map((block) =>
      typeof block === 'string'
        ? `<script type="application/ld+json">${block}</script>`
        : `<script type="application/ld+json">${JSON.stringify(block)}</script>`,
    )
    .join('');
  return cheerio.load(`<html><head>${scripts}</head><body></body></html>`);
}

function page(html: string): HtmlDocument {
  return {
    url: 'https://example.com/p',
    fetchedWith: 'http',
    finalUrl: 'https://example.com/p',
    html,
    contentType: 'text/html',
    status: 200,
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('json-ld', () => {
  it('reads the fields a page declares about itself', () => {
    const structured = extractStructured(
      ldPage({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: 'A Declared Title',
        description: 'What the publisher says it is about.',
        author: { '@type': 'Person', name: 'Ada Lovelace' },
        datePublished: '2026-03-01T09:00:00Z',
      }),
    );

    expect(structured).toEqual({
      type: 'BlogPosting',
      headline: 'A Declared Title',
      description: 'What the publisher says it is about.',
      author: 'Ada Lovelace',
      datePublished: '2026-03-01T09:00:00Z',
      articleBody: null,
    });
  });

  it.each([
    ['a bare string', 'Ada Lovelace'],
    ['an object', { '@type': 'Person', name: 'Ada Lovelace' }],
    ['an array', [{ name: 'Ada Lovelace' }, { name: 'Someone Else' }]],
  ])('takes the author as %s', (_label, author) => {
    expect(extractStructured(ldPage({ '@type': 'Article', author }))?.author).toBe('Ada Lovelace');
  });

  it('unwraps the @graph container publishers nest things in', () => {
    const structured = extractStructured(
      ldPage({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'The Site' },
          { '@type': 'NewsArticle', headline: 'The Actual Article' },
        ],
      }),
    );

    expect(structured).toMatchObject({ type: 'NewsArticle', headline: 'The Actual Article' });
  });

  it('prefers the article over the site wrapper around it', () => {
    const structured = extractStructured(
      ldPage(
        { '@type': 'WebSite', name: 'The Site' },
        { '@type': 'Article', headline: 'The Post' },
      ),
    );

    expect(structured?.headline).toBe('The Post');
  });

  // CMS templates emit broken JSON constantly. One bad block is not a reason
  // to lose the good one next to it.
  it('skips a malformed block and keeps the rest', () => {
    const structured = extractStructured(
      ldPage('{ "@type": "Article", oops', { '@type': 'Article', headline: 'Survived' }),
    );

    expect(structured?.headline).toBe('Survived');
  });

  it('is null when the page declares nothing', () => {
    expect(extractStructured(cheerio.load('<html><body><p>Hi</p></body></html>'))).toBeNull();
  });
});

describe('feeds', () => {
  const $ = cheerio.load(`<head>
    <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://cdn.test/atom">
    <link rel="alternate" hreflang="fr" href="/fr/">
    <link rel="stylesheet" href="/style.css">
  </head>`);

  it('finds rss and atom links, resolved absolute', () => {
    expect(extractFeeds($, 'https://example.com/blog/post')).toEqual([
      { url: 'https://example.com/feed.xml', title: 'Posts', kind: 'rss' },
      { url: 'https://cdn.test/atom', title: 'ATOM', kind: 'atom' },
    ]);
  });

  it('ignores alternates that are not feeds', () => {
    const urls = extractFeeds($, 'https://example.com/').map((feed) => feed.url);

    expect(urls).not.toContain('https://example.com/fr/');
  });
});

describe('as a content fallback', () => {
  // The publisher's own copy beats a dump of <body> — which, by this point, is
  // a page we already failed to find the content in.
  it('uses articleBody when Readability finds nothing', () => {
    const body = 'The declared article body. '.repeat(20);
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Article',
      headline: 'Declared',
      articleBody: body,
    })}</script></head><body><div id="app"></div></body></html>`;

    const extracted = extractContent(page(html));

    expect(extracted.strategy).toBe('json-ld');
    expect(scrapeHtml(page(html)).markdown).toContain('The declared article body.');
  });

  it('escapes html in the declared body rather than trusting it', () => {
    const body = '<script>alert(1)</script> '.repeat(20);
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Article',
      articleBody: body,
    })}</script></head><body><div id="root"></div></body></html>`;

    expect(extractContent(page(html)).html).not.toContain('<script>');
  });
});

describe('against the real fixtures', () => {
  it('reads Wikipedia’s declared article data', () => {
    const scraped = scrapeHtml(loadFixture('wikipedia'));

    expect(scraped.structured).toMatchObject({ type: 'Article' });
    expect(scraped.structured?.headline).toContain('data scraping');
  });

  it('finds the feed MDN advertises', () => {
    expect(scrapeHtml(loadFixture('docs-page')).feeds).toHaveLength(1);
  });

  it('is null and empty on pages that declare nothing', () => {
    const scraped = scrapeHtml(loadFixture('form-page'));

    expect(scraped.structured).toBeNull();
    expect(scraped.feeds).toEqual([]);
  });

  it('leaves the existing title alone when a page has both', () => {
    // <title> still wins: JSON-LD is a fallback, not an override.
    expect(scrapeHtml(loadFixture('wikipedia')).title).toBe('Web scraping - Wikipedia');
  });
});
