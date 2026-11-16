// Matching and conversations. The website routes and the Telegram bot both
// call these functions, which is what puts everyone in one pool.
import { db } from './db.js';
import { LIMITS } from './rateLimit.js';
import { deliverMessage, nudge, offerToListener, handoffBanner, afterChatMenu, missedOffer } from './delivery.js';
import { randomAlias } from '../aliases.js';
import { topicsFor, cleanTopics } from '../topics.js';
import { checkBody, looksLikeCrisis, looksLikeContact } from '../safety.js';
import { SYS } from '../strings.js';

export const WEB_LISTENER_TTL = 10;          // seconds a web listener stays available without a heartbeat
export const AWAY_SECS = 20;                 // a web partner silent this long is shown as away
export const TELEGRAM_LISTENER_TTL = 30 * 60; // seconds a Telegram listener stays available
export const OFFER_SECS = 20;                // how long a Telegram listener has to accept
export const RESERVE_SECS = 60;              // how long a venter has to answer "a real person is free"
export const IDLE_END_MINS = 30;             // a silent chat is closed after this
export const REPORTS_TO_SUSPEND = 3;

const fail = (error) => ({ ok: false, error });

// ───────────────────────── lookups ─────────────────────────

export async function activeChatFor(personId) {
  const [chat] = await db()`
    select * from chats
    where status = 'active' and (venter_id = ${personId} or listener_id = ${personId})
    limit 1`;
  if (!chat) return null;
  return { chat, role: chat.venter_id === personId ? 'venter' : 'listener' };
}

async function peopleOf(chat) {
  const ids = [chat.venter_id, chat.listener_id].filter(Boolean);
  const rows = await db()`select * from people where id in ${db()(ids)}`;
  return {
    venter: rows.find((p) => p.id === chat.venter_id) || null,
    listener: rows.find((p) => p.id === chat.listener_id) || null,
  };
}

async function personById(id) {
  const [p] = await db()`select * from people where id = ${id}`;
  return p || null;
}

// ───────────────────────── messages ─────────────────────────

async function addMessage(chat, { sender, body, kind = 'text', toRole = null }, people) {
  const sql = db();
  const [msg] = await sql`
    insert into messages (chat_id, sender, to_role, kind, body)
    values (${chat.id}, ${sender}, ${toRole}, ${kind}, ${body})
    returning *`;
  if (sender !== 'system') await sql`update chats set last_message_at = now() where id = ${chat.id}`;
  await deliverMessage(msg, people || (await peopleOf(chat)));
  return msg;
}

/** Show the help card to whoever wrote something worrying, and warn the other side. */
async function crisisCards(chat, role, people) {
  await addMessage(chat, { sender: 'system', kind: 'help', body: 'help', toRole: role }, people);
  const other = role === 'venter' ? 'listener' : 'venter';
  if (chat.mode === 'human' && people[other]) {
    await addMessage(chat, { sender: 'system', body: SYS.crisisToOther, toRole: other }, people);
  }
}

// ───────────────────────── matching ─────────────────────────

/** Up to three listeners a venter could pick from, best match first. */
export async function candidates(person, text, pickedTopics) {
  const topics = topicsFor(text, pickedTopics);
  const rows = await db()`select * from listener_candidates(${person.id}, ${topics}, null, 3)`;
  return {
    topics,
    candidates: rows.map((r) => ({
      id: r.person_id,
      alias: r.alias,
      topics: r.topics,
      shared: r.shared,
      listens: r.listens_count,
    })),
  };
}

async function claim(chat, pick = null) {
  const [row] = await db()`select * from claim_listener(${chat.id}, ${chat.venter_id}, ${chat.topics}, ${pick})`;
  return row || null;
}

async function releaseListener(personId, skipChatId = null) {
  await db()`
    update listeners
       set status = 'free', chat_id = null, status_at = now(),
           skipped = case when ${skipChatId}::uuid is null then skipped else array_append(skipped, ${skipChatId}::uuid) end
     where person_id = ${personId} and status in ('offered', 'reserved')`;
}

