import { describe, expect, it } from 'vitest';
import { scrapeHtml } from '../src/scrape.js';
import { fixtureNames, loadFixture } from './fixtures.js';

/**
 * The Phase 1 "done when", as a test.
 *
 * scrapeHtml runs everything through ScrapedDocumentSchema, so a fixture that
 * survives this has already proved that every href and img src came out as a
 * valid absolute URL — the Zod parse is the assertion. Parse, don't validate.
 */
describe('scrapeHtml over every fixture', () => {
  it.each(fixtureNames)('%s parses into a ScrapedDocument', (name) => {
    const doc = scrapeHtml(loadFixture(name));

    expect(doc.url).toBe(loadFixture(name).url);
    expect(typeof doc.markdown).toBe('string');
    expect(doc.fetchedAt).toBeInstanceOf(Date);
  });

  it.each(fixtureNames)('%s leaves no relative link in the markdown', (name) => {
    const { markdown } = scrapeHtml(loadFixture(name));

    // `](/foo)` or `](../foo)` — a link target that never got resolved.
    expect(markdown).not.toMatch(/\]\((?:\/|\.\.?\/)/);
  });
});

describe('a real article, end to end', () => {
  it('reads as the page did', () => {
    const doc = scrapeHtml(loadFixture('blog-post'));

    expect(doc.title).toBe('The WET Codebase — overreacted');
    expect(doc.description).toBe('Come waste your time with me.');
    expect(doc.markdown).toContain('> Violations of DRY');
    expect(doc.markdown).toContain(
      '[Don’t Repeat Yourself](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself)',
    );
  });

  it('indexes the links it found', () => {
    const { links } = scrapeHtml(loadFixture('wikipedia'));

    expect(links.length).toBeGreaterThan(100);
    // Absolute, but not necessarily https — old citations link to http:// and
    // rewriting the scheme would be inventing a URL the page never had.
    expect(links.every((link) => /^https?:\/\//.test(link.href))).toBe(true);
    expect(links.some((link) => link.text === '')).toBe(false);
  });

  it('produces nearly nothing for the client-rendered page', () => {
    const doc = scrapeHtml(loadFixture('spa-empty-root'));

    expect(doc.title).toBe('Excalidraw Whiteboard');
    expect(doc.markdown.length).toBeLessThan(100);
    expect(doc.links).toEqual([]);
  });
});
