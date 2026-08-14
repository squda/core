import { describe, expect, it } from 'vitest';
import { InvalidUrlError } from '../src/core/errors.js';
import { normaliseUrl, toAbsoluteUrl } from '../src/core/url.js';

/**
 * Keep adding cases here as you find real URLs that break things.
 */
describe('normaliseUrl', () => {
  it('keeps a already-clean url intact', () => {
    expect(normaliseUrl('https://example.com/posts/hello')).toBe('https://example.com/posts/hello');
  });

  it('strips the fragment', () => {
    expect(normaliseUrl('https://example.com/docs#installation')).toBe('https://example.com/docs');
  });

  it('lowercases the host but not the path', () => {
    expect(normaliseUrl('https://EXAMPLE.com/Posts/Hello')).toBe('https://example.com/Posts/Hello');
  });

  it('assumes https when no scheme is given', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com/');
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<h1>hi',
    'not a url',
    '',
    '   ',
  ])('rejects %s', (bad) => {
    expect(() => normaliseUrl(bad)).toThrow(InvalidUrlError);
  });

  it('rejects a scheme-less string that is not a hostname', () => {
    expect(() => normaliseUrl('not_a_url')).toThrow(InvalidUrlError);
  });

  it('allows scheme-less localhost', () => {
    expect(normaliseUrl('localhost:3000/health')).toBe('https://localhost:3000/health');
  });

  it('lowercases the scheme', () => {
    expect(normaliseUrl('HTTPS://Example.com/Docs')).toBe('https://example.com/Docs');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('strips credentials', () => {
    expect(normaliseUrl('https://user:pw@example.com/a')).toBe('https://example.com/a');
  });

  // The step-3 decision: tracking params identify the referral, not the page.
  it('strips tracking params, leaving no empty ?', () => {
    expect(normaliseUrl('https://example.com/post?utm_source=twitter&fbclid=abc')).toBe(
      'https://example.com/post',
    );
  });

  it('keeps params it does not recognise', () => {
    expect(normaliseUrl('https://example.com/p?utm_campaign=spring&id=42')).toBe(
      'https://example.com/p?id=42',
    );
  });

  it('sorts params so the cache key is order-independent', () => {
    expect(normaliseUrl('https://example.com/s?b=2&a=1')).toBe('https://example.com/s?a=1&b=2');
  });

  it('preserves the order of duplicate keys', () => {
    expect(normaliseUrl('https://example.com/s?tag=z&tag=a')).toBe(
      'https://example.com/s?tag=z&tag=a',
    );
  });
});

describe('toAbsoluteUrl', () => {
  const base = 'https://example.com/docs/guide/intro';

  it('resolves a root-relative path', () => {
    expect(toAbsoluteUrl('/about', base)).toBe('https://example.com/about');
  });

  it('resolves a relative path against the containing directory', () => {
    expect(toAbsoluteUrl('../setup', base)).toBe('https://example.com/docs/setup');
  });

  it('leaves an absolute url alone', () => {
    expect(toAbsoluteUrl('https://other.test/x', base)).toBe('https://other.test/x');
  });

  // Asymmetric with normaliseUrl on purpose: an anchor is a real destination
  // for a link, even though it is not a distinct page to fetch.
  it('keeps the fragment on a same-page anchor', () => {
    expect(toAbsoluteUrl('#installation', base)).toBe(
      'https://example.com/docs/guide/intro#installation',
    );
  });

  it.each(['mailto:hi@example.com', 'tel:+15550100', 'javascript:void(0)', '', '   '])(
    'returns null for %s',
    (href) => {
      expect(toAbsoluteUrl(href, base)).toBeNull();
    },
  );
});
