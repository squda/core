-- Part B's profile store, as decided in the Phase 5 block of PLAN.md.
--
-- Nothing reads these yet; the tables exist so Phase 5 starts with the shape
-- already agreed rather than re-litigating it. Three ideas, one table each:
--
--   profile_events   the append-only log — where everything is written
--   profile_aliases  canonical key ↔ the many names the world uses for it
--   (the profile itself is a *projection* of the log, not a table)
--
-- The projection deliberately has no table. Current value is derived by
-- folding the events, which is what buys history, debuggability and undo. A
-- profile table would immediately become the thing people write to.

create table if not exists profile_events (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users (id) on delete cascade,

  -- 'address.postalCode', 'identity.firstName', …
  canonical_key  text        not null,
  value          text        not null,

  source         text        not null check (source in ('seed', 'user-edit', 'form-fill', 'correction')),
  confidence     real        not null default 1 check (confidence >= 0 and confidence <= 1),

  -- The exact text the form used, when it came from a form. This is the field
  -- that makes Phase 6's embedding index worth building — an alias list we
  -- invented is fuzzy string matching with extra steps; labels the world has
  -- actually shown us are not. Guard it.
  observed_label text,
  url            text,

  observed_at    timestamptz not null default now()
);

-- The read path is "every event for this user's key, newest first" — that is
-- the fold, and also `GET /profile/:key/history`.
create index if not exists profile_events_fold
  on profile_events (user_id, canonical_key, observed_at desc);

-- Append-only means append-only. Enforced here rather than trusted to code
-- review: no UPDATE, no DELETE, for anyone but the table owner.
create or replace function refuse_mutation() returns trigger as $$
begin
  raise exception 'profile_events is append-only (attempted %)', tg_op;
end;
$$ language plpgsql;

drop trigger if exists profile_events_no_update on profile_events;
create trigger profile_events_no_update
  before update or delete on profile_events
  for each row execute function refuse_mutation();

create table if not exists profile_aliases (
  canonical_key text not null,
  alias         text not null,
  -- Where the alias came from: our seed vocabulary, or a real form.
  source        text not null default 'seed',
  created_at    timestamptz not null default now(),
  primary key (canonical_key, alias)
);

alter table profile_events  enable row level security;
alter table profile_aliases enable row level security;

drop policy if exists "own events are readable" on profile_events;
create policy "own events are readable"
  on profile_events for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "own events are appendable" on profile_events;
create policy "own events are appendable"
  on profile_events for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "aliases are readable" on profile_aliases;
create policy "aliases are readable"
  on profile_aliases for select
  to authenticated
  using (true);