/**
 * A listener has been taken for this chat. Web listeners are on the waiting
 * screen, so they are ready now; Telegram listeners are asked to accept first.
 */
async function listenerClaimed(chat, listenerRow) {
  const person = await personById(listenerRow.person_id);
  if (listenerRow.status === 'offered') {
    await offerToListener(person, chat);
    return false;
  }
  return listenerReady(chat, listenerRow);
}

/**
 * A listener is ready to talk. If the venter has only written their opening
 * message, connect straight away. If they are already mid-conversation with
 * the AI, hold the listener and let the venter choose.
 */
async function listenerReady(chat, listenerRow) {
  const sql = db();
  const [{ n }] = await sql`
    select count(*)::int as n from messages where chat_id = ${chat.id} and sender = 'venter' and to_role is null`;
  if (n <= 1) return connectHuman(chat, listenerRow);
  await sql`update listeners set status = 'reserved', status_at = now() where person_id = ${listenerRow.person_id}`;
  await handoffBanner(await personById(chat.venter_id), listenerRow.alias);
  return false;
}

async function connectHuman(chat, listenerRow) {
  const sql = db();
  const [updated] = await sql`
    update chats
       set mode = 'human', listener_id = ${listenerRow.person_id}, listener_alias = ${listenerRow.alias},
           ai_pending = false, last_message_at = now(),
           listener_from_id = (select coalesce(max(id), 0) from messages where chat_id = ${chat.id})
     where id = ${chat.id} and status = 'active' and mode = 'ai'
    returning *`;
  if (!updated) {
    await releaseListener(listenerRow.person_id);
    return false;
  }
  await sql`update listeners set status = 'busy', chat_id = ${chat.id}, status_at = now() where person_id = ${listenerRow.person_id}`;
  await sql`update people set listens_count = listens_count + 1 where id = ${listenerRow.person_id}`;

  const people = await peopleOf(updated);
  const [{ had_ai }] = await sql`
    select exists(select 1 from messages where chat_id = ${chat.id} and sender = 'ai') as had_ai`;
  await addMessage(updated, {
    sender: 'system', toRole: 'venter',
    body: had_ai ? SYS.humanJoined(listenerRow.alias) : SYS.connected(listenerRow.alias),
  }, people);
  await addMessage(updated, { sender: 'system', toRole: 'listener', body: SYS.listenerIntro }, people);
  // The listener's copy of the opening message, so they know what this is about.
  await addMessage(updated, { sender: 'venter', toRole: 'listener', body: updated.opening }, people);
  return true;
}

// ───────────────────────── venting ─────────────────────────

/**
 * Start a conversation. Connects to a real listener when one is free;
 * otherwise the AI listener starts and a person is offered later.
 * Returns { ok, chatId, needsAi } — the caller runs the AI when needsAi.
 */
export async function startVent(person, { text, topics: picked, pick = null }) {
  if (person.suspended_at) return fail('suspended');
  if (!person.rules_accepted_at) return fail('rules');
  const checked = checkBody(text);
  if (!checked.ok) return fail(checked.error);
  if (await activeChatFor(person.id)) return fail('in_chat');
  if (!(await LIMITS.start(person.id))) return fail('rate_limited');

  const sql = db();
  await sql`delete from listeners where person_id = ${person.id}`;
  const topics = topicsFor(checked.body, picked);
  const [chat] = await sql`
    insert into chats (venter_id, venter_alias, topics, opening)
    values (${person.id}, ${randomAlias()}, ${topics}, ${checked.body})
    returning *`;
  const people = { venter: person, listener: null };
  await addMessage(chat, { sender: 'venter', body: checked.body }, people);

  let connected = false;
  const listenerRow = (pick && (await claim(chat, pick))) || (await claim(chat));
  if (listenerRow) connected = await listenerClaimed(chat, listenerRow);

  if (!connected) {
    await sql`update chats set ai_pending = true where id = ${chat.id}`;
    await addMessage(chat, { sender: 'system', toRole: 'venter', body: SYS.aiStart }, people);
  }
  if (looksLikeCrisis(checked.body)) {
    const fresh = (await activeChatFor(person.id))?.chat || chat;
    await crisisCards(fresh, 'venter', await peopleOf(fresh));
  }
  return { ok: true, chatId: chat.id, needsAi: !connected };
}

