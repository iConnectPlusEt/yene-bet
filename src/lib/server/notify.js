// Telling people that a conversation needs them, without ever sending what was
// written (so nothing private shows on a lock screen). Telegram people already
// receive every message through the bot; this reaches website visitors who
// linked Telegram, and nudges anyone who has left someone waiting.
import crypto from 'node:crypto';
import { db } from './db.js';
import { sendText } from './telegramApi.js';
import { allow } from './rateLimit.js';
import { sendPush, hasPush } from './push.js';

export const AWAY_SECS = 60;           // a web person counts as away after this long without the page open
export const REPLY_GAP_MINS = 10;      // at most one "replied" notification this often per conversation
export const REMIND_AFTER = [2, 24];   // hours of silence before the first and second reminder; then it stops

const siteUrl = () => (process.env.APP_URL || process.env.URL || '').replace(/\/$/, '');
const openButton = () => (siteUrl() ? [[{ text: 'Open My Home', url: siteUrl() }]] : undefined);

/** Where this person can be reached while away: their Telegram chat, if they have one. */
export function reachChatId(person) {
  if (!person) return null;
  return person.channel === 'telegram' ? person.tg_chat_id : person.notify_tg_chat_id || null;
}

/** A website visitor can be reached by browser alert and/or by their linked Telegram. */
async function canReach(person) {
  return Boolean(person.notify_tg_chat_id) || (await hasPush(person.id));
}

/** Tell a website visitor something short, on every channel they allowed. Never message text. */
async function tellWeb(person, { title, body, tag }) {
  await sendPush(person.id, { title, body, url: '/', tag });
  if (person.notify_tg_chat_id) await sendText(person.notify_tg_chat_id, body, openButton());
}

async function isAway(personId) {
  const [row] = await db()`
    select (last_seen_at < now() - make_interval(secs => ${AWAY_SECS})) as away from people where id = ${personId}`;
  return Boolean(row?.away);
}

/** Allow one notification per conversation per REPLY_GAP_MINS. */
async function claimSlot(chatId) {
  const rows = await db()`
    update chats set last_notified_at = now()
    where id = ${chatId} and (last_notified_at is null or last_notified_at < now() - make_interval(mins => ${REPLY_GAP_MINS}))
    returning id`;
  return rows.length > 0;
}

/**
 * The other person wrote. A website visitor who linked Telegram and is away is
 * told; Telegram people already got the message itself.
 */
export async function notifyReply(chat, fromRole, people) {
  if (chat.mode !== 'human') return;
  const to = people[fromRole === 'venter' ? 'listener' : 'venter'];
  if (!to || to.channel !== 'web' || !(await canReach(to))) return;
  if (!(await isAway(to.id)) || !(await claimSlot(chat.id))) return;
  const alias = fromRole === 'venter' ? chat.venter_alias : chat.listener_alias;
  await tellWeb(to, { title: 'New reply', body: `${alias} replied. Open My Home to read it.`, tag: `chat-${chat.id}` });
}

/** A listener joined a venter who is away from the website. */
export async function notifyJoined(chat, people) {
  const venter = people.venter;
  if (!venter || venter.channel !== 'web' || !(await canReach(venter))) return;
  if (!(await isAway(venter.id)) || !(await claimSlot(chat.id))) return;
  await tellWeb(venter, {
    title: `${chat.listener_alias} is here`,
    body: `${chat.listener_alias} has joined. Open My Home to talk.`,
    tag: `chat-${chat.id}`,
  });
}

/**
 * A reminder when someone has been waiting for an answer: after 2 hours, once
 * more after 24, then it stops until the conversation moves again. Run by the
 * one-minute background job. Conversations are never ended by it.
 */
export async function sendReminders() {
  const sql = db();
  const due = await sql`
    update chats c set reminders_sent = reminders_sent + 1, reminder_at = now()
    where c.status = 'active' and c.mode = 'human' and c.last_sender in ('venter', 'listener')
      and ((c.reminders_sent = 0 and c.last_message_at < now() - make_interval(hours => ${REMIND_AFTER[0]}))
        or (c.reminders_sent = 1 and c.last_message_at < now() - make_interval(hours => ${REMIND_AFTER[1]})))
    returning c.*`;
  let sent = 0;
  for (const chat of due) {
    const owesRole = chat.last_sender === 'venter' ? 'listener' : 'venter';
    const waitingAlias = chat.last_sender === 'venter' ? chat.venter_alias : chat.listener_alias;
    const [person] = await sql`select * from people where id = ${owesRole === 'listener' ? chat.listener_id : chat.venter_id}`;
    const target = reachChatId(person);
    const viaPush = person.channel === 'web' && (await hasPush(person.id));
    if (!target && !viaPush) continue;
    const text = person.channel === 'telegram'
      ? `${waitingAlias} is waiting to hear from you. Just reply here.`
      : `${waitingAlias} is waiting to hear from you.`;
    if (viaPush) await sendPush(person.id, { title: 'Someone is waiting', body: text, url: '/', tag: `chat-${chat.id}` });
    if (target) await sendText(target, text, person.channel === 'web' ? openButton() : undefined);
    sent += 1;
  }
  return sent;
}

// ── linking a website visitor to Telegram, for notifications only ──

const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');

/** A one-time code, valid 15 minutes, to put in the bot's start link. */
export async function createLinkCode(person) {
  if (!(await allow(`link:${person.id}`, 10, 3600))) return null;
  const code = crypto.randomBytes(12).toString('hex');
  await db()`
    insert into link_codes (code_hash, person_id, expires_at)
    values (${hash(code)}, ${person.id}, now() + interval '15 minutes')`;
  return code;
}

/** The bot received /start link_<code>. Returns true when the visitor is now linked. */
export async function consumeLinkCode(code, tgChatId) {
  if (!/^[0-9a-f]{24}$/.test(code || '')) return false;
  const rows = await db()`
    update link_codes set used_at = now()
    where code_hash = ${hash(code)} and used_at is null and expires_at > now()
    returning person_id`;
  if (!rows.length) return false;
  await db()`update people set notify_tg_chat_id = ${tgChatId} where id = ${rows[0].person_id} and channel = 'web'`;
  return true;
}

/** Stop notifying this Telegram chat. Returns how many website visitors were unlinked. */
export async function unlinkChat(tgChatId) {
  const rows = await db()`update people set notify_tg_chat_id = null where notify_tg_chat_id = ${tgChatId} returning id`;
  return rows.length;
}
