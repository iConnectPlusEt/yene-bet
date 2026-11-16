-- Reaching listeners who are not in the app: Telegram listeners can opt in
-- to be messaged when someone needs their specific experience.

alter table listener_profiles add column if not exists ping_enabled boolean not null default false;

create table if not exists pings (
  id         bigint generated always as identity primary key,
  person_id  uuid not null references people(id) on delete cascade,
  chat_id    uuid references chats(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists pings_person on pings (person_id, created_at desc);
alter table pings enable row level security;

grant select, insert, update, delete on pings to yb_app;
drop policy if exists app_all on pings;
create policy app_all on pings for all to yb_app using (true) with check (true);

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on pings from anon, authenticated;
  end if;
end $$;
