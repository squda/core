import { randomUUID } from 'node:crypto';
import { Limiter } from './limit.js';
import type { ScrapedDocument } from './types.js';

/**
 * Phase 3, step 4 — work that outlives a request.
 *
 * A browser scrape is ~600ms, a slow site 15 seconds, and with a concurrency
 * cap a request can be waiting on *other people's* pages too. None of that
 * belongs inside an HTTP request/response cycle: the client is holding a
 * connection open to watch us think.
 *
 * In-memory on purpose (the plan says so). That means jobs die with the
 * process — acceptable while the queue exists to move waiting off the request,
 * not to guarantee delivery. A durable queue is a different feature, and BullMQ
 * stays out of scope until Phase 8 ships.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  url: string;
  browser: string;
  status: JobStatus;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  document: ScrapedDocument | null;
  error: JobError | null;
}

export type JobRunner = (url: string, browser: string) => Promise<ScrapedDocument>;

/** Turns a thrown error into the shape a job reports. */
export type ErrorShaper = (error: unknown) => JobError;

export interface JobQueueOptions {
  concurrency?: number;
  /** How long a finished job stays readable. Default 10 minutes. */
  retentionMs?: number;
  now?: () => number;
  describeError?: ErrorShaper;
}

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

const defaultShaper: ErrorShaper = (error) => ({
  code: 'internal',
  message: error instanceof Error ? error.message : String(error),
});

export class JobQueue {
  readonly #jobs = new Map<string, Job>();
  readonly #limiter: Limiter;
  readonly #run: JobRunner;
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #describeError: ErrorShaper;

  constructor(run: JobRunner, options: JobQueueOptions = {}) {
    this.#run = run;
    this.#limiter = new Limiter(options.concurrency ?? 4);
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#now = options.now ?? Date.now;
    this.#describeError = options.describeError ?? defaultShaper;
  }

  /**
   * Accepts work and returns immediately. The returned job is a snapshot —
   * read it again through `get` to see it progress.
   */
  add(url: string, browser: string): Job {
    this.#evictExpired();

    const job: Job = {
      id: randomUUID(),
      url,
      browser,
      status: 'queued',
      queuedAt: this.#now(),
      startedAt: null,
      finishedAt: null,
      document: null,
      error: null,
    };
    this.#jobs.set(job.id, job);

    // Deliberately not awaited: that is the entire point of the queue. The
    // promise is consumed here so a failure can never become an unhandled
    // rejection — it is recorded on the job instead.
    void this.#limiter.run(async () => {
      job.status = 'running';
      job.startedAt = this.#now();
      try {
        job.document = await this.#run(url, browser);
        job.status = 'done';
      } catch (error) {
        job.error = this.#describeError(error);
        job.status = 'failed';
      } finally {
        job.finishedAt = this.#now();
      }
    });

    return { ...job };
  }

  get(id: string): Job | null {
    this.#evictExpired();
    const job = this.#jobs.get(id);
    return job ? { ...job } : null;
  }

  stats(): { queued: number; running: number; done: number; failed: number } {
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const job of this.#jobs.values()) counts[job.status] += 1;
    return counts;
  }

  /**
   * Finished jobs are dropped once nobody could reasonably still be polling.
   * Without this the map is a memory leak with a request id attached.
   */
  #evictExpired(): void {
    const cutoff = this.#now() - this.#retentionMs;
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt !== null && job.finishedAt <= cutoff) this.#jobs.delete(id);
    }
  }
}
