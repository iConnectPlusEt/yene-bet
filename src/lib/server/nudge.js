// A gentle nudge for people who agreed to the rules on Telegram but never vented or
// listened. At most two, a week apart, never at night (Addis Ababa time), and "Not for
// me" stops them for good. Nothing about anyone else is ever included.
import { db } from './db.js';
import { sendText, button } from './telegramApi.js';

export const NUDGE_AFTER_DAYS = 2;     // give people a couple of days before the first one
export const NUDGE_GAP_DAYS = 7;
export const MAX_NUDGES = 2;
export const QUIET_FROM_HOUR = 21;     // no nudges from 21:00 ...
export const QUIET_UNTIL_HOUR = 8;     // ... until 08:00
export const NUDGE_BATCH = 20;         // per run: the job runs every minute, so this spreads them out

const zone = () => process.env.STATS_TZ || 'Africa/Addis_Ababa';

const TEXT = [
  'You joined My Home a few days ago. Whenever you need to say something out loud, or you want to help someone feel heard, it is one tap away.',
  'A quiet reminder: if something is on your mind, or you could spare ten minutes to listen, I am here. No pressure at all.',
];

/** Send the next nudge to whoever is due. Returns how many were sent. */
export async function nudgeDormant() {
  const sql = db();
  const [{ hour }] = await sql`select extract(hour from (now() at time zone ${zone()}))::int as hour`;
  if (hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR) return 0;

  // Claim and count in one step, so two overlapping runs never send the same nudge twice.
  const rows = await sql`
    update people p set nudged_at = now(), nudge_count = p.nudge_count + 1
    where p.id in (
      select q.id from people q
      where q.channel = 'telegram' and q.tg_chat_id is not null and not q.is_test
        and q.rules_accepted_at is not null
        and q.rules_accepted_at < now() - make_interval(days => ${NUDGE_AFTER_DAYS})
        and q.unreachable_at is null and q.suspended_at is null
        and q.notify_requests and not q.nudge_stopped
        and q.nudge_count < ${MAX_NUDGES}
        and (q.nudged_at is null or q.nudged_at < now() - make_interval(days => ${NUDGE_GAP_DAYS}))
        and q.listens_count = 0
        and not exists (select 1 from chats c where c.venter_id = q.id or c.listener_id = q.id)
        and not exists (select 1 from listener_profiles lp where lp.person_id = q.id)
        and not exists (select 1 from listeners l where l.person_id = q.id)
      order by q.rules_accepted_at
      limit ${NUDGE_BATCH}
      for update skip locked)
    returning p.tg_chat_id, p.nudge_count`;

  for (const row of rows) {
    await sendText(row.tg_chat_id, TEXT[Math.min(row.nudge_count, TEXT.length) - 1], [
      [button('I need to vent', 'vent'), button("I'm here to listen", 'listen')],
      [button('Not for me', 'nudge:stop')],
    ]);
  }
  return rows.length;
}

export async function stopNudges(personId) {
  await db()`update people set nudge_stopped = true where id = ${personId}`;
}
