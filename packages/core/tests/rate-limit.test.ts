import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/support/rate-limit.js';

/**
 * Time is injected, so none of these wait for a real window to pass. That is
 * the reason the limiter takes a clock at all.
 */
function at(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows up to the limit and refuses the next one', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: clock.now });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('counts down what is left', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: at().now });

    expect(limiter.check('a').remaining).toBe(2);
    expect(limiter.check('a').remaining).toBe(1);
    expect(limiter.check('a').remaining).toBe(0);
  });

  it('keeps callers apart', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: at().now });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('lets a caller back in once the window slides past their hits', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: clock.now });

    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);

    clock.advance(1001);
    expect(limiter.check('a').allowed).toBe(true);
  });

  /**
   * The reason it slides rather than resetting on a fixed boundary: a fixed
   * window would allow the full quota twice across the instant it turns over.
   */
  it('does not hand back the whole allowance at a boundary', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: clock.now });

    limiter.check('a'); // t=0
    clock.advance(900);
    limiter.check('a'); // t=900

    clock.advance(200); // t=1100 — the first hit has expired, the second has not
    expect(limiter.check('a').allowed).toBe(true); // takes the freed slot
    expect(limiter.check('a').allowed).toBe(false); // and no more
  });

  it('says when to come back, in whole seconds and never zero', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 1, windowMs: 5000, now: clock.now });

    limiter.check('a');
    clock.advance(1000);

    const refused = limiter.check('a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(4);
  });

  /**
   * A refused request must not extend the block, or backing off politely would
   * be punished harder than hammering.
   */
  it('does not record a refused request', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

    limiter.check('a'); // t=0, allowed
    clock.advance(500);
    limiter.check('a'); // t=500, refused — must not be remembered
    clock.advance(501); // t=1001, the only real hit has expired

    expect(limiter.check('a').allowed).toBe(true);
  });

  it('forgets callers who have gone quiet', () => {
    const clock = at();
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: clock.now });

    limiter.check('a');
    limiter.check('b');
    expect(limiter.size).toBe(2);

    clock.advance(1001);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  it('refuses to be constructed with a limit nobody can satisfy', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow(/at least one/);
  });
});
