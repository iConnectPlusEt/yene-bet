-- Wider reach: anyone on Telegram can be asked when someone is waiting, in
-- waves, with easy ways to say "not now" or "stop".

-- Whether this person may be messaged when someone needs to talk. On by
-- default; they are told when they join and can turn it off with one tap.
alter table people add column if not exists notify_requests boolean not null default true;
-- "Not now": left alone until this time.
alter table people add column if not exists notify_snoozed_until timestamptz;
-- Telegram said the bot was blocked or the chat is gone: never message again
-- (cleared if the person writes to the bot themselves).
alter table people add column if not exists unreachable_at timestamptz;
-- When the person was told that the bot may message them.
alter table people add column if not exists notice_shown_at timestamptz;

alter table pings add column if not exists wave smallint not null default 1;
alter table pings add column if not exists answered boolean not null default false;

-- 0 = no wave sent yet, 1/2/3 = the last wave that went out for this chat.
alter table chats add column if not exists ping_wave smallint not null default 0;
alter table chats add column if not exists ping_wave_at timestamptz;

-- A listener who is available for 24 hours and misses one offer stays in the
-- pool; after two misses in a row they are marked as away.
alter table listeners add column if not exists misses smallint not null default 0;
