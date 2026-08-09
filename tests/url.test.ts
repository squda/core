import { describe, expect, it } from 'vitest';
import { normaliseUrl } from '../src/url.js';

/**
 * A starter suite so you can see the shape. These are red right now — that's
 * the point. Make them green, then keep adding cases as you find real URLs
 * that break things.
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

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>hi', 'not a url'])(
    'rejects %s',
    (bad) => {
      expect(() => normaliseUrl(bad)).toThrow();
    },
  );
});
