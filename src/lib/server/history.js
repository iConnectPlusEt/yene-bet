// A person's own past conversations. Each side has its own copy: removing
// one hides it from that person only, and the text is deleted for good once
// nobody can see it any more (or after KEEP_DAYS, see cleanup in chat.js).
import { db } from './db.js';
import { visibleMessages } from './chat.js';

const roleIn = (chat, personId) => (chat.venter_id === personId ? 'venter' : 'listener');

/** Ended conversations this person can still see, newest first. */
export async function listHistory(person) {
  const rows = await db()`
    select * from chats
    where status = 'ended'
      and ((venter_id = ${person.id} and not hidden_for_venter)
        or (listener_id = ${person.id} and not hidden_for_listener))
    order by ended_at desc
    limit 50`;
  return rows.map((chat) => {
    const role = roleIn(chat, person.id);
    return {
      id: chat.id,
      role,
      with: chat.listener_id ? (role === 'venter' ? chat.listener_alias : chat.venter_alias) : null,
      // A vent nobody answered, or one only the AI answered, has no person.
      answered: Boolean(chat.listener_id),
      opening: chat.opening.length > 140 ? `${chat.opening.slice(0, 140)}…` : chat.opening,
      experiences: chat.experiences,
      endedAt: chat.ended_at,
    };
  });
}

async function ownChat(person, chatId) {
  const [chat] = await db()`
    select * from chats
    where id = ${chatId} and status = 'ended'
      and ((venter_id = ${person.id} and not hidden_for_venter)
        or (listener_id = ${person.id} and not hidden_for_listener))`;
  return chat || null;
}

/** One past conversation, exactly as this person saw it. */
export async function openHistory(person, chatId) {
  const chat = await ownChat(person, chatId);
  if (!chat) return { ok: false, error: 'not_found' };
  const role = roleIn(chat, person.id);
  return {
    ok: true,
    chat: {
      id: chat.id,
      role,
      with: chat.listener_id ? (role === 'venter' ? chat.listener_alias : chat.venter_alias) : null,
      answered: Boolean(chat.listener_id),
      opening: chat.opening,
      endedAt: chat.ended_at,
    },
    messages: await visibleMessages(chat, role, 0),
  };
}

// Delete conversations nobody can see any more. Reported ones are kept for review.
async function deleteUnseen(personId) {
  await db()`
    delete from chats
    where status = 'ended' and not reported
      and (venter_id = ${personId} or listener_id = ${personId})
      and hidden_for_venter and (hidden_for_listener or listener_id is null)`;
}

export async function removeHistory(person, chatId) {
  const chat = await ownChat(person, chatId);
  if (!chat) return { ok: false, error: 'not_found' };
  if (roleIn(chat, person.id) === 'venter') await db()`update chats set hidden_for_venter = true where id = ${chat.id}`;
  else await db()`update chats set hidden_for_listener = true where id = ${chat.id}`;
  await deleteUnseen(person.id);
  return { ok: true };
}

export async function removeAllHistory(person) {
  const sql = db();
  await sql`update chats set hidden_for_venter = true where status = 'ended' and venter_id = ${person.id}`;
  await sql`update chats set hidden_for_listener = true where status = 'ended' and listener_id = ${person.id}`;
  await deleteUnseen(person.id);
  return { ok: true };
}
