-- Honest waiting room, saved conversations, and the "someone is waiting" message.

-- false = no AI is replying in this chat; the venter is in the waiting room.
alter table chats add column if not exists ai_active boolean not null default true;
-- When away listeners were told that this person is still waiting.
alter table chats add column if not exists wait_pinged_at timestamptz;
-- Each person can remove a past conversation from their own history.
alter table chats add column if not exists hidden_for_venter boolean not null default false;
alter table chats add column if not exists hidden_for_listener boolean not null default false;

create index if not exists chats_history_venter on chats (venter_id, ended_at desc) where status = 'ended';
create index if not exists chats_history_listener on chats (listener_id, ended_at desc) where status = 'ended';
