-- Browser push notifications for website visitors, and what we need to ask
-- the right people first.

-- One row per browser that agreed to be alerted. The endpoint is what the
-- browser's push service gave us; nothing about the person is in it.
create table if not exists push_subs (
  endpoint     text primary key,
  person_id    uuid not null references people(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  alerts       boolean not null default true,   -- asked to be told when someone needs a listener
  created_at   timestamptz not null default now(),
  last_ok_at   timestamptz,
  failed_at    timestamptz
);
create index if not exists push_subs_person on push_subs (person_id);
alter table push_subs enable row level security;
grant select, insert, update, delete on push_subs to yb_app;
drop policy if exists app_all on push_subs;
create policy app_all on push_subs for all to yb_app using (true) with check (true);

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on push_subs from anon, authenticated;
  end if;
end $$;

-- Which channel a request went out on, and when it was answered, so the next
-- request goes first to people who actually answer, and fast.
alter table pings add column if not exists channel text not null default 'telegram';
alter table pings add column if not exists answered_at timestamptz;
