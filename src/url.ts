import { InvalidUrlError } from './errors.js';

/**
 * Phase 1, step 3 — validate and normalise input URLs.
 *
 * Normalisation matters more than it looks: in Phase 3 the normalised URL
 * becomes the cache key, so "same page" has to mean the same string here.
 */

/**
 * Anything that looks like `scheme:` at the start.
 *
 * The negative lookahead is the `localhost:3000` case: `scheme:` and `host:port`
 * are the same shape, so a colon followed by digits is read as a port and the
 * string is treated as scheme-less. Without it `localhost:3000/health` parses as
 * the scheme `localhost:` and gets rejected.
 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/;

/**
 * Query parameters stripped during normalisation.
 *
 * DECISION (Phase 1 step 3): tracking parameters are removed, everything else
 * is kept. They identify the *referral*, not the page — `?utm_source=twitter`
 * and `?utm_source=rss` are the same document, and keeping them would mean
 * caching it twice in Phase 3. Params we don't recognise stay, because a
 * stripped `?id=42` silently fetches the wrong page, which is much worse than
 * a duplicate cache entry.
 *
 * Anything matching `utm_*` goes too — the prefix is an open set.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'referrer',
  '_ga',
  '_gl',
  'yclid',
  'twclid',
  'ttclid',
  'si',
]);

/**
 * Normalise a user-supplied URL into the canonical string we fetch and cache by.
 *
 * - rejects anything that isn't http(s) — `javascript:`, `file:`, `data:`
 * - assumes https when no scheme is given
 * - lowercases the host, keeps the path's case (paths are case-sensitive)
 * - drops the fragment, credentials, and tracking params
 * - sorts the remaining query params so `?b=2&a=1` and `?a=1&b=2` cache as one
 *
 * @throws {InvalidUrlError}
 */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidUrlError(input, 'empty');

  const hadScheme = HAS_SCHEME.test(trimmed);
  const candidate = hadScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidUrlError(input, 'not parseable as a url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(input, `unsupported scheme ${url.protocol}`);
  }

  // `https://not_a_url` parses happily, so a scheme-less input has to look like
  // a hostname before we believe it. localhost is the one dotless host we take.
  if (!hadScheme && !url.hostname.includes('.') && url.hostname !== 'localhost') {
    throw new InvalidUrlError(input, 'no scheme and no hostname');
  }

  url.hash = '';
  url.username = '';
  url.password = '';

  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  // Stable: duplicate keys keep their relative order, which is the one case
  // where query order carries meaning. It also drops a now-empty "?".
  url.searchParams.sort();

  return url.toString();
}

/**
 * Resolve a possibly-relative href against the page it was found on.
 *
 * Returns null for anything we can't turn into a fetchable http(s) URL —
 * `mailto:`, `tel:`, `javascript:`, and junk. markdown.ts drops those links
 * rather than emitting a broken one.
 *
 * Unlike normaliseUrl this *keeps* the fragment: `#installation` is a real
 * destination for a link, even though it isn't a distinct page to fetch.
 */
export function toAbsoluteUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}
