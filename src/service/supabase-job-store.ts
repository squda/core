import type { Job } from './queue.js';
import type { JobCounts, JobPatch, JobStore, NewJob } from './job-store.js';
import type { SupabaseClient } from './supabase.js';

/**
 * Jobs in Postgres, so they survive a restart and two instances can share them.
 *
 * The dedupe is the part worth reading. `scrape_jobs_one_in_flight` is a
 * *partial* unique index — unique on dedupe_key, but only while the job is
 * queued or running. So an insert either wins or violates it, and losing means
 * someone else is already fetching that page. We react to the conflict rather
 * than checking first: between a check and an insert, another instance fits.
 */

interface Row {
  id: string;
  url: string;
  browser: string;
  status: Job['status'];
  document: Job['document'];
  error: Job['error'];
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const UNIQUE_VIOLATION = '23505';

export interface SupabaseJobStoreOptions {
  onError?: (error: unknown) => void;
}

export class SupabaseJobStore implements JobStore {
  readonly #client: SupabaseClient;
  readonly #onError: (error: unknown) => void;

  constructor(client: SupabaseClient, options: SupabaseJobStoreOptions = {}) {
    this.#client = client;
    this.#onError = options.onError ?? (() => {});
  }

  async claim(input: NewJob, now: number): Promise<{ job: Job; created: boolean }> {
    const { data, error } = await this.#client
      .from('scrape_jobs')
      .insert({
        url: input.url,
        browser: input.browser,
        dedupe_key: input.dedupeKey,
        owner_id: input.ownerId ?? null,
        status: 'queued',
        queued_at: new Date(now).toISOString(),
      })
      .select()
      .single();

    if (!error && data) return { job: toJob(data as Row), created: true };

    if (error?.code === UNIQUE_VIOLATION) {
      // Someone else owns this page right now. Hand back their job.
      const existing = await this.#findInFlight(input.dedupeKey);
      if (existing) return { job: existing, created: false };
      // The winner finished between our insert and this read — rare, and the
      // right answer is to try once more rather than invent an error.
      return this.claim(input, now);
    }

    throw error ?? new Error('could not create job');
  }

  async update(id: string, patch: JobPatch): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.document !== undefined) row.document = patch.document;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.startedAt !== undefined) {
      row.started_at = patch.startedAt === null ? null : new Date(patch.startedAt).toISOString();
    }
    if (patch.finishedAt !== undefined) {
      row.finished_at = patch.finishedAt === null ? null : new Date(patch.finishedAt).toISOString();
    }

    const { error } = await this.#client.from('scrape_jobs').update(row).eq('id', id);
    if (error) this.#onError(error);
  }

  async get(id: string): Promise<Job | null> {
    // An id that isn't a uuid is not a lookup failure worth reporting to
    // Postgres — it cannot match anything.
    if (!isUuid(id)) return null;

    const { data, error } = await this.#client
      .from('scrape_jobs')
      .select()
      .eq('id', id)
      .maybeSingle();

    if (error) {
      this.#onError(error);
      return null;
    }
    return data ? toJob(data as Row) : null;
  }

  /**
   * Retirement is deletion here, so a row we cannot find is either retired or
   * never existed and we cannot tell which. Rather than keep tombstones, jobs
   * are *kept* and swept on a much longer horizon; anything within it is still
   * readable, and beyond it a 404 is the honest answer.
   */
  async wasRetired(): Promise<boolean> {
    return false;
  }

  async stats(): Promise<JobCounts> {
    const counts: JobCounts = { queued: 0, running: 0, done: 0, failed: 0, inFlight: 0 };

    const { data, error } = await this.#client.from('scrape_jobs').select('status');
    if (error) {
      this.#onError(error);
      return counts;
    }

    for (const row of (data ?? []) as { status: Job['status'] }[]) {
      counts[row.status] += 1;
    }
    counts.inFlight = counts.queued + counts.running;
    return counts;
  }

  async sweep(olderThan: number): Promise<number> {
    const { data, error } = await this.#client
      .from('scrape_jobs')
      .delete()
      .lt('finished_at', new Date(olderThan).toISOString())
      .select('id');

    if (error) {
      this.#onError(error);
      return 0;
    }
    return (data ?? []).length;
  }

  async #findInFlight(dedupeKey: string): Promise<Job | null> {
    const { data, error } = await this.#client
      .from('scrape_jobs')
      .select()
      .eq('dedupe_key', dedupeKey)
      .in('status', ['queued', 'running'])
      .maybeSingle();

    if (error) {
      this.#onError(error);
      return null;
    }
    return data ? toJob(data as Row) : null;
  }
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    url: row.url,
    browser: row.browser,
    status: row.status,
    queuedAt: Date.parse(row.queued_at),
    startedAt: row.started_at ? Date.parse(row.started_at) : null,
    finishedAt: row.finished_at ? Date.parse(row.finished_at) : null,
    document: row.document,
    error: row.error,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
