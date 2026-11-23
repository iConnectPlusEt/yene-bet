-- A private stats page: who is using the app, and how well it is working.

-- Test identities (from checking the live site) are left out of every number.
alter table people add column if not exists is_test boolean not null default false;

-- When a person joined the conversation, so waiting time can be measured.
-- (Conversations opened directly between two people from an invitation do not
-- set it: nobody was waiting.)
alter table chats add column if not exists connected_at timestamptz;

-- One row per day (Addis Ababa time), written by the one-minute background
-- job. The last value of the day is that day's number of active people.
create table if not exists daily_stats (
  day                date primary key,
  active_24h         integer not null default 0,
  people_total       integer not null default 0,
  got_in             integer not null default 0,
  telegram_reachable integer not null default 0,
  updated_at         timestamptz not null default now()
);
alter table daily_stats enable row level security;
grant select, insert, update, delete on daily_stats to yb_app;
drop policy if exists app_all on daily_stats;
create policy app_all on daily_stats for all to yb_app using (true) with check (true);
do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on daily_stats from anon, authenticated;
  end if;
end $$;

-- Mark the identities used while checking the live site: people in the
-- conversations labelled "live check" or "deployment check", on both sides.
update people set is_test = true
 where id in (select venter_id from chats where opening ~* '(live check|deployment check)')
    or id in (select listener_id from chats where listener_id is not null and opening ~* '(live check|deployment check)');

-- Waiting time for conversations that already happened: the moment the
-- listener was told they were connected.
update chats c
   set connected_at = (
         select min(m.created_at) from messages m
         where m.chat_id = c.id and m.sender = 'system' and m.to_role = 'listener' and m.body like 'You are connected%')
 where c.listener_id is not null and c.connected_at is null;
