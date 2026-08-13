import { randomUUID } from 'node:crypto';
import type { Job, JobError, JobStatus } from './queue.js';

/**
 * Where jobs live.
 *
 * Two implementations, and the difference is what survives a restart. Memory
 * is right for a CLI-shaped run and for tests; Postgres is right for a service
 * that will be killed mid-scrape and expected to still answer `GET /jobs/:id`
 * afterwards, and for two instances that must not fetch the same page twice.
 *
 * The dedupe contract is the interesting part. `claim` either creates a job or
 * hands back the unfinished one that already owns that identity — and in
 * Postgres that has to be *atomic*, because two instances can call it at the
 * same millisecond. A partial unique index does the deciding; we react to the
 * conflict rather than checking first and hoping.
 */

export interface NewJob {
  url: string;
  browser: string;
  dedupeKey: string;
  ownerId?: string | null;
}

export interface JobPatch {
  status?: JobStatus;
  startedAt?: number | null;
  finishedAt?: number | null;
  document?: Job['document'];
  error?: JobError | null;
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  inFlight: number;
}

export interface JobStore {
  /** Creates the job, or returns the unfinished one holding that identity. */
  claim(job: NewJob, now: number): Promise<{ job: Job; created: boolean }>;
  update(id: string, patch: JobPatch, now: number): Promise<void>;
  get(id: string): Promise<Job | null>;
  /** True for an id this store issued and has since dropped. Answers 410. */
  wasRetired(id: string): Promise<boolean>;
  stats(): Promise<JobCounts>;
  /** Drops finished jobs older than the retention window. Returns how many. */
  sweep(olderThan: number): Promise<number>;
}

const UNFINISHED: JobStatus[] = ['queued', 'running'];

export class MemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, Job>();
  readonly #inFlight = new Map<string, string>();
  readonly #retired = new Set<string>();
  readonly #tombstones: number;

  constructor(tombstones = 1_000) {
    this.#tombstones = tombstones;
  }

  async claim(input: NewJob, now: number): Promise<{ job: Job; created: boolean }> {
    const existing = this.#inFlight.get(input.dedupeKey);
    const running = existing ? this.#jobs.get(existing) : undefined;
    if (running && UNFINISHED.includes(running.status)) {
      return { job: { ...running }, created: false };
    }

    const job: Job = {
      id: randomUUID(),
      url: input.url,
      browser: input.browser,
      status: 'queued',
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      document: null,
      error: null,
    };
    this.#jobs.set(job.id, job);
    this.#inFlight.set(input.dedupeKey, job.id);
    return { job: { ...job }, created: true };
  }

  async update(id: string, patch: JobPatch): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);

    if (patch.status && !UNFINISHED.includes(patch.status)) {
      for (const [key, jobId] of this.#inFlight) {
        if (jobId === id) this.#inFlight.delete(key);
      }
    }
  }

  async get(id: string): Promise<Job | null> {
    const job = this.#jobs.get(id);
    return job ? { ...job } : null;
  }

  async wasRetired(id: string): Promise<boolean> {
    return this.#retired.has(id);
  }

  async stats(): Promise<JobCounts> {
    const counts: JobCounts = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      inFlight: this.#inFlight.size,
    };
    for (const job of this.#jobs.values()) counts[job.status] += 1;
    return counts;
  }

  async sweep(olderThan: number): Promise<number> {
    let dropped = 0;
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt === null || job.finishedAt > olderThan) continue;
      this.#jobs.delete(id);
      this.#retired.add(id);
      dropped += 1;
    }

    // Tombstones are a memory budget, not a log.
    while (this.#retired.size > this.#tombstones) {
      const oldest = this.#retired.values().next().value;
      if (oldest === undefined) break;
      this.#retired.delete(oldest);
    }
    return dropped;
  }
}
