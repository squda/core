import { describe, expect, it } from 'vitest';
import { MemoryJobStore } from '../src/service/job-store.js';

const job = { url: 'https://a.test/', browser: 'auto', dedupeKey: 'auto\nhttps://a.test/' };
const now = 1_000_000;

describe('MemoryJobStore', () => {
  it('creates a job in the queued state', async () => {
    const { job: created, created: isNew } = await new MemoryJobStore().claim(job, now);

    expect(isNew).toBe(true);
    expect(created).toMatchObject({ status: 'queued', url: job.url, document: null, error: null });
  });

  it('hands back the in-flight job rather than creating a second', async () => {
    const store = new MemoryJobStore();
    const first = await store.claim(job, now);
    const second = await store.claim(job, now);

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  // Dedupe covers *unfinished* work only: the same page tomorrow is new work,
  // not a conflict with a job that finished yesterday.
  it('creates fresh work once the previous job has finished', async () => {
    const store = new MemoryJobStore();
    const first = await store.claim(job, now);
    await store.update(first.job.id, { status: 'done', finishedAt: now });

    const second = await store.claim(job, now);

    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('records what a job became', async () => {
    const store = new MemoryJobStore();
    const { job: created } = await store.claim(job, now);

    await store.update(created.id, { status: 'failed', error: { code: 'timeout', message: 'x' } });

    expect(await store.get(created.id)).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
  });

  it('returns copies, so a caller cannot mutate the store', async () => {
    const store = new MemoryJobStore();
    const { job: created } = await store.claim(job, now);

    created.status = 'done';

    expect((await store.get(created.id))?.status).toBe('queued');
  });

  it('counts what it holds', async () => {
    const store = new MemoryJobStore();
    await store.claim(job, now);
    const other = await store.claim({ ...job, url: 'https://b.test/', dedupeKey: 'b' }, now);
    await store.update(other.job.id, { status: 'done', finishedAt: now });

    expect(await store.stats()).toMatchObject({ queued: 1, done: 1, inFlight: 1 });
  });

  it('sweeps finished jobs and remembers that they existed', async () => {
    const store = new MemoryJobStore();
    const { job: created } = await store.claim(job, now);
    await store.update(created.id, { status: 'done', finishedAt: now });

    expect(await store.sweep(now + 1)).toBe(1);
    expect(await store.get(created.id)).toBeNull();
    // Gone, not imaginary — this is what makes 410 possible.
    expect(await store.wasRetired(created.id)).toBe(true);
  });

  it('never sweeps a job that is still running', async () => {
    const store = new MemoryJobStore();
    const { job: created } = await store.claim(job, now);
    await store.update(created.id, { status: 'running', startedAt: now });

    expect(await store.sweep(now + 10_000_000)).toBe(0);
    expect(await store.get(created.id)).not.toBeNull();
  });

  it('does not claim to have retired an id it never issued', async () => {
    expect(await new MemoryJobStore().wasRetired('nope')).toBe(false);
  });
});
