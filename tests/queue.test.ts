import { describe, expect, it, vi } from 'vitest';
import { JobQueue, QueueFullError } from '../src/queue.js';
import { deferred } from './helpers.js';
import { scrapeHtml } from '../src/scrape.js';
import { loadFixture } from './fixtures.js';

const DOCUMENT = scrapeHtml(loadFixture('blog-post'));
const URL_ = 'https://overreacted.io/the-wet-codebase/';

/** Waits for a job to leave the running states. */
async function settle(queue: JobQueue, id: string) {
  await vi.waitFor(() => {
    const job = queue.get(id);
    expect(job?.status === 'done' || job?.status === 'failed').toBe(true);
  });
  return queue.get(id)!;
}

describe('accepting work', () => {
  it('returns a queued job immediately, before the work finishes', async () => {
    const gate = deferred();
    const queue = new JobQueue(async () => {
      await gate.promise;
      return DOCUMENT;
    });

    const job = queue.add(URL_, 'auto');

    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    // 'running' when a slot was free — the work starts synchronously, and add
    // returns without waiting for it. What matters is that it is not finished.
    expect(['queued', 'running']).toContain(job.status);
    expect(job.document).toBeNull();
    expect(job.url).toBe(URL_);

    gate.resolve();
    await settle(queue, job.id);
  });

  it('carries the work through to done, with the document attached', async () => {
    const queue = new JobQueue(async () => DOCUMENT);

    const finished = await settle(queue, queue.add(URL_, 'auto').id);

    expect(finished.status).toBe('done');
    expect(finished.document?.title).toBe('The WET Codebase — overreacted');
    expect(finished.error).toBeNull();
    expect(finished.finishedAt).toBeGreaterThanOrEqual(finished.startedAt!);
  });

  it('passes the url and browser mode to the runner', async () => {
    const run = vi.fn().mockResolvedValue(DOCUMENT);
    const queue = new JobQueue(run);

    await settle(queue, queue.add(URL_, 'always').id);

    expect(run).toHaveBeenCalledWith(URL_, 'always', expect.any(AbortSignal));
  });

  it('hands out a different id per distinct job', () => {
    const queue = new JobQueue(async () => DOCUMENT);

    expect(queue.add(URL_, 'auto').id).not.toBe(queue.add('https://other.test/', 'auto').id);
  });

  it('returns a snapshot, not a live handle', async () => {
    const queue = new JobQueue(async () => DOCUMENT);
    const job = queue.add(URL_, 'auto');
    const statusAtAdd = job.status;

    await settle(queue, job.id);

    // The object handed back at `add` time never changes under the caller.
    expect(job.status).toBe(statusAtAdd);
    expect(job.document).toBeNull();
    expect(queue.get(job.id)?.status).toBe('done');
  });
});

describe('failure', () => {
  // A rejected job must not become an unhandled rejection — that takes the
  // whole process down in Node, over one bad url.
  it('records the failure on the job instead of throwing', async () => {
    const queue = new JobQueue(async () => {
      throw new Error('upstream exploded');
    });

    const failed = await settle(queue, queue.add(URL_, 'auto').id);

    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'internal', message: 'upstream exploded' });
    expect(failed.document).toBeNull();
  });

  it('shapes the error however the caller asked', async () => {
    const queue = new JobQueue(
      async () => {
        throw new Error('nope');
      },
      { describeError: () => ({ code: 'timeout', message: 'took too long' }) },
    );

    const failed = await settle(queue, queue.add(URL_, 'auto').id);

    expect(failed.error).toEqual({ code: 'timeout', message: 'took too long' });
  });

  it('keeps running other jobs after one fails', async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first one fails');
      return DOCUMENT;
    });

    const first = queue.add(URL_, 'auto');
    const second = queue.add(URL_, 'never');

    expect((await settle(queue, first.id)).status).toBe('failed');
    expect((await settle(queue, second.id)).status).toBe('done');
  });
});

describe('concurrency', () => {
  it('runs at most `concurrency` jobs at once', async () => {
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const queue = new JobQueue(
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return DOCUMENT;
      },
      { concurrency: 2 },
    );

    const ids = Array.from(
      { length: 6 },
      (_unused, index) => queue.add(`https://example.test/page-${index}`, 'auto').id,
    );
    await vi.waitFor(() => expect(queue.stats().running).toBe(2));

    // Four parked behind the cap — the reason the queue exists.
    expect(queue.stats().queued).toBe(4);

    gate.resolve();
    for (const id of ids) await settle(queue, id);

    expect(peak).toBe(2);
    expect(queue.stats()).toMatchObject({ done: 6, running: 0, queued: 0 });
  });
});

