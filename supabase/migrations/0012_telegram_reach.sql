-- Telegram: asking the right people, remembering what they answer, a first-time
-- welcome, and gentle nudges for people who joined but never started.

-- What a person answered to a "can you listen?" request: yes, not now, not for a
-- week, stop. Null means they did not answer, which is different from saying no.
alter table pings add column if not exists response text check (response in ('yes', 'not_now', 'week', 'stop'));

-- The first-time "how it works" message, shown once.
alter table people add column if not exists welcomed_at timestamptz;

-- Nudges for people who agreed to the rules but never vented or listened:
-- at most two, a week apart, and "not for me" stops them for good.
alter table people add column if not exists nudged_at timestamptz;
alter table people add column if not exists nudge_count smallint not null default 0;
alter table people add column if not exists nudge_stopped boolean not null default false;
