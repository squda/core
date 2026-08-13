import { fetchPage } from './request.js';
import type { FetchOptions, FetchStrategy } from './strategy.js';
import type { HtmlDocument } from '../core/types.js';

/**
 * Phase 1's fetchPage, wearing the Phase 2 interface.
 *
 * Deliberately thin — the retrofit is supposed to be boring. If putting the
 * existing code behind the interface had required changing the existing code,
 * the interface would be describing something other than what we already do.
 */
export class HttpStrategy implements FetchStrategy {
  readonly name = 'http';

  constructor(private readonly defaults: FetchOptions = {}) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<HtmlDocument> {
    return fetchPage(url, { ...this.defaults, ...options });
  }

  /** Nothing to release: `fetch` holds no handle between calls. */
  async close(): Promise<void> {}
}
