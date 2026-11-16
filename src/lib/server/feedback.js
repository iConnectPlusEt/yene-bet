// "Did you feel heard?" One answer per conversation, from the person who
// vented. It thanks the listener and shapes who is chosen next time.
import { db } from './db.js';
import { nudge } from './delivery.js';
import { sendText } from './telegramApi.js';
import { looksLikeContact } from '../safety.js';

export const MAX_NOTE_LENGTH = 300;
export const HEARD = { no: 0, little: 1, yes: 2 };

/** -3..3: people helped count for a listener, repeated "no" counts against. */
export function reputationOf(helped, notHeard) {
  return Math.max(-3, Math.min(3, helped - 2 * notHeard));
}

/** The ended conversation this person may still rate, if any. */
export async function rateableChat(personId) {
  const [chat] = await db()`
    select c.* from chats c
    where c.venter_id = ${personId} and c.status = 'ended' and c.listener_id is not null
      and c.ended_at > now() - interval '1 day'
      and not exists (select 1 from feedback f where f.chat_id = c.id)
    order by c.ended_at desc limit 1`;
  return chat || null;
}

export async function giveFeedback(person, { heard, note = '' }) {
  if (![0, 1, 2].includes(heard)) return { ok: false, error: 'invalid' };
  const text = String(note || '').replace(/\u0000/g, '').trim().slice(0, MAX_NOTE_LENGTH);
  if (text && looksLikeContact(text)) return { ok: false, error: 'contact_in_note' };
  const chat = await rateableChat(person.id);
  if (!chat) return { ok: false, error: 'nothing_to_rate' };

  const sql = db();
  const inserted = await sql`
    insert into feedback (chat_id, listener_id, heard, note)
    values (${chat.id}, ${chat.listener_id}, ${heard}, ${text})
    on conflict (chat_id) do nothing returning id`;
  if (!inserted.length) return { ok: false, error: 'nothing_to_rate' };

  await sql`
    insert into listener_profiles (person_id, helped_count, not_heard_count)
    values (${chat.listener_id}, ${heard > 0 ? 1 : 0}, ${heard === 0 ? 1 : 0})
    on conflict (person_id) do update
      set helped_count = listener_profiles.helped_count + excluded.helped_count,
          not_heard_count = listener_profiles.not_heard_count + excluded.not_heard_count`;

  // Tell the listener when they helped. A "no" is recorded but not sent.
  const [listener] = await sql`select * from people where id = ${chat.listener_id}`;
  if (heard > 0 && listener) {
    if (listener.channel === 'telegram') {
      await sendText(listener.tg_chat_id, thanksText({ heard, note: text }));
      await sql`update feedback set seen = true where id = ${inserted[0].id}`;
    } else {
      await nudge(listener);
    }
  } else {
    await sql`update feedback set seen = true where id = ${inserted[0].id}`;
  }
  return { ok: true };
}

export function thanksText({ heard, note }) {
  const line = heard === 2 ? 'Someone you listened to felt heard. Thank you.' : 'Someone you listened to said it helped a little. Thank you.';
  return note ? `${line}\n\nThey wrote: "${note}"` : line;
}

/** Thank-you notes a web listener has not seen yet; marks them as seen. */
export async function takeThanks(personId) {
  const rows = await db()`
    update feedback set seen = true
    where listener_id = ${personId} and not seen and heard > 0
    returning id, heard, note`;
  return rows.map((r) => ({ id: Number(r.id), text: thanksText(r) }));
}
