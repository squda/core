import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/limit.js';
import { deferred } from './helpers.js';

describe('Limiter', () => {
  it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s', (max) => {
    expect(() => new Limiter(max)).toThrow(RangeError);
  });

  it('runs a task and returns its value', async () => {
    await expect(new Limiter(1).run(async () => 'done')).resolves.toBe('done');
  });

  it('never runs more than the limit at once', async () => {
    const limiter = new Limiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const tasks = gates.map((gate) =>
      limiter.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(2);

    for (const gate of gates) gate.resolve();
    await Promise.all(tasks);

    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
  });

  it('starts queued tasks in the order they arrived', async () => {
    const limiter = new Limiter(1);
    const started: number[] = [];
    const gate = deferred();

    const first = limiter.run(async () => {
      started.push(1);
      await gate.promise;
    });
    const second = limiter.run(async () => void started.push(2));
    const third = limiter.run(async () => void started.push(3));

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(started).toEqual([1, 2, 3]);
  });

  // A limiter that keeps a slot when a task throws deadlocks after `max`
  // failures — and only ever under load, which is the worst way to find out.
  it('frees the slot when a task throws', async () => {
    const limiter = new Limiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(limiter.active).toBe(0);
    await expect(limiter.run(async () => 'still works')).resolves.toBe('still works');
  });

  it('survives a burst larger than the queue it has ever seen', async () => {
    const limiter = new Limiter(3);
    let peak = 0;
    let running = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        limiter.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running -= 1;
          return index;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(50);
    expect(results[49]).toBe(49);
  });
});
