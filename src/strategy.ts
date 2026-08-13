import type { HtmlDocument } from './types.js';

/**
 * Phase 2, step 2 — the seam between "get me this page" and *how*.
 *
 * The plan sketches this as `fetch(url): Promise<{ html }>`. It returns the
 * full HtmlDocument instead: the browser path knows the final URL, status, and
 * content type just as the HTTP path does, and markdown.ts needs `finalUrl` to
 * resolve links. Narrowing the return type would throw that away and force a
 * second channel to carry it back.
 *
 * The test of this interface is not whether it compiles — it is whether adding
 * BrowserStrategy requires a change to scrape.ts, extract.ts, or markdown.ts.
 * It should not.
 */
export interface FetchStrategy {
  /** Which path ran. Logged per scrape once step 3 adds selection. */
  readonly name: 'http' | 'browser';

  fetch(url: string, options?: FetchOptions): Promise<HtmlDocument>;

  /**
   * Release whatever the strategy holds open.
   *
   * Required, not optional, even though the HTTP implementation has nothing to
   * release. A caller that has to check `strategy.close?.()` will eventually
   * forget, and the thing it forgets to close is a Chromium process.
   */
  close(): Promise<void>;
}

export interface FetchOptions {
  timeoutMs?: number;
  /**
   * Cancels the fetch from outside — a job giving up, a client disconnecting.
   * Separate from `timeoutMs`, which is this fetch's own patience.
   */
  signal?: AbortSignal;
  /**
   * Permit private, loopback and link-local addresses.
   *
   * Off unless `SCRAPE_ALLOW_PRIVATE=1`. Secure by default: a local test
   * server opts in, production never has to remember to opt out.
   */
  allowPrivate?: boolean;
}
