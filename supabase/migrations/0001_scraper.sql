-- Scraper storage: the page cache and the job queue.
--
-- Both were local-only: SQLite on one machine's disk, jobs in one process's
-- memory. Both are single-instance assumptions, and both stop being true the
-- moment there are two containers. This is where they become shared state.
--
-- Written by hand, like the SQLite schema before it, for the same reason:
-- Phase 5 puts Drizzle over this database and the contrast is the lesson.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Cached pages
-- ---------------------------------------------------------------------------

create table if not exists scrape_cache (
  -- Fetch mode + normalised url. The mode belongs in the key because it
  -- changes the answer: browser=never on an SPA yields an empty shell, and
  -- serving an auto-fetched document to that caller hands back exactly what
  -- they asked not to get.
  key         text primary key,
  url         text        not null,
  mode        text        not null,
  document    jsonb       not null,
  stored_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- The read path is always "this key, if it is still fresh".
create index if not exists scrape_cache_expires_at on scrape_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

do $$ begin
  create type job_status as enum ('queued', 'running', 'done', 'failed');
exception
  when duplicate_object then null;
end $$;

create table if not exists scrape_jobs (
  id          uuid        primary key default gen_random_uuid(),
  -- Who asked. Null for anonymous callers while auth is optional.
  owner_id    uuid        references auth.users (id) on delete set null,
  url         text        not null,
  browser     text        not null,
  status      job_status  not null default 'queued',

  -- Mode + normalised url, as in the cache. Deduplication happens against
  -- *unfinished* work, so this cannot be a plain unique constraint — see the
  -- partial index below.
  dedupe_key  text        not null,

  document    jsonb,
  error       jsonb,

  queued_at   timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- One unfinished job per identity. A partial unique index says exactly that:
-- five simultaneous submissions of one url collapse to one row, while the same
-- url tomorrow is new work rather than a conflict with a finished job.
create unique index if not exists scrape_jobs_one_in_flight
  on scrape_jobs (dedupe_key)
  where status in ('queued', 'running');

create index if not exists scrape_jobs_owner on scrape_jobs (owner_id, queued_at desc);
create index if not exists scrape_jobs_finished_at on scrape_jobs (finished_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The service connects with the service role, which bypasses RLS — these
-- policies are the backstop, not the mechanism. They matter the day something
-- reaches this database with an anon key, which is the day you want to have
-- written them already.

alter table scrape_cache enable row level security;
alter table scrape_jobs  enable row level security;

-- Cached pages are public documents fetched from public urls, but there is no
-- reason for a browser to read the table directly. No policy = no access for
-- anon and authenticated; the service role still reads and writes.

drop policy if exists "own jobs are readable" on scrape_jobs;
create policy "own jobs are readable"
  on scrape_jobs for select
  to authenticated
  using (owner_id = auth.uid());
