-- The waitlist for the web app.
--
-- Deliberately the smallest table that answers the only questions we have:
-- who asked, when, and what kind of forms they fill. The last one is optional
-- and is the one that decides what gets built next, so it is worth a column
-- even while it is usually null.

create table if not exists waitlist_signups (
  id          uuid primary key default gen_random_uuid(),
  -- Lowercased by the caller, and unique: joining twice is not an error, it is
  -- the same person. The route reports 23505 back as "already on the list".
  email       text not null unique,
  -- Free text rather than an enum. We do not yet know the categories, and
  -- guessing them now would throw away the answer we are collecting.
  fills       text,
  source      text,
  created_at  timestamptz not null default now()
);

-- Nobody may read or write this from a browser. Inserts go through the Next
-- route handler using the service role key, which bypasses RLS; leaving the
-- table enabled with no policy means an anon key gets nothing at all.
alter table waitlist_signups enable row level security;
