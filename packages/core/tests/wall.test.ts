import { describe, expect, it } from 'vitest';
import { detectWall } from '../src/core/wall.js';
import { scrapeHtml } from '../src/core/scrape.js';
import { fixtureNames, loadFixture } from './fixtures.js';
import type { Link } from '../src/core/types.js';

function links(...pairs: [string, string][]): Link[] {
  return pairs.map(([href, text]) => ({ href, text }));
}

describe('against the real fixtures', () => {
  // The tests that matter. A detector that cries wolf on real pages is worse
  // than no detector, because it makes you distrust the true positives — and
  // every page in this set is real.
  it.each(fixtureNames)('leaves %s alone', (name) => {
    expect(scrapeHtml(loadFixture(name)).wall).toBeNull();
  });

  /**
   * thin-profile is x.com logged out: 303 characters of real profile, well
   * under the 2,000-character THIN floor. It is the exact shape a careless rule
   * flags — a page with almost nothing on it — which is why it is in the set.
   *
   * Note what this fixture no longer proves. When it was captured in Phase 1 it
   * also carried `Log in` and `Sign up` links in its nav, and the pairing of
   * thinness *with* auth links was the trap it was chosen for. Today's x.com
   * ships neither link in the initial HTML, so that half is covered only by the
   * constructed cases below. Worth knowing before trusting this file to prove
   * more than it does.
   */
  it('leaves a thin real page alone', () => {
    const scraped = scrapeHtml(loadFixture('thin-profile'));

    expect(scraped.markdown.length).toBeLessThan(2000);
    expect(scraped.wall).toBeNull();
  });
});

/** Synthetic. No real wall turned up in the survey — see src/wall.ts. */

describe('login walls (constructed)', () => {
  it('spots a page made mostly of auth links', () => {
    const wall = detectWall({
      title: 'Dan (@dan_abramov) / X',
      markdown: 'Log in Sign up',
      links: links(
        ['https://x.com/i/flow/login', 'Log in'],
        ['https://x.com/i/flow/signup', 'Sign up'],
        ['https://x.com/home', 'Home'],
      ),
    });

    expect(wall).toMatchObject({ kind: 'login' });
  });

  it('spots a page that calls itself a login page', () => {
    const wall = detectWall({
      title: 'Sign in to GitHub',
      markdown: 'Username Password Forgot password?',
      links: [],
    });

    expect(wall).toMatchObject({ kind: 'login' });
  });

  it('needs more than one auth link', () => {
    const wall = detectWall({
      title: 'A short note',
      markdown: 'A brief post with a link to the login page at the bottom.',
      links: links(['https://site.test/login', 'Log in'], ['https://site.test/about', 'About']),
    });

    expect(wall).toBeNull();
  });

  // A long article about authentication is a long article.
  it('ignores a substantial page no matter how much it talks about logging in', () => {
    const wall = detectWall({
      title: 'How we rebuilt sign in',
      markdown: 'Log in. Sign up. Register. '.repeat(200),
      links: links(['https://site.test/login', 'Log in'], ['https://site.test/signup', 'Sign up']),
    });

    expect(wall).toBeNull();
  });
});

describe('bot checks and consent screens (constructed)', () => {
  it.each([
    'Just a moment...',
    'Attention Required! | Cloudflare',
    'Checking your browser before accessing the site',
    'Verify you are human',
  ])('spots %s', (text) => {
    expect(detectWall({ title: text, markdown: text, links: [] })).toMatchObject({
      kind: 'captcha',
    });
  });

  it('spots a consent screen standing in for the page', () => {
    const wall = detectWall({
      title: 'Before you continue to YouTube',
      markdown: 'We value your privacy. Accept all cookies to continue.',
      links: [],
    });

    expect(wall).toMatchObject({ kind: 'consent' });
  });

  it('ignores a cookie notice on a page that also has content', () => {
    const wall = detectWall({
      title: 'A real article',
      markdown: 'We value your privacy. ' + 'Here is the actual article text. '.repeat(100),
      links: [],
    });

    expect(wall).toBeNull();
  });
});
