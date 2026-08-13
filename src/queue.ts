import { randomUUID } from 'node:crypto';
import { Limiter } from './limit.js';
import type { ScrapedDocument } from './types.js';

/**
 * Phase 3, step 4 — work that outlives a request, and step 7 — surviving load.
 *
 * A browser scrape is ~600ms, a slow site 15 seconds, and with a concurrency
 * cap a request can be waiting on *other people's* pages too. None of that
 * belongs inside an HTTP request/response cycle.
 *
 * In-memory on purpose (the plan says so). Jobs die with the process, which is
 * a single-instance decision, written down in Phase 9 rather than hidden here.
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
  readonly #jobs = new Map<string, Job>();
  /** Unfinished work by identity, so the same page isn't fetched twice at once. */
  readonly #inFlight = new Map<string, string>();
  /** Ids we have retired, newest last. Bounded — this is a memory budget, not a log. */
  readonly #retired = new Set<string>();

  readonly #limiter: Limiter;
  readonly #run: JobRunner;
  readonly #maxQueued: number;
  readonly #jobTimeoutMs: number;
  readonly #retentionMs: number;
  readonly #tombstones: number;
  readonly #now: () => number;
  readonly #describeError: ErrorShaper;
  readonly #keyOf: (url: string, browser: string) => string;

  constructor(run: JobRunner, options: JobQueueOptions = {}) {
    this.#run = run;
    this.#limiter = new Limiter(options.concurrency ?? 4);
    this.#maxQueued = options.maxQueued ?? 100;
    this.#jobTimeoutMs = options.jobTimeoutMs ?? 90_000;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#tombstones = options.tombstones ?? 1_000;
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
  add(url: string, browser: string): Job {
    this.#evictExpired();

    const key = this.#keyOf(url, browser);
    const existing = this.#inFlight.get(key);
    if (existing) {
      const job = this.#jobs.get(existing);
      if (job) return { ...job };
      this.#inFlight.delete(key);
    }

    if (this.#limiter.queued >= this.#maxQueued) throw new QueueFullError(this.#maxQueued);

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
    this.#inFlight.set(key, job.id);

    // Deliberately not awaited: that is the point of the queue. The promise is
    // consumed here so a failure can never become an unhandled rejection —
    // which in Node ends the process, over one bad url.
    void this.#limiter.run(() => this.#execute(job, key));

    return { ...job };
  }

  get(id: string): Job | null {
    this.#evictExpired();
    const job = this.#jobs.get(id);
    if (job) return { ...job };
    return null;
  }

  /** True for an id this queue issued and has since dropped. The caller answers 410. */
  wasRetired(id: string): boolean {
    return this.#retired.has(id);
  }

  stats(): { queued: number; running: number; done: number; failed: number; inFlight: number } {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, inFlight: this.#inFlight.size };
    for (const job of this.#jobs.values()) counts[job.status] += 1;
    return counts;
  }

  async #execute(job: Job, key: string): Promise<void> {
    job.status = 'running';
    job.startedAt = this.#now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#jobTimeoutMs);

    try {
      job.document = await Promise.race([
        this.#run(job.url, job.browser, controller.signal),
        timeout(controller.signal, this.#jobTimeoutMs),
      ]);
      job.status = 'done';
    } catch (error) {
      job.error = this.#describeError(error);
      job.status = 'failed';
    } finally {
      clearTimeout(timer);
      job.finishedAt = this.#now();
      // Only clear the mapping if it still points at us: a retried url may
      // already have claimed the key.
      if (this.#inFlight.get(key) === job.id) this.#inFlight.delete(key);
    }
  }

  /**
   * Finished jobs are dropped once nobody could reasonably still be polling.
   * Without this the map is a memory leak with a request id attached. Their ids
   * are remembered so a late poll gets "gone", not "never heard of it".
   */
  #evictExpired(): void {
    const cutoff = this.#now() - this.#retentionMs;
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt === null || job.finishedAt > cutoff) continue;
      this.#jobs.delete(id);
      this.#retired.add(id);
    }

    while (this.#retired.size > this.#tombstones) {
      const oldest = this.#retired.values().next().value;
      if (oldest === undefined) break;
      this.#retired.delete(oldest);
    }
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
