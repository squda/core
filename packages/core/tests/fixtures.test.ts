import { describe, expect, it } from 'vitest';
import { fixtureFileNames, fixtureNames, loadFixture } from './fixtures.js';

/**
 * Guards the fixture set itself. Cheap, and it fails the moment a page is
 * added to fixtures/ without a manifest row — which would otherwise show up
 * much later as a confusing missing-file error inside an extraction test.
 */
describe('fixtures', () => {
  it('has exactly one manifest row for every captured HTML file', () => {
    expect([...fixtureNames].sort()).toEqual(fixtureFileNames);
    expect(new Set(fixtureNames).size).toBe(fixtureNames.length);
  });

  it('covers the page shapes Phase 1 needs', () => {
    expect(fixtureNames).toEqual(
      expect.arrayContaining(['blog-post', 'docs-page', 'wikipedia', 'form-page']),
    );
  });

  it.each(fixtureNames)('%s loads as an HtmlDocument with html in it', (name) => {
    const doc = loadFixture(name);

    expect(doc.html).toContain('<html');
    expect(doc.html.length).toBeGreaterThan(500);
    expect(doc.contentType).toMatch(/html/);
    expect(doc.status).toBe(200);
  });

  // The reason Phase 2 exists. If this ever stops being true the fixture was
  // re-fetched from a site that started server-rendering, and it no longer
  // proves what it is here to prove.
  it('spa-empty-root really has nothing in its root div', () => {
    expect(loadFixture('spa-empty-root').html).toContain('<div id="root"></div>');
  });

  it('throws a helpful error for an unknown fixture', () => {
    expect(() => loadFixture('nope')).toThrow(/no fixture named nope/);
  });
});
