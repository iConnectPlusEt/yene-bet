-- Matching on specific experiences instead of broad topics alone.

-- What a listener has been through, saved once and reused every time they
-- make themselves available.
create table if not exists listener_profiles (
  person_id   uuid primary key references people(id) on delete cascade,
  story       text not null default '',
  topics      text[] not null default '{}',
  experiences text[] not null default '{}',
  language    text not null default 'en',
  updated_at  timestamptz not null default now()
);
alter table listener_profiles enable row level security;

alter table listeners add column if not exists experiences text[] not null default '{}';
alter table listeners add column if not exists language text not null default 'en';

alter table chats add column if not exists experiences text[] not null default '{}';
alter table chats add column if not exists language text not null default 'en';
-- Until this time only listeners who share an experience are taken for the
-- chat; afterwards anyone free will do.
alter table chats add column if not exists match_until timestamptz not null default now();

drop function if exists listener_candidates(uuid, text[], uuid, int);
drop function if exists claim_listener(uuid, uuid, text[], uuid);

-- How well a listener fits: a shared experience counts three times a shared
-- topic, and speaking the same language counts as much as a topic.
create or replace function match_score(l_experiences text[], l_topics text[], l_language text,
                                       p_experiences text[], p_topics text[], p_language text)
returns int language sql immutable set search_path = public, pg_temp as $$
  select 3 * cardinality(array(select unnest(l_experiences) intersect select unnest(p_experiences)))
       + cardinality(array(select unnest(l_topics) intersect select unnest(p_topics)))
       + case when l_language = p_language then 1 else 0 end
$$;

create or replace function listener_candidates(p_venter uuid, p_topics text[], p_experiences text[],
                                               p_language text, p_chat uuid, p_limit int)
returns table (person_id uuid, alias text, topics text[], shared_experiences text[], score int,
               listens_count int, channel text)
language sql stable set search_path = public, pg_temp as $$
  select l.person_id, l.alias, l.topics,
         array(select unnest(l.experiences) intersect select unnest(p_experiences)) as shared_experiences,
         match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language) as score,
         p.listens_count, p.channel
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

-- Take one free listener for a chat (see 0001 for why SKIP LOCKED). With
-- p_close_only, only a listener who shares an experience qualifies.
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
    order by match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language) desc, l.since asc
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

grant select, insert, update, delete on listener_profiles to yb_app;
drop policy if exists app_all on listener_profiles;
create policy app_all on listener_profiles for all to yb_app using (true) with check (true);

revoke execute on function match_score(text[], text[], text, text[], text[], text) from public;
revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int) from public;
revoke execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean) from public;
grant execute on function match_score(text[], text[], text, text[], text[], text) to yb_app;
grant execute on function listener_candidates(uuid, text[], text[], text, uuid, int) to yb_app;
grant execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean) to yb_app;

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on listener_profiles from anon, authenticated;
    revoke execute on function match_score(text[], text[], text, text[], text[], text) from anon, authenticated;
    revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int) from anon, authenticated;
    revoke execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean) from anon, authenticated;
  end if;
end $$;
