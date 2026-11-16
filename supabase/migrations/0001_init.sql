-- YENE BET: anonymous venting. All access goes through the server (direct
-- Postgres connection); row-level security is on with no policies, so the
-- public Supabase API keys can read and write nothing.

create table if not exists people (
  id                uuid primary key default gen_random_uuid(),
  channel           text not null check (channel in ('web', 'telegram')),
  token_hash        text unique,            -- web: sha256 of the browser's secret
  poke_key          text not null,          -- web: realtime channel name, not a credential
  tg_chat_id        bigint unique,          -- telegram: where the bot delivers
  tg_state          jsonb not null default '{}'::jsonb,
  rules_accepted_at timestamptz,
  suspended_at      timestamptz,
  listens_count     integer not null default 0,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create table if not exists chats (
  id               uuid primary key default gen_random_uuid(),
  venter_id        uuid not null references people(id) on delete cascade,
  listener_id      uuid references people(id) on delete set null,
  venter_alias     text not null,
  listener_alias   text,
  topics           text[] not null default '{}',
  opening          text not null,
  mode             text not null default 'ai' check (mode in ('ai', 'human')),
  wants_human      boolean not null default true,
  status           text not null default 'active' check (status in ('active', 'ended')),
  ai_pending       boolean not null default false,
  -- The listener sees the opening message plus messages after this id, so
  -- nothing the venter said to the AI is shown to the person who joins.
  listener_from_id bigint not null default 0,
  reported         boolean not null default false,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  ended_at         timestamptz,
  ended_by         text
);
create unique index if not exists chats_one_active_per_venter
  on chats (venter_id) where status = 'active';
create unique index if not exists chats_one_active_per_listener
  on chats (listener_id) where status = 'active' and listener_id is not null;
create index if not exists chats_waiting_for_human
  on chats (created_at) where status = 'active' and mode = 'ai' and wants_human;

-- One row per person who is available to listen right now.
--   free     waiting for a venter
--   offered  (telegram) asked to accept a venter, no answer yet
--   reserved held for a venter who is deciding whether to leave the AI
--   busy     in a chat
create table if not exists listeners (
  person_id  uuid primary key references people(id) on delete cascade,
  alias      text not null,
  topics     text[] not null default '{}',
  status     text not null default 'free' check (status in ('free', 'offered', 'reserved', 'busy')),
  chat_id    uuid references chats(id) on delete set null,
  status_at  timestamptz not null default now(),
  since      timestamptz not null default now(),
  expires_at timestamptz not null,
  skipped    uuid[] not null default '{}'
);
create index if not exists listeners_free on listeners (since) where status = 'free';

create table if not exists messages (
  id         bigint generated always as identity primary key,
  chat_id    uuid not null references chats(id) on delete cascade,
  sender     text not null check (sender in ('venter', 'listener', 'ai', 'system')),
  to_role    text check (to_role in ('venter', 'listener')),  -- null = both sides
  kind       text not null default 'text',
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_chat on messages (chat_id, id);

create table if not exists reports (
  id          bigint generated always as identity primary key,
  chat_id     uuid references chats(id) on delete set null,
  reporter_id uuid not null references people(id) on delete cascade,
  reported_id uuid references people(id) on delete cascade,
  reason      text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists blocks (
  blocker_id uuid not null references people(id) on delete cascade,
  blocked_id uuid not null references people(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null
);

alter table people      enable row level security;
alter table chats       enable row level security;
alter table listeners   enable row level security;
alter table messages    enable row level security;
alter table reports     enable row level security;
alter table blocks      enable row level security;
alter table rate_limits enable row level security;

-- Who a venter may be matched with, best first: most shared topics, then
-- whoever has been waiting longest. A listener with no shared topic still
-- qualifies, so a venter is never left waiting for a perfect match.
create or replace function listener_candidates(p_venter uuid, p_topics text[], p_chat uuid, p_limit int)
returns table (person_id uuid, alias text, topics text[], shared int, listens_count int, channel text)
language sql stable as $$
  select l.person_id, l.alias, l.topics,
         cardinality(array(select unnest(l.topics) intersect select unnest(p_topics))) as shared,
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
  order by shared desc, l.since asc
  limit p_limit
$$;

-- Take one free listener for a chat. SKIP LOCKED means two venters asking at
-- the same moment each get a different listener (or none), never the same one.
-- Telegram listeners become 'offered' (they must accept); web listeners are
-- on the waiting screen already, so they become 'reserved'.
create or replace function claim_listener(p_chat uuid, p_venter uuid, p_topics text[], p_pick uuid default null)
returns setof listeners
language sql as $$
  with picked as (
    select l.person_id, p.channel
    from listeners l
    join people p on p.id = l.person_id
    where l.status = 'free'
      and l.expires_at > now()
      and l.person_id <> p_venter
      and p.suspended_at is null
      and (p_pick is null or l.person_id = p_pick)
      and not (p_chat = any(l.skipped))
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = p_venter and b.blocked_id = l.person_id)
           or (b.blocker_id = l.person_id and b.blocked_id = p_venter))
    order by cardinality(array(select unnest(l.topics) intersect select unnest(p_topics))) desc, l.since asc
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