/** Send a message in the person's current conversation. */
export async function sendMessage(person, rawBody, { confirm = false } = {}) {
  const current = await activeChatFor(person.id);
  if (!current) return fail('no_chat');
  const { chat, role } = current;
  const checked = checkBody(rawBody);
  if (!checked.ok) return fail(checked.error);
  if (!confirm && chat.mode === 'human' && looksLikeContact(checked.body)) return { ok: false, warn: 'contact' };
  if (!(await LIMITS.message(person.id))) return fail('rate_limited');

  const people = await peopleOf(chat);
  const message = await addMessage(chat, { sender: role, body: checked.body }, people);
  if (looksLikeCrisis(checked.body)) await crisisCards(chat, role, people);

  const needsAi = chat.mode === 'ai' && role === 'venter';
  if (needsAi) await db()`update chats set ai_pending = true where id = ${chat.id}`;
  return { ok: true, message, chatId: chat.id, needsAi };
}

/** The venter answers "a real person is free now". */
export async function decideHandoff(person, accept) {
  const sql = db();
  const [chat] = await sql`select * from chats where venter_id = ${person.id} and status = 'active' and mode = 'ai'`;
  if (!chat) return fail('no_offer');
  const [listenerRow] = await sql`select * from listeners where chat_id = ${chat.id} and status = 'reserved'`;
  if (!listenerRow) return fail('no_offer');
  if (accept) return { ok: true, connected: await connectHuman(chat, listenerRow) };
  await releaseListener(listenerRow.person_id, chat.id);
  await sql`update chats set wants_human = false where id = ${chat.id}`;
  return { ok: true, connected: false };
}

// ───────────────────────── listening ─────────────────────────

/** Mark a person as available to listen, then try to give them someone. */
export async function goAvailable(person, pickedTopics) {
  if (person.suspended_at) return fail('suspended');
  if (!person.rules_accepted_at) return fail('rules');
  if (await activeChatFor(person.id)) return fail('in_chat');
  const topics = cleanTopics(pickedTopics);
  const ttl = person.channel === 'telegram' ? TELEGRAM_LISTENER_TTL : WEB_LISTENER_TTL;
  await db()`
    insert into listeners (person_id, alias, topics, expires_at)
    values (${person.id}, ${randomAlias()}, ${topics}, now() + make_interval(secs => ${ttl}))
    on conflict (person_id) do update
      set topics = excluded.topics, expires_at = excluded.expires_at`;
  await sweepAndMatch({ force: true });
  return { ok: true };
}

/** Keep a web listener in the pool while their waiting screen is open. */
export async function heartbeat(person) {
  await db()`
    update listeners set expires_at = now() + make_interval(secs => ${WEB_LISTENER_TTL})
    where person_id = ${person.id} and status in ('free', 'reserved')`;
}

export async function stopListening(person) {
  await db()`delete from listeners where person_id = ${person.id} and status <> 'busy'`;
  return { ok: true };
}

/** A Telegram listener answers a request. */
export async function respondOffer(person, accept) {
  const sql = db();
  const [listenerRow] = await sql`select * from listeners where person_id = ${person.id} and status = 'offered'`;
  if (!listenerRow) return fail('no_offer');
  const [chat] = await sql`select * from chats where id = ${listenerRow.chat_id} and status = 'active' and mode = 'ai'`;
  if (!accept || !chat) {
    await releaseListener(person.id, listenerRow.chat_id);
    await sweepAndMatch({ force: true });
    return accept ? fail('gone') : { ok: true, connected: false };
  }
  const connected = await listenerReady(chat, listenerRow);
  return { ok: true, connected, waiting: !connected };
}

// ───────────────────────── ending ─────────────────────────

