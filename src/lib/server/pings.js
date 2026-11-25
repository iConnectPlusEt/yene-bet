// Asking people to listen when someone is waiting. Anyone on Telegram who has
// used the bot can be asked (they are told when they join, and can say "not
// now" or "stop these" with one tap), in waves, best fit first, and never
// more than a few times a day.
import { db } from './db.js';
import { sendText, button } from './telegramApi.js';
import { experienceLabels } from '../experiences.js';
import { LIMITS } from './rateLimit.js';
import { sendPush } from './push.js';

// Speed matters most to someone waiting, so the first wave is wide and the next
// ones follow quickly. Each person is still asked at most PINGS_PER_DAY times.
export const WAVE_SIZES = [8, 15, 30]; // people asked in each wave: 53 at most per venter
export const WAVE2_SECS = 20;          // wave 2 goes out once the venter has waited this long
export const WAVE3_SECS = 60;          // and wave 3 after this long
export const PINGS_PER_DAY = 3;        // per person
export const PING_GAP_MINS = 30;       // per person
export const SNOOZE_HOURS = 2;         // what "Not now" means
export const ACTIVE_DAYS = 30;         // only people who used the bot this recently

export async function setPings(personId, enabled) {
  await db()`
    update people set notify_requests = ${enabled}, notify_snoozed_until = null where id = ${personId}`;
}

export async function snoozePings(personId, hours = SNOOZE_HOURS) {
  await db()`
    update people set notify_snoozed_until = now() + make_interval(hours => ${hours}) where id = ${personId}`;
}

/**
 * People who may be asked about this chat, best fit first: shared experience,
 * then people who have helped before, then anyone. `closeOnly` keeps only
 * people who share an experience with the venter.
 */
async function pickPeople(chat, limit, { closeOnly = false } = {}) {
  const exps = chat.experiences || [];
  return db()`
    select p.id, p.channel, p.tg_chat_id, p.notice_shown_at,
           array(select unnest(coalesce(lp.experiences, '{}'::text[])) intersect select unnest(${exps}::text[])) as shared
    from people p
    left join listener_profiles lp on lp.person_id = p.id
    where (
        -- On Telegram: anyone who has used the bot and has not turned requests off.
        (p.channel = 'telegram' and p.tg_chat_id is not null and p.unreachable_at is null and p.notify_requests)
        -- On the website: anyone who allowed browser alerts.
        or (p.channel = 'web' and exists (
              select 1 from push_subs ps where ps.person_id = p.id and ps.alerts and ps.failed_at is null))
      )
      and p.rules_accepted_at is not null
      and p.suspended_at is null
      and (p.notify_snoozed_until is null or p.notify_snoozed_until < now())
      and p.last_seen_at > now() - make_interval(days => ${ACTIVE_DAYS})
      and p.id <> ${chat.venter_id}
      and (${!closeOnly}::boolean or coalesce(lp.experiences, '{}'::text[]) && ${exps}::text[])
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
    order by cardinality(array(select unnest(coalesce(lp.experiences, '{}'::text[])) intersect select unnest(${exps}::text[]))) desc,
             -- Smarter timing: people who ignored their last three requests go last for now,
             -- and people who answered before (and quickly) go first.
             ((select count(*) from (select answered from pings g where g.person_id = p.id
                                     order by g.created_at desc limit 3) last3 where not last3.answered) = 3) asc,
             (select count(*) from pings g where g.person_id = p.id and g.answered
                and g.created_at > now() - interval '30 days') desc,
             (select coalesce(avg(extract(epoch from (g.answered_at - g.created_at))), 3600) from pings g
               where g.person_id = p.id and g.answered and g.answered_at is not null
                 and g.created_at > now() - interval '30 days') asc,
             coalesce(lp.helped_count, 0) desc, p.listens_count desc, p.last_seen_at desc
    limit ${limit}`;
}

/** What is being asked, in words that carry no private detail: a category and what they want. */
export function requestBody(chat, shared = []) {
  const close = shared?.length ? shared : null;
  const what = close
    ? `${experienceLabels(close)}, which you have been through`
    : chat.experiences?.length ? experienceLabels(chat.experiences) : null;
  const first = what ? `Someone is going through ${what}.` : 'Someone needs to be heard right now.';
  const want = chat.intent === 'advice' ? ' They would like advice.' : ' They just want to be heard.';
  return `${first}${want} Nobody is free to listen. Can you listen right now?`;
}

export function requestText(chat, person) {
  const text = requestBody(chat, person.shared);
  // Anyone who has not yet been told that the bot may message them is told now.
  return person.notice_shown_at ? text : `${text}\n\n(You are getting this because you joined My Home. Tap "Stop these" any time.)`;
}

/**
 * Ask the next people about this chat. `n` is the wave (1-3); a wave 0 call
 * asks only people who share an experience, without starting a new wave (used
 * when the AI finds an experience the word matching missed).
 * Returns how many were asked, and how many of them share an experience.
 */
export async function pingWave(chat, n) {
  const size = n === 0 ? WAVE_SIZES[0] : (WAVE_SIZES[n - 1] ?? WAVE_SIZES[0]);
  const people = await pickPeople(chat, size, { closeOnly: n === 0 });
  const sql = db();
  let sent = 0;
  let close = 0;
  for (const person of people) {
    if (person.channel === 'web') {
      // A browser alert: tapping it opens a one-tap "can you listen?" screen.
      const delivered = await sendPush(person.id, {
        title: 'Someone needs to be heard',
        body: requestBody(chat, person.shared),
        url: `/?help=${chat.id}`,
        tag: `help-${chat.id}`,
      });
      if (!delivered) continue;
      await sql`insert into pings (person_id, chat_id, wave, channel) values (${person.id}, ${chat.id}, ${Math.max(n, 1)}, 'web')`;
    } else {
      await sql`insert into pings (person_id, chat_id, wave, channel) values (${person.id}, ${chat.id}, ${Math.max(n, 1)}, 'telegram')`;
      await sendText(person.tg_chat_id, requestText(chat, person), [
        [button('I can listen', `ping:${chat.id}`)],
        [button('Not now', 'ping:no'), button('Stop these', 'ping:stop')],
      ]);
      if (!person.notice_shown_at) await sql`update people set notice_shown_at = now() where id = ${person.id}`;
    }
    sent += 1;
    if (person.shared.length) close += 1;
  }
  if (sent > 0 && n >= 1) await tellVenterOnTelegram(chat, n);
  return { sent, close };
}

/** The first wave for a new vent, unless this venter has already used up today's allowance. */
export async function startPings(chat) {
  if (!(await LIMITS.pingVent(chat.venter_id))) return { sent: 0, close: 0 };
  return pingWave(chat, 1);
}

/**
 * Someone waiting on Telegram sees how many people have been asked, so the wait
 * feels like progress (the website shows the same line). Only a count is sent.
 */
async function tellVenterOnTelegram(chat, wave) {
  const [venter] = await db()`select channel, tg_chat_id, unreachable_at from people where id = ${chat.venter_id}`;
  if (!venter || venter.channel !== 'telegram' || venter.unreachable_at) return;
  const [{ n }] = await db()`select count(*)::int as n from pings where chat_id = ${chat.id}`;
  const people = `${n} ${n === 1 ? 'person' : 'people'}`;
  await sendText(
    venter.tg_chat_id,
    wave === 1
      ? `I have asked ${people} to listen. You will be connected the moment one says yes.`
      : `Still looking: I have now asked ${people}. You will be connected the moment one says yes.`,
  );
}
