import { Limiter } from '../support/limit.js';
import { MemoryJobStore, type JobCounts, type JobStore } from './job-store.js';
import type { ScrapedDocument } from '../core/types.js';

/**
 * Phase 3, step 4 — work that outlives a request, and step 7 — surviving load.
 *
 * A browser scrape is ~600ms, a slow site 15 seconds, and with a concurrency
 * cap a request can be waiting on *other people's* pages too. None of that
 * belongs inside an HTTP request/response cycle.
 *
 * Where the jobs *live* is a separate question, answered by JobStore: memory
 * for a local run and for tests, Postgres for a service that will be killed
 * mid-scrape and still expected to answer `GET /jobs/:id` afterwards. This
 * class owns the scheduling — the limiter, the timeout, the abort — and none
 * of the storage.
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

export type JobRunner = (
  url: string,
  browser: string,
  signal: AbortSignal,
) => Promise<ScrapedDocument>;

export type ErrorShaper = (error: unknown) => JobError;

/** Thrown by `add` when the backlog is already at its limit. The caller answers 429. */
export class QueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`queue is full (${limit} waiting)`);
    this.name = 'QueueFullError';
  }
}

export interface JobQueueOptions {
  concurrency?: number;
  /** Most jobs that may be waiting to start. Beyond this, `add` throws. */
  maxQueued?: number;
  /** Backstop for a job that never finishes. Default 90s — above every fetch timeout. */
  jobTimeoutMs?: number;
  /** How long a finished job stays readable. Default 10 minutes. */
  retentionMs?: number;
  /** Ids of retired jobs remembered, so "expired" can be told from "never existed". */
  tombstones?: number;
  now?: () => number;
  describeError?: ErrorShaper;
  /** Defaults to memory. Pass SupabaseJobStore for jobs that outlive the process. */
  store?: JobStore;
  /**
   * Identity for deduplication. Defaults to mode + url; the server passes one
   * that normalises the url first, so `?utm_source=` variants coalesce.
   */
  keyOf?: (url: string, browser: string) => string;
}

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

const defaultShaper: ErrorShaper = (error) => ({
  code: 'internal',
  message: error instanceof Error ? error.message : String(error),
});

export class JobQueue {
  readonly #store: JobStore;
  readonly #limiter: Limiter;
  readonly #run: JobRunner;
  readonly #maxQueued: number;
  readonly #jobTimeoutMs: number;
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #describeError: ErrorShaper;
  readonly #keyOf: (url: string, browser: string) => string;

  constructor(run: JobRunner, options: JobQueueOptions = {}) {
    this.#run = run;
    this.#limiter = new Limiter(options.concurrency ?? 4);
    this.#maxQueued = options.maxQueued ?? 100;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 90_000;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#store = options.store ?? new MemoryJobStore(options.tombstones ?? 1_000);
    this.#now = options.now ?? Date.now;
    this.#describeError = options.describeError ?? defaultShaper;
    this.#keyOf = options.keyOf ?? ((url, browser) => `${browser}\n${url}`);
  }

  /**
   * Accepts work and returns immediately.
   *
   * Asking twice for the same page while the first is still running returns
   * *that* job — five submissions of one url are one fetch with five readers,
   * not five browsers. The cache can't help here: it only fills once the first
   * one finishes, which is exactly when the duplicates have already started.
   *
   * @throws {QueueFullError} when the backlog is at its limit.
   */
  async add(url: string, browser: string, ownerId: string | null = null): Promise<Job> {
    await this.#sweep();

    if (this.#limiter.queued >= this.#maxQueued) throw new QueueFullError(this.#maxQueued);

    const { job, created } = await this.#store.claim(
      { url, browser, dedupeKey: this.#keyOf(url, browser), ownerId },
      this.#now(),
    );

    // Already someone else's work: hand back their job rather than starting a
    // second fetch of the same page.
    if (!created) return job;

    // Deliberately not awaited: that is the point of the queue. The promise is
    // consumed here so a failure can never become an unhandled rejection —
    // which in Node ends the process, over one bad url.
    void this.#limiter.run(() => this.#execute(job));

    return job;
  }

  async get(id: string): Promise<Job | null> {
    await this.#sweep();
    return this.#store.get(id);
  }

  /** True for an id this queue issued and has since dropped. The caller answers 410. */
  async wasRetired(id: string): Promise<boolean> {
    return this.#store.wasRetired(id);
  }

  async stats(): Promise<JobCounts> {
    return this.#store.stats();
  }

  async #execute(job: Job): Promise<void> {
    await this.#store.update(job.id, { status: 'running', startedAt: this.#now() });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#jobTimeoutMs);

    try {
      const document = await Promise.race([
        this.#run(job.url, job.browser, controller.signal),
        timeout(controller.signal, this.#jobTimeoutMs),
      ]);
      await this.#store.update(job.id, { status: 'done', document, finishedAt: this.#now() });
    } catch (error) {
      await this.#store.update(job.id, {
        status: 'failed',
        error: this.#describeError(error),
        finishedAt: this.#now(),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Finished jobs are dropped once nobody could reasonably still be polling.
   * Without this the store is a leak with a request id attached.
   */
  async #sweep(): Promise<void> {
    await this.#store.sweep(this.#now() - this.#retentionMs);
  }
}

/**
 * Rejects when the job's own deadline passes.
 *
 * The signal is passed to the runner too, so the underlying HTTP request is
 * actually aborted rather than merely ignored. A browser navigation already in
 * flight will still finish; its result is discarded.
 */
function timeout(signal: AbortSignal, ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(`job exceeded its ${ms}ms budget`)), {
      once: true,
    });
  });
}
