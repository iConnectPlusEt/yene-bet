-- Sharing wall ("I have been there") and talking to the same person again.

create table if not exists posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references people(id) on delete cascade,
  alias        text not null,
  body         text not null,
  experiences  text[] not null default '{}',
  language     text not null default 'en',
  hidden       boolean not null default false,   -- set after repeated reports
  created_at   timestamptz not null default now()
);
create index if not exists posts_recent on posts (created_at desc) where not hidden;

-- Someone saying "I have been there" on a post.
create table if not exists post_relates (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references posts(id) on delete cascade,
  person_id  uuid not null references people(id) on delete cascade,
  alias      text not null,
  created_at timestamptz not null default now(),
  unique (post_id, person_id)
);

create table if not exists post_reports (
  post_id    uuid not null references posts(id) on delete cascade,
  person_id  uuid not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, person_id)
);

-- Two people from one conversation. Each may say "I would talk to them
-- again"; only when both have can either invite the other. a_id < b_id.
create table if not exists connections (
  id         bigint generated always as identity primary key,
  a_id       uuid not null references people(id) on delete cascade,
  b_id       uuid not null references people(id) on delete cascade,
  a_alias    text not null,   -- the name b knows a by
  b_alias    text not null,   -- the name a knows b by
  a_wants    boolean not null default false,
  b_wants    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (a_id, b_id),
  check (a_id < b_id)
);

-- An invitation to talk, from a post's author to someone who related, or
-- between two people who both chose to talk again.
create table if not exists invites (
  id         bigint generated always as identity primary key,
  from_id    uuid not null references people(id) on delete cascade,
  to_id      uuid not null references people(id) on delete cascade,
  from_alias text not null,
  to_alias   text not null,
  kind       text not null check (kind in ('post', 'again')),
  opening    text not null,   -- what the conversation starts from
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now()
);
create unique index if not exists invites_one_pending on invites (from_id, to_id) where status = 'pending';
create index if not exists invites_inbox on invites (to_id) where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['posts', 'post_relates', 'post_reports', 'connections', 'invites'] loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select, insert, update, delete on %I to yb_app', t);
    execute format('drop policy if exists app_all on %I', t);
    execute format('create policy app_all on %I for all to yb_app using (true) with check (true)', t);
    if exists (select from pg_roles where rolname = 'anon') then
      execute format('revoke all on %I from anon, authenticated', t);
    end if;
  end loop;
end $$;