describe('deduplication', () => {
  // Five submissions of one url must be one fetch with five readers. The cache
  // cannot help here: it only fills once the first finishes, which is exactly
  // when the duplicates have already started.
  it('returns the running job when the same page is asked for again', async () => {
    const gate = deferred();
    const run = vi.fn(async () => {
      await gate.promise;
      return DOCUMENT;
    });
    const queue = new JobQueue(run);

    const jobs = Array.from({ length: 5 }, () => queue.add(URL_, 'auto'));

    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle(queue, jobs[0]!.id);
  });

  it('keeps different fetch modes as separate work', () => {
    const run = vi.fn(async () => DOCUMENT);
    const queue = new JobQueue(run, { keyOf: (url, browser) => `${browser}\n${url}` });

    queue.add(URL_, 'auto');
    queue.add(URL_, 'never');

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('coalesces urls that share an identity, when told how', async () => {
    const run = vi.fn(async () => DOCUMENT);
    const queue = new JobQueue(run, {
      keyOf: (url, browser) => `${browser}\n${new URL(url).origin}${new URL(url).pathname}`,
    });

    const first = queue.add(`${URL_}?utm_source=twitter`, 'auto');
    const second = queue.add(`${URL_}?utm_source=rss`, 'auto');

    expect(second.id).toBe(first.id);
    expect(run).toHaveBeenCalledTimes(1);
    await settle(queue, first.id);
  });

  it('starts fresh work once the previous run has finished', async () => {
    const run = vi.fn(async () => DOCUMENT);
    const queue = new JobQueue(run);

    const first = queue.add(URL_, 'auto');
    await settle(queue, first.id);
    const second = queue.add(URL_, 'auto');

    expect(second.id).not.toBe(first.id);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('backpressure', () => {
  // The limiter caps what runs, not what can be submitted. Without a bound,
  // ten thousand POSTs are ten thousand jobs held in memory.
  it('refuses work once the backlog is full', async () => {
    const gate = deferred();
    const queue = new JobQueue(
      async () => {
        await gate.promise;
        return DOCUMENT;
      },
      { concurrency: 1, maxQueued: 2 },
    );

    queue.add('https://example.test/running', 'auto');
    queue.add('https://example.test/waiting-1', 'auto');
    queue.add('https://example.test/waiting-2', 'auto');

    expect(() => queue.add('https://example.test/too-much', 'auto')).toThrow(QueueFullError);

    gate.resolve();
  });

  it('accepts again once the backlog drains', async () => {
    const gate = deferred();
    const queue = new JobQueue(
      async () => {
        await gate.promise;
        return DOCUMENT;
      },
      { concurrency: 1, maxQueued: 1 },
    );

    const running = queue.add('https://example.test/a', 'auto');
    const waiting = queue.add('https://example.test/b', 'auto');
    expect(() => queue.add('https://example.test/c', 'auto')).toThrow(QueueFullError);

    gate.resolve();
    await settle(queue, running.id);
    await settle(queue, waiting.id);

    expect(() => queue.add('https://example.test/c', 'auto')).not.toThrow();
  });
});

describe('the timeout backstop', () => {
  it('fails a job that outlives its budget, and tells the runner to stop', async () => {
    let seen: AbortSignal | undefined;
    const queue = new JobQueue(
      async (_url, _browser, signal) => {
        seen = signal;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return DOCUMENT;
      },
      { jobTimeoutMs: 30 },
    );

    const failed = await settle(queue, queue.add(URL_, 'auto').id);

    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toContain('budget');
    expect(seen?.aborted).toBe(true);
  });

  it('leaves a job that finishes in time alone', async () => {
    const queue = new JobQueue(async () => DOCUMENT, { jobTimeoutMs: 5_000 });

    expect((await settle(queue, queue.add(URL_, 'auto').id)).status).toBe('done');
  });
});

describe('retention', () => {
  it('reports nothing for an id it never issued', () => {
    expect(new JobQueue(async () => DOCUMENT).get('nope')).toBeNull();
  });

  // Without eviction the map is a memory leak with a request id attached.
  it('drops finished jobs once nobody could still be polling', async () => {
    let clock = 1_000_000;
    const queue = new JobQueue(async () => DOCUMENT, {
      retentionMs: 60_000,
      now: () => clock,
    });

    const job = queue.add(URL_, 'auto');
    await settle(queue, job.id);

    clock += 59_000;
    expect(queue.get(job.id)).not.toBeNull();

    clock += 2_000;
    expect(queue.get(job.id)).toBeNull();
    // Retired, not imaginary — the caller gets 410 rather than 404.
    expect(queue.wasRetired(job.id)).toBe(true);
  });

  it('does not claim to have retired an id it never issued', () => {
    expect(new JobQueue(async () => DOCUMENT).wasRetired('never-existed')).toBe(false);
  });

  it('never evicts a job that is still running', async () => {
    let clock = 1_000_000;
    const gate = deferred();
    const queue = new JobQueue(
      async () => {
        await gate.promise;
        return DOCUMENT;
      },
      { retentionMs: 1, now: () => clock },
    );

    const job = queue.add(URL_, 'auto');
    clock += 60_000;

    expect(queue.get(job.id)).not.toBeNull();

    gate.resolve();
    await settle(queue, job.id);
  });
});
