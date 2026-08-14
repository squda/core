/**
 * Phase 3, step 5 — backpressure, in about thirty lines.
 *
 * Runs at most `max` tasks at once and queues the rest. No dependency: the
 * whole idea is a counter and a list of waiting resolvers, and writing it once
 * by hand is worth more than importing p-limit and never seeing the shape.
 */
export class Limiter {
  readonly #max: number;
  #active = 0;
  /** Resolvers for callers parked until a slot frees up. FIFO. */
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`concurrency limit must be a positive integer, got ${max}`);
    }
    this.#max = max;
  }

  get max(): number {
    return this.#max;
  }

  /** How many tasks are running right now. */
  get active(): number {
    return this.#active;
  }

  /** How many callers are parked waiting for a slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }

    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      // Hand the slot on even when the task threw — a limiter that leaks a
      // slot per failure deadlocks after `max` errors, and only under load.
      this.#waiting.shift()?.();
    }
  }
}
