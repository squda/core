import type { HtmlDocument } from './types.js';

/**
 * Phase 1, step 2 — HTTP GET a page. [fetch side]
 *
 * TODO:
 *  - a real User-Agent (a default Node fetch UA gets blocked a lot)
 *  - a timeout — use AbortSignal.timeout(), do not invent your own
 *  - follow redirects, and record where you actually landed in `finalUrl`
 *  - throw a typed error, not a string, on non-2xx or non-HTML content-type.
 *    Phase 2 step 5 builds a real error taxonomy on top of whatever you start here.
 */
export async function fetchPage(url: string): Promise<HtmlDocument> {
  throw new Error('not implemented: fetchPage');
}
