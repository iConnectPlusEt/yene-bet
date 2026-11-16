-- "Did you feel heard?" after a conversation, and what it does to matching.

create table if not exists feedback (
  id          bigint generated always as identity primary key,
  chat_id     uuid unique references chats(id) on delete set null,
  listener_id uuid not null references people(id) on delete cascade,
  heard       smallint not null check (heard in (0, 1, 2)),  -- 0 no, 1 a little, 2 yes
  note        text not null default '',
  seen        boolean not null default false,                -- shown to the listener yet?
  created_at  timestamptz not null default now()
);
create index if not exists feedback_unseen on feedback (listener_id) where not seen;
alter table feedback enable row level security;

alter table listener_profiles add column if not exists helped_count integer not null default 0;
alter table listener_profiles add column if not exists not_heard_count integer not null default 0;

-- Copied from the profile when a listener becomes available, so matching
-- does not need another join.
alter table listeners add column if not exists helped integer not null default 0;
alter table listeners add column if not exists reputation integer not null default 0;

drop function if exists listener_candidates(uuid, text[], text[], text, uuid, int);

create or replace function listener_candidates(p_venter uuid, p_topics text[], p_experiences text[],
                                               p_language text, p_chat uuid, p_limit int)
returns table (person_id uuid, alias text, topics text[], shared_experiences text[], score int,
               helped int, channel text)
language sql stable set search_path = public, pg_temp as $$
  select l.person_id, l.alias, l.topics,
         array(select unnest(l.experiences) intersect select unnest(p_experiences)) as shared_experiences,
         match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language) + l.reputation as score,
         l.helped, p.channel
  from listeners l
  join people p on p.id = l.person_id
  where l.status = 'free'
    and l.expires_at > now()
    and l.person_id <> p_venter
    and p.suspended_at is null
    and (p_chat is null or not (p_chat = any(l.skipped)))
    and not exists (
      select 1 from blocks b
      where (b.blocker_id = p_venter and b.blocked_id = l.person_id)
         or (b.blocker_id = l.person_id and b.blocked_id = p_venter))
  order by score desc, l.since asc
  limit p_limit
$$;

create or replace function claim_listener(p_chat uuid, p_venter uuid, p_topics text[], p_experiences text[],
                                          p_language text, p_pick uuid, p_close_only boolean)
returns setof listeners
language sql set search_path = public, pg_temp as $$
  with picked as (
    select l.person_id, p.channel
    from listeners l
    join people p on p.id = l.person_id
    where l.status = 'free'
      and l.expires_at > now()
      and l.person_id <> p_venter
      and p.suspended_at is null
      and (p_pick is null or l.person_id = p_pick)
      and (not p_close_only or l.experiences && p_experiences)
      and not (p_chat = any(l.skipped))
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = p_venter and b.blocked_id = l.person_id)
           or (b.blocker_id = l.person_id and b.blocked_id = p_venter))
    order by match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language) + l.reputation desc,
             l.since asc
    limit 1
    for update of l skip locked
  )
  update listeners l
     set status = case when picked.channel = 'telegram' then 'offered' else 'reserved' end,
         chat_id = p_chat,
         status_at = now()
    from picked
   where l.person_id = picked.person_id
  returning l.*
$$;

grant select, insert, update, delete on feedback to yb_app;
drop policy if exists app_all on feedback;
create policy app_all on feedback for all to yb_app using (true) with check (true);
revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int) from public;
grant execute on function listener_candidates(uuid, text[], text[], text, uuid, int) to yb_app;

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on feedback from anon, authenticated;
    revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int) from anon, authenticated;
  end if;
end $$;
