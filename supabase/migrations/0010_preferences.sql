-- Preferences (age range, gender, language), notifications for website users
-- who link Telegram, and reminders for quiet conversations.

-- What a person says about themselves and who they would like to talk to.
-- Everything is optional (null / empty = no preference) and is never shown to
-- anyone else: it only changes the order in which people are offered to each other.
alter table people add column if not exists age_band text check (age_band in ('18-24', '25-34', '35-44', '45+'));
alter table people add column if not exists gender text check (gender in ('woman', 'man', 'private'));
alter table people add column if not exists language_pref text check (language_pref in ('en', 'am', 'other'));
alter table people add column if not exists wants_age text[] not null default '{}';
alter table people add column if not exists wants_gender text check (wants_gender in ('woman', 'man', 'same'));
-- Set once the person has seen the preferences screen (saved or skipped).
alter table people add column if not exists prefs_seen_at timestamptz;
-- A website visitor who linked Telegram to be notified (never used to merge identities).
alter table people add column if not exists notify_tg_chat_id bigint;

-- Copied to the pool and to each conversation when they are created, like experiences.
alter table listeners add column if not exists age_band text;
alter table listeners add column if not exists gender text;
alter table listeners add column if not exists wants_age text[] not null default '{}';
alter table listeners add column if not exists wants_gender text;

alter table chats add column if not exists venter_age_band text;
alter table chats add column if not exists venter_gender text;
alter table chats add column if not exists venter_wants_age text[] not null default '{}';
alter table chats add column if not exists venter_wants_gender text;

-- Quiet conversations stay open. These support the notifications about them.
alter table chats add column if not exists last_sender text;            -- 'venter' | 'listener' (people only)
alter table chats add column if not exists last_notified_at timestamptz;
alter table chats add column if not exists reminders_sent smallint not null default 0;
alter table chats add column if not exists reminder_at timestamptz;
-- Who asked to finish ('venter' | 'listener'). The chat stays open until the other person agrees.
alter table chats add column if not exists end_requested_by text;

-- What the person who vents asked for: 'advice' or just to be heard ('listen').
alter table chats add column if not exists intent text check (intent in ('advice', 'listen'));

-- A message can answer one earlier message in the same conversation.
alter table messages add column if not exists reply_to bigint references messages(id) on delete set null;

-- One-time codes that tie a website visitor to a Telegram chat for notifications.
create table if not exists link_codes (
  code_hash  text primary key,
  person_id  uuid not null references people(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);
alter table link_codes enable row level security;
grant select, insert, update, delete on link_codes to yb_app;
drop policy if exists app_all on link_codes;
create policy app_all on link_codes for all to yb_app using (true) with check (true);

-- How well two people's stated preferences fit, 0 to 4: one point for each
-- thing a person asked for that the other one is. Nothing is ever required,
-- so this only changes the order.
create or replace function pref_score(
  a_age text, a_gender text, a_wants_age text[], a_wants_gender text,
  b_age text, b_gender text, b_wants_age text[], b_wants_gender text)
returns int language sql immutable set search_path = public, pg_temp as $$
  select
      (case when cardinality(coalesce(a_wants_age, '{}')) > 0 and b_age = any(a_wants_age) then 1 else 0 end)
    + (case when a_wants_gender in ('woman', 'man') and b_gender = a_wants_gender then 1
            when a_wants_gender = 'same' and a_gender in ('woman', 'man') and b_gender = a_gender then 1
            else 0 end)
    + (case when cardinality(coalesce(b_wants_age, '{}')) > 0 and a_age = any(b_wants_age) then 1 else 0 end)
    + (case when b_wants_gender in ('woman', 'man') and a_gender = b_wants_gender then 1
            when b_wants_gender = 'same' and b_gender in ('woman', 'man') and a_gender = b_gender then 1
            else 0 end)
$$;

drop function if exists match_score(text[], text[], text, text[], text[], text);
drop function if exists listener_candidates(uuid, text[], text[], text, uuid, int);
drop function if exists claim_listener(uuid, uuid, text[], text[], text, uuid, boolean);

-- A shared experience counts 5, so even a perfect preference fit (4) never
-- outranks it. A shared topic and a shared language count 1 each.
create or replace function match_score(l_experiences text[], l_topics text[], l_language text,
                                       p_experiences text[], p_topics text[], p_language text, p_pref int)
returns int language sql immutable set search_path = public, pg_temp as $$
  select 5 * cardinality(array(select unnest(l_experiences) intersect select unnest(p_experiences)))
       + cardinality(array(select unnest(l_topics) intersect select unnest(p_topics)))
       + case when l_language = p_language then 1 else 0 end
       + coalesce(p_pref, 0)
$$;

create or replace function listener_candidates(p_venter uuid, p_topics text[], p_experiences text[],
                                               p_language text, p_chat uuid, p_limit int,
                                               p_age text, p_gender text, p_wants_age text[], p_wants_gender text)
returns table (person_id uuid, alias text, topics text[], shared_experiences text[], score int,
               helped int, channel text)
language sql stable set search_path = public, pg_temp as $$
  select l.person_id, l.alias, l.topics,
         array(select unnest(l.experiences) intersect select unnest(p_experiences)) as shared_experiences,
         match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language,
                     pref_score(p_age, p_gender, p_wants_age, p_wants_gender,
                                l.age_band, l.gender, l.wants_age, l.wants_gender)) + l.reputation as score,
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
                                          p_language text, p_pick uuid, p_close_only boolean,
                                          p_age text, p_gender text, p_wants_age text[], p_wants_gender text)
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
    order by match_score(l.experiences, l.topics, l.language, p_experiences, p_topics, p_language,
                         pref_score(p_age, p_gender, p_wants_age, p_wants_gender,
                                    l.age_band, l.gender, l.wants_age, l.wants_gender)) + l.reputation desc,
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

revoke execute on function pref_score(text, text, text[], text, text, text, text[], text) from public;
revoke execute on function match_score(text[], text[], text, text[], text[], text, int) from public;
revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int, text, text, text[], text) from public;
revoke execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean, text, text, text[], text) from public;
grant execute on function pref_score(text, text, text[], text, text, text, text[], text) to yb_app;
grant execute on function match_score(text[], text[], text, text[], text[], text, int) to yb_app;
grant execute on function listener_candidates(uuid, text[], text[], text, uuid, int, text, text, text[], text) to yb_app;
grant execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean, text, text, text[], text) to yb_app;

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on link_codes from anon, authenticated;
    revoke execute on function pref_score(text, text, text[], text, text, text, text[], text) from anon, authenticated;
    revoke execute on function match_score(text[], text[], text, text[], text[], text, int) from anon, authenticated;
    revoke execute on function listener_candidates(uuid, text[], text[], text, uuid, int, text, text, text[], text) from anon, authenticated;
    revoke execute on function claim_listener(uuid, uuid, text[], text[], text, uuid, boolean, text, text, text[], text) from anon, authenticated;
  end if;
end $$;
