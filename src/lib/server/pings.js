// Messaging listeners who are not in the app. Only Telegram listeners who
// opted in, only for an experience they share, and never too often.
import { db } from './db.js';
import { sendText, button } from './telegramApi.js';
import { experienceLabels } from '../experiences.js';

export const PINGS_PER_CHAT = 3;       // how many listeners are asked for one venter
export const PINGS_PER_DAY = 3;        // per listener
export const PING_GAP_MINS = 30;       // per listener

export async function setPings(personId, enabled) {
  await db()`
    insert into listener_profiles (person_id, ping_enabled) values (${personId}, ${enabled})
    on conflict (person_id) do update set ping_enabled = excluded.ping_enabled`;
}

/**
 * Ask up to three opted-in listeners who share an experience with this chat
 * whether they are free. Returns how many were asked.
 */
export async function pingForChat(chat) {
  if (!chat.experiences?.length) return 0;
  const sql = db();
  const people = await sql`
    select p.id, p.tg_chat_id,
           array(select unnest(lp.experiences) intersect select unnest(${chat.experiences}::text[])) as shared
    from listener_profiles lp
    join people p on p.id = lp.person_id
    where lp.ping_enabled
      and p.channel = 'telegram'
      and p.suspended_at is null
      and p.id <> ${chat.venter_id}
      and lp.experiences && ${chat.experiences}::text[]
      and not exists (select 1 from listeners l where l.person_id = p.id)
      and not exists (select 1 from chats c where c.status = 'active' and (c.venter_id = p.id or c.listener_id = p.id))
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${chat.venter_id} and b.blocked_id = p.id)
           or (b.blocker_id = p.id and b.blocked_id = ${chat.venter_id}))
      and not exists (select 1 from pings g where g.person_id = p.id and g.chat_id = ${chat.id})
      and not exists (
        select 1 from pings g
        where g.person_id = p.id and g.created_at > now() - make_interval(mins => ${PING_GAP_MINS}))
      and (select count(*) from pings g where g.person_id = p.id and g.created_at > now() - interval '1 day') < ${PINGS_PER_DAY}
    order by cardinality(array(select unnest(lp.experiences) intersect select unnest(${chat.experiences}::text[]))) desc,
             lp.helped_count desc
    limit ${PINGS_PER_CHAT}`;

  return sendPings(people, chat, (person) =>
    `Someone needs to talk about ${experienceLabels(person.shared)}, which you have been through. Are you free to listen right now?`);
}

/**
 * Someone has been waiting with nobody free. Ask opted-in listeners whether
 * they can help, whatever their own experience. Same limits as above.
 */
export async function pingAnyoneFor(chat) {
  const sql = db();
  const people = await sql`
    select p.id, p.tg_chat_id
    from listener_profiles lp
    join people p on p.id = lp.person_id
    where lp.ping_enabled
      and p.channel = 'telegram'
      and p.suspended_at is null
      and p.id <> ${chat.venter_id}
      and not exists (select 1 from listeners l where l.person_id = p.id)
      and not exists (select 1 from chats c where c.status = 'active' and (c.venter_id = p.id or c.listener_id = p.id))
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${chat.venter_id} and b.blocked_id = p.id)
           or (b.blocker_id = p.id and b.blocked_id = ${chat.venter_id}))
      and not exists (select 1 from pings g where g.person_id = p.id and g.chat_id = ${chat.id})
      and not exists (
        select 1 from pings g
        where g.person_id = p.id and g.created_at > now() - make_interval(mins => ${PING_GAP_MINS}))
      and (select count(*) from pings g where g.person_id = p.id and g.created_at > now() - interval '1 day') < ${PINGS_PER_DAY}
    order by lp.helped_count desc
    limit ${PINGS_PER_CHAT}`;
  return sendPings(people, chat, () => 'Someone has been waiting to be heard and nobody is free. Can you listen right now?');
}

async function sendPings(people, chat, textFor) {
  const sql = db();
  for (const person of people) {
    await sql`insert into pings (person_id, chat_id) values (${person.id}, ${chat.id})`;
    await sendText(
      person.tg_chat_id,
      textFor(person),
      [[button('I am free', `ping:${chat.id}`)], [button('Not now', 'ping:no')]],
    );
  }
  return people.length;
}
