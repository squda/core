import { Limiter } from '../support/limit.js';
import type { FetchStrategy } from './strategy.js';
import type { BrowserFetchOptions } from './browser.js';
import type { HtmlDocument } from '../core/types.js';

/**
 * One browser, shared, with a hard cap on how many pages use it at once.
 *
 * Two problems, one owner. The cap is the plan's step 5 — ten requests must
 * not become ten Chromiums. The sharing fixes something quieter that the
 * strategy selector introduced: it built a *new* BrowserStrategy per retry, so
 * every SPA scrape paid a fresh ~200ms launch even one at a time, and
 * BrowserStrategy's own instance reuse never got a chance to help.
 *
 * Playwright is still imported dynamically, so a process that only ever
 * scrapes static pages never loads it.
 */

export interface BrowserPoolOptions {
  /** Pages open at once. Each is a browser context, not a browser. */
  maxConcurrent?: number;
  /**
   * How long to keep the browser alive after the last page closes.
   *
   * Zero — the default — closes it immediately, which is what a CLI run wants:
   * an open browser keeps handles open and the process would never exit. A
   * long-lived service sets this so consecutive requests skip the launch.
   */
  idleMs?: number;
}

export class BrowserPool {
  readonly #limiter: Limiter;
  readonly #idleMs: number;

  #strategy: FetchStrategy | null = null;
  #starting: Promise<FetchStrategy> | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #launches = 0;

  constructor({ maxConcurrent = 2, idleMs = 0 }: BrowserPoolOptions = {}) {
    this.#limiter = new Limiter(maxConcurrent);
    this.#idleMs = idleMs;
  }

  stats(): { active: number; queued: number; launches: number; open: boolean } {
    return {
      active: this.#limiter.active,
      queued: this.#limiter.queued,
      launches: this.#launches,
      open: this.#strategy !== null,
    };
  }

  async fetch(url: string, options: BrowserFetchOptions = {}): Promise<HtmlDocument> {
    return this.#limiter.run(async () => {
      const strategy = await this.#acquire();
      try {
        return await strategy.fetch(url, options);
      } finally {
        this.#releaseWhenIdle();
      }
    });
  }

  /** Shuts the browser down now, whatever the idle setting says. */
  async close(): Promise<void> {
    this.#cancelIdleTimer();

    const strategy = this.#strategy ?? (await this.#starting);
    this.#strategy = null;
    this.#starting = null;
    await strategy?.close();
  }

  /**
   * Held as a promise while launching, so two callers arriving together share
   * one launch rather than racing to start two browsers.
   */
  async #acquire(): Promise<FetchStrategy> {
    this.#cancelIdleTimer();
    if (this.#strategy) return this.#strategy;

    this.#starting ??= (async () => {
      const { BrowserStrategy } = await import('./browser.js');
      this.#launches += 1;
      return new BrowserStrategy();
    })();

    this.#strategy = await this.#starting;
    this.#starting = null;
    return this.#strategy;
  }

  #releaseWhenIdle(): void {
    if (this.#limiter.active > 1 || this.#limiter.queued > 0) return;

    if (this.#idleMs === 0) {
      void this.close();
      return;
    }

    this.#cancelIdleTimer();
    this.#idleTimer = setTimeout(() => void this.close(), this.#idleMs);
    // Never hold the process open just to keep a browser warm.
    this.#idleTimer.unref();
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }
}

/** What `scrape()` uses when a caller doesn't supply one. CLI-shaped: no idle keep-alive. */
export const defaultBrowserPool = new BrowserPool();
