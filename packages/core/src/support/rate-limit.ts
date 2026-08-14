/**
 * A sliding-window rate limiter, keyed by whatever the caller decides identity
 * is.
 *
 * Sliding rather than fixed-window because a fixed window lets someone spend
 * the whole allowance at 11:59:59 and the whole next one at 12:00:00 — twice
 * the intended rate across two seconds, which is exactly the moment the limit
 * was supposed to matter.
 *
 * It knows nothing about HTTP, IP addresses or Hono. It takes a string and a
 * clock, which is what makes it testable without a server or a real minute
 * passing.
 *
 * **This lives in one process's memory.** With two instances behind a load
 * balancer the effective limit doubles. That is a deliberate Phase 9 decision
 * deferred, not an oversight: the demo endpoint it protects is a cost cap
 * rather than a security control, and a shared store can replace this behind
 * the same interface when there is a second instance to worry about.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the oldest hit expires, so a caller can be told when to return. */
  retryAfter: number;
}

export interface RateLimiterOptions {
  /** Hits allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable so tests can move time without waiting for it. */
  now?: () => number;
}

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor({ limit, windowMs, now = Date.now }: RateLimiterOptions) {
    if (limit < 1) throw new Error('rate limit must allow at least one request');
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Records a hit and says whether it is allowed.
   *
   * A refused request is *not* recorded. Otherwise hammering the endpoint would
   * keep pushing the window forward and a caller who backs off politely would
   * be locked out longer than one who does not.
   */
  check(key: string): RateLimitDecision {
    const now = this.#now();
    const cutoff = now - this.#windowMs;

    const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.#hits.set(key, recent);
    return { allowed: true, remaining: this.#limit - recent.length, retryAfter: 0 };
  }

  /**
   * Drops keys with nothing left in the window.
   *
   * Without this the map grows one entry per address seen, forever — the kind
   * of leak that only shows up in production, where the addresses are real.
   */
  sweep(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [key, hits] of this.#hits) {
      const recent = hits.filter((at) => at > cutoff);
      if (recent.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, recent);
    }
  }

  /** Keys currently being tracked. For /health, and for the sweep test. */
  get size(): number {
    return this.#hits.size;
  }
}