async function closeChat(chat, endedBy, { toVenter, toListener }) {
  const sql = db();
  const [ended] = await sql`
    update chats set status = 'ended', ended_at = now(), ended_by = ${endedBy}, ai_pending = false
    where id = ${chat.id} and status = 'active' returning *`;
  if (!ended) return false;
  await sql`delete from listeners where chat_id = ${chat.id} and status = 'busy'`;
  await sql`update listeners set status = 'free', chat_id = null, status_at = now()
            where chat_id = ${chat.id} and status in ('offered', 'reserved')`;
  const people = await peopleOf(ended);
  if (toVenter) await addMessage(ended, { sender: 'system', toRole: 'venter', body: toVenter }, people);
  if (toListener && people.listener) await addMessage(ended, { sender: 'system', toRole: 'listener', body: toListener }, people);
  await nudge(people.venter, people.listener);
  await Promise.all([afterChatMenu(people.venter), afterChatMenu(people.listener)]);
  return true;
}

export async function endChat(person) {
  const current = await activeChatFor(person.id);
  if (!current) return fail('no_chat');
  const mine = current.role === 'venter';
  await closeChat(current.chat, current.role, {
    toVenter: mine ? SYS.ended : SYS.endedByOther,
    toListener: mine ? SYS.endedByOther : SYS.ended,
  });
  return { ok: true };
}

/** Report the other person: ends the chat, blocks the pair, and may suspend them. */
export async function report(person, reason = '') {
  const sql = db();
  const [chat] = await sql`
    select * from chats
    where (venter_id = ${person.id} or listener_id = ${person.id})
      and (status = 'active' or ended_at > now() - interval '1 hour')
    order by created_at desc limit 1`;
  if (!chat) return fail('no_chat');
  const otherId = chat.venter_id === person.id ? chat.listener_id : chat.venter_id;
  await sql`
    insert into reports (chat_id, reporter_id, reported_id, reason)
    values (${chat.id}, ${person.id}, ${otherId}, ${String(reason || '').slice(0, 500)})`;
  await sql`update chats set reported = true where id = ${chat.id}`;
  if (otherId) {
    await sql`insert into blocks (blocker_id, blocked_id) values (${person.id}, ${otherId}) on conflict do nothing`;
    const [{ n }] = await sql`select count(distinct reporter_id)::int as n from reports where reported_id = ${otherId}`;
    if (n >= REPORTS_TO_SUSPEND) {
      await sql`update people set suspended_at = coalesce(suspended_at, now()) where id = ${otherId}`;
      await sql`delete from listeners where person_id = ${otherId} and status <> 'busy'`;
    }
  }
  if (chat.status === 'active') {
    await closeChat(chat, 'report', { toVenter: SYS.ended, toListener: SYS.ended });
  }
  return { ok: true };
}

// ───────────────────────── housekeeping ─────────────────────────

let lastSweep = 0;

/**
 * Expire stale holds and pair waiting venters with free listeners. Runs on
 * ordinary requests (at most every 2 seconds per server instance) and from
 * the cleanup job, so no always-on worker is needed.
 */
export async function sweepAndMatch({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweep < 2000) return;
  lastSweep = now;
  const sql = db();

  // Telegram listeners who did not answer in time leave the pool.
  const missed = await sql`
    delete from listeners
    where status = 'offered' and status_at < now() - make_interval(secs => ${OFFER_SECS})
    returning person_id`;
  for (const row of missed) await missedOffer(await personById(row.person_id));

  // Venters who ignored "a real person is free": let the listener go.
  const ignored = await sql`
    update listeners
       set status = 'free', status_at = now(), skipped = array_append(skipped, chat_id), chat_id = null
     where status = 'reserved' and status_at < now() - make_interval(secs => ${RESERVE_SECS})
    returning person_id, skipped[array_upper(skipped, 1)] as chat_id`;
  for (const row of ignored) await sql`update chats set wants_human = false where id = ${row.chat_id}`;

  await sql`delete from listeners where status = 'free' and expires_at < now()`;

  const idle = await sql`
    select * from chats
    where status = 'active' and last_message_at < now() - make_interval(mins => ${IDLE_END_MINS})
    limit 20`;
  for (const chat of idle) await closeChat(chat, 'idle', { toVenter: SYS.endedIdle, toListener: SYS.endedIdle });

  const waiting = await sql`
    select c.* from chats c
    where c.status = 'active' and c.mode = 'ai' and c.wants_human
      and not exists (select 1 from listeners l where l.chat_id = c.id and l.status in ('offered', 'reserved'))
    order by c.created_at
    limit 20`;
  for (const chat of waiting) {
    const listenerRow = await claim(chat);
    if (!listenerRow) break;
    await listenerClaimed(chat, listenerRow);
  }
}

