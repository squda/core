import { describe, expect, it } from 'vitest';
import { extractContent } from '../src/core/extract.js';
import { loadFixture } from './fixtures.js';
import { htmlDocument } from './helpers.js';

/** A page with separate head and body, which only these tests need. */
const page = (bodyHtml: string, headHtml = '') =>
  htmlDocument(`<!doctype html><html><head>${headHtml}</head><body>${bodyHtml}</body></html>`);

/** Text of the extracted HTML, tags removed — what the reader ends up with. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('stripping', () => {
  it('removes scripts, styles, nav, and footer', () => {
    const { html } = extractContent(
      page(`
        <nav>Home About Contact</nav>
        <p>The actual content.</p>
        <script>console.log('tracking')</script>
        <style>body { color: red }</style>
        <footer>Copyright 2026</footer>
      `),
    );

    expect(textOf(html)).toBe('The actual content.');
  });

  // The substring trap: [class*="ad"] also matches "header", "shadow",
  // "loading", and "breadcrumb". Word-boundary matching is what keeps this
  // from deleting the page it is meant to clean.
  it('removes ad containers without touching words that merely contain "ad"', () => {
    const { html } = extractContent(
      page(`
        <div class="header">Header survives</div>
        <div class="ad">Buy now</div>
        <div class="shadow-box">Shadow survives</div>
        <div class="post-loading">Loading survives</div>
        <div id="ad">Also an ad</div>
        <div class="breadcrumb">Breadcrumb survives</div>
      `),
    );

    const text = textOf(html);
    expect(text).toContain('Header survives');
    expect(text).toContain('Shadow survives');
    expect(text).toContain('Loading survives');
    expect(text).toContain('Breadcrumb survives');
    expect(text).not.toContain('Buy now');
    expect(text).not.toContain('Also an ad');
  });

  it('removes cookie banners', () => {
    const { html } = extractContent(
      page(`
        <div class="cookie-consent-wrapper">We value your privacy</div>
        <p>Real words.</p>
      `),
    );

    expect(textOf(html)).toBe('Real words.');
  });
});

describe('title', () => {
  it('prefers <title>', () => {
    const { title } = extractContent(
      page('<h1>Heading</h1>', '<title>Real Title</title><meta property="og:title" content="OG">'),
    );
    expect(title).toBe('Real Title');
  });

  it('falls back to og:title, then to the first h1', () => {
    expect(
      extractContent(page('<h1>Heading</h1>', '<meta property="og:title" content="OG">')).title,
    ).toBe('OG');
    expect(extractContent(page('<h1>Heading</h1>')).title).toBe('Heading');
  });

  it('collapses the whitespace a pretty-printed <title> carries', () => {
    expect(extractContent(page('', '<title>\n  Spread  Out\n</title>')).title).toBe('Spread Out');
  });

  it('is empty when the page offers nothing', () => {
    expect(extractContent(page('<p>No title anywhere.</p>')).title).toBe('');
  });
});

describe('description', () => {
  it('prefers meta description over og:description', () => {
    const { description } = extractContent(
      page(
        '',
        '<meta name="description" content="Meta"><meta property="og:description" content="OG">',
      ),
    );
    expect(description).toBe('Meta');
  });

  it('is null rather than empty when absent', () => {
    expect(extractContent(page('<p>Nothing in head.</p>')).description).toBeNull();
  });
});

describe('strategy selection', () => {
  it('falls back to the body when Readability finds no article', () => {
    const { html, strategy } = extractContent(page('<p>Too short to be an article.</p>'));

    expect(strategy).toBe('body');
    expect(textOf(html)).toBe('Too short to be an article.');
  });

  it('uses Readability on an article-shaped page', () => {
    const paragraph = '<p>' + 'This is a real sentence with real words in it. '.repeat(12) + '</p>';
    const { strategy } = extractContent(page(`<article>${paragraph}${paragraph}</article>`));

    expect(strategy).toBe('readability');
  });
});

describe('against the fixtures', () => {
  it('reads the blog post cleanly', () => {
    const { title, description, html, strategy } = extractContent(loadFixture('blog-post'));

    expect(title).toBe('The WET Codebase — overreacted');
    expect(description).toBe('Come waste your time with me.');
    expect(strategy).toBe('readability');
    expect(textOf(html)).toContain('Violations of DRY');
  });

  it('reads Wikipedia, which has no meta description', () => {
    const { title, description, html } = extractContent(loadFixture('wikipedia'));

    expect(title).toBe('Web scraping - Wikipedia');
    expect(description).toBeNull();
    expect(textOf(html).length).toBeGreaterThan(20_000);
  });

  it('strips MDN down to a fraction of the page it arrived as', () => {
    const doc = loadFixture('docs-page');
    const { title, html } = extractContent(doc);

    expect(title).toContain('MDN');
    expect(html.length).toBeLessThan(doc.html.length / 2);
  });

  it('gets almost nothing out of a client-rendered page — this is why Phase 2 exists', () => {
    const { title, html, strategy } = extractContent(loadFixture('spa-empty-root'));

    expect(strategy).toBe('body');
    expect(textOf(html).length).toBeLessThan(100);
    // The <head> still has metadata even when the body is empty, which is
    // exactly the signal Phase 2's selector will use to decide to re-fetch.
    expect(title).toBe('Excalidraw Whiteboard');
  });

  /**
   * Recorded on purpose: this pipeline is prose-only. Readability keeps the
   * <form> and its <label>s but throws away every <input> — so Phase 4 must
   * walk the raw HtmlDocument itself rather than reusing extractContent.
   */
  it('destroys form structure, which Phase 4 needs to know', () => {
    const doc = loadFixture('form-page');
    const { html } = extractContent(doc);

    expect(doc.html).toContain('<input');
    expect(html).toContain('<form');
    expect(html).not.toContain('<input');
  });
});
