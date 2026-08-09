/**
 * Phase 1, step 3 — validate and normalise input URLs. [fetch side]
 *
 * Normalisation matters more than it looks: in Phase 3 the normalised URL
 * becomes the cache key, so "same page" has to mean the same string here.
 *
 * TODO:
 *  - reject anything that isn't http:// or https:// (javascript:, file:, data:)
 *  - strip the #fragment
 *  - accept "example.com" and assume https
 *  - decide, and write down, what you do with ?utm_source= and friends
 *  - lowercase the host but NOT the path (paths are case-sensitive)
 */
export function normaliseUrl(input: string): string {
  throw new Error('not implemented: normaliseUrl');
}

/** Resolve a possibly-relative href against the page it was found on. */
export function toAbsoluteUrl(href: string, base: string): string | null {
  throw new Error('not implemented: toAbsoluteUrl');
}