/** Delete old conversations. Reported ones are kept for review. */
export async function cleanup({ keepDays = 7 } = {}) {
  const sql = db();
  const chats = await sql`
    delete from chats
    where status = 'ended' and not reported and ended_at < now() - make_interval(days => ${keepDays})
    returning id`;
  await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  return { deletedChats: chats.length };
}

// ───────────────────────── state for the website ─────────────────────────

/**
 * Everything a browser needs to draw its screen: whether the person is idle,
 * waiting to listen, or in a conversation, plus any new messages.
 */
export async function getState(person, { after = 0, chatId = null } = {}) {
  const sql = db();
  if (person.channel === 'web') await heartbeat(person);
  await sweepAndMatch();

  let current = await activeChatFor(person.id);
  if (!current && chatId) {
    const [old] = await sql`
      select * from chats where id = ${chatId} and (venter_id = ${person.id} or listener_id = ${person.id})`;
    if (old) current = { chat: old, role: old.venter_id === person.id ? 'venter' : 'listener' };
  }

  const base = {
    rulesAccepted: Boolean(person.rules_accepted_at),
    suspended: Boolean(person.suspended_at),
  };

  if (!current) {
    const [listenerRow] = await sql`select * from listeners where person_id = ${person.id}`;
    return {
      ...base,
      screen: listenerRow ? 'listening' : 'home',
      listening: listenerRow ? { alias: listenerRow.alias, topics: listenerRow.topics } : null,
    };
  }

  const { chat, role } = current;
  const minId = Math.max(Number(after) || 0, role === 'listener' ? Number(chat.listener_from_id) : 0);
  const messages = await sql`
    select id, sender, kind, body, created_at from messages
    where chat_id = ${chat.id} and id > ${minId} and (to_role is null or to_role = ${role})
    order by id`;

  let offer = null;
  if (role === 'venter' && chat.mode === 'ai' && chat.status === 'active') {
    const [held] = await sql`select alias, topics from listeners where chat_id = ${chat.id} and status = 'reserved'`;
    if (held) offer = { alias: held.alias, topics: held.topics };
  }

  // A website partner whose page has stopped checking in has probably left.
  let partnerAway = false;
  if (chat.mode === 'human' && chat.status === 'active') {
    const partnerId = role === 'venter' ? chat.listener_id : chat.venter_id;
    const [partner] = await sql`
      select channel = 'web' and last_seen_at < now() - make_interval(secs => ${AWAY_SECS}) as away
      from people where id = ${partnerId}`;
    partnerAway = Boolean(partner?.away);
  }

  return {
    ...base,
    screen: 'chat',
    chat: {
      id: chat.id,
      role,
      mode: chat.mode,
      status: chat.status,
      topics: chat.topics,
      partner: chat.mode === 'ai' ? null : role === 'venter' ? chat.listener_alias : chat.venter_alias,
      typing: chat.mode === 'ai' && chat.ai_pending,
      partnerAway,
      offer,
    },
    messages: messages.map((m) => ({
      id: Number(m.id),
      from: m.sender === role ? 'me' : m.sender === 'system' ? 'system' : m.sender === 'ai' ? 'ai' : 'them',
      kind: m.kind,
      body: m.body,
      at: m.created_at,
    })),
  };
}
