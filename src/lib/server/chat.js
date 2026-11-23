// Matching and conversations. The website routes and the Telegram bot both
// call these functions, which is what puts everyone in one pool.
import { db } from './db.js';
import { LIMITS } from './rateLimit.js';
import { deliverMessage, nudge, offerToListener, handoffBanner, afterChatMenu, missedOffer, ratingPrompt } from './delivery.js';
import { randomAlias } from '../aliases.js';
import { sendText, button } from './telegramApi.js';
import { topicsFor, cleanTopics } from '../topics.js';
import { topicsOfExperiences } from '../experiences.js';
import { quickTags, aiTags, mergeTags, aiConfigured } from './tagging.js';
import { getProfile } from './profiles.js';
import { reputationOf, rateableChat, takeThanks } from './feedback.js';
import { pingWave, startPings, WAVE2_SECS, WAVE3_SECS } from './pings.js';
import { notifyReply, notifyJoined, sendReminders } from './notify.js';
import { prefArgs, prefsOf } from './preferences.js';
import { aiListenerAvailable } from './aiListener.js';
import { checkBody, looksLikeCrisis, looksLikeContact } from '../safety.js';
import { SYS } from '../strings.js';

export const WEB_LISTENER_TTL = 10;          // seconds a web listener stays available without a heartbeat
export const AWAY_SECS = 20;                 // a web partner silent this long is shown as away
export const TELEGRAM_LISTENER_TTL = 24 * 60 * 60; // seconds a Telegram listener stays available: 24 hours
export const MAX_MISSES = 2;                 // offers missed in a row before a listener is marked as away
export const OFFER_SECS = 20;                // how long a Telegram listener has to accept
export const RESERVE_SECS = 60;              // how long a venter has to answer "a real person is free"
/** How long to hold out for someone with the same experience (seconds). */
export const matchWindowSecs = () => Number(process.env.MATCH_WINDOW_SECS || 20);
export const KEEP_DAYS = 30;                  // how long ended conversations are kept for their owners             // a silent chat is closed after this
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
  if (sender === 'venter' || sender === 'listener') {
    // A new message from a person restarts the reminders.
    await sql`update chats set last_message_at = now(), last_sender = ${sender}, reminders_sent = 0 where id = ${chat.id}`;
  } else if (sender !== 'system') {
    await sql`update chats set last_message_at = now() where id = ${chat.id}`;
  }
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
  const tags = quickTags(text);
  const topics = cleanTopics([...topicsFor(text, pickedTopics), ...topicsOfExperiences(tags.experiences)]);
  const rows = await db()`
    select * from listener_candidates(${person.id}, ${topics}, ${tags.experiences}, ${person.language_pref || tags.language},
                                      null, 3, ${prefArgs(person)[0]}, ${prefArgs(person)[1]}, ${prefArgs(person)[2]}, ${prefArgs(person)[3]})`;
  return {
    topics,
    experiences: tags.experiences,
    candidates: rows.map((r) => ({
      id: r.person_id,
      alias: r.alias,
      topics: r.topics,
      sharedExperiences: r.shared_experiences,
      helped: r.helped,
    })),
  };
}

/** Take a free listener for a chat. closeOnly: only someone who shares an experience. */
async function claim(chat, { pick = null, closeOnly = false } = {}) {
  const [row] = await db()`
    select * from claim_listener(${chat.id}, ${chat.venter_id}, ${chat.topics}, ${chat.experiences},
                                 ${chat.language}, ${pick}, ${closeOnly},
                                 ${chat.venter_age_band}, ${chat.venter_gender}, ${chat.venter_wants_age}, ${chat.venter_wants_gender})`;
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
  const [fresh] = await sql`select ai_active from chats where id = ${chat.id}`;
  // In the waiting room nobody was replying, so there is nothing to choose between.
  if (fresh && !fresh.ai_active) return connectHuman(chat, listenerRow);
  const [{ n }] = await sql`
    select count(*)::int as n from messages where chat_id = ${chat.id} and sender = 'venter' and to_role is null`;
  if (n <= 1) return connectHuman(chat, listenerRow);
  await sql`update listeners set status = 'reserved', status_at = now() where person_id = ${listenerRow.person_id}`;
  await handoffBanner(await personById(chat.venter_id), listenerRow.alias);
  return false;
}

/**
 * The most recent ended conversation between these same two people that this
 * person still has. Names change every time, so the link is the pair of
 * people. Only this person's own saved copy is described.
 */
export async function previousWith(personId, chat) {
  const venterSide = chat.venter_id === personId;
  const otherId = venterSide ? chat.listener_id : chat.venter_id;
  if (!otherId) return null;
  const [row] = await db()`
    select id, venter_alias, listener_alias, ended_at from chats
    where status = 'ended' and id <> ${chat.id}
      and ((venter_id = ${personId} and listener_id = ${otherId} and not hidden_for_venter)
        or (venter_id = ${otherId} and listener_id = ${personId} and not hidden_for_listener))
    order by ended_at desc limit 1`;
  if (!row) return null;
  return { id: row.id, with: venterSide ? row.listener_alias : row.venter_alias, endedAt: row.ended_at };
}

// Telegram has no header to put this in, so say it once when they connect.
export async function tellEarlier(chat, people) {
  for (const who of ['venter', 'listener']) {
    const person = people[who];
    if (person?.channel !== 'telegram') continue;
    const prev = await previousWith(person.id, chat);
    if (!prev) continue;
    const day = new Date(prev.endedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    await sendText(person.tg_chat_id, `You talked with ${prev.with} before, on ${day}.`, [[button('Read that conversation', `hist:${prev.id}`)]]);
  }
}

async function connectHuman(chat, listenerRow) {
  const sql = db();
  const [updated] = await sql`
    update chats
       set mode = 'human', listener_id = ${listenerRow.person_id}, listener_alias = ${listenerRow.alias},
           ai_pending = false, last_message_at = now(), connected_at = now(),
           -- After an AI conversation the listener sees only what comes next.
           -- From the waiting room they see everything written so far.
           listener_from_id = case when ai_active
             then (select coalesce(max(id), 0) from messages where chat_id = ${chat.id}) else 0 end
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
  await notifyJoined(updated, people).catch((e) => console.error('[notify]', e));
  await tellEarlier(updated, people).catch((e) => console.error('[earlier]', e));
  if (updated.ai_active) {
    // The listener's copy of the opening message, so they know what this is about.
    await addMessage(updated, { sender: 'venter', toRole: 'listener', body: updated.opening }, people);
  } else if (people.listener?.channel === 'telegram') {
    // Telegram has no screen to scroll back through: send what was written so far.
    const written = await sql`
      select * from messages where chat_id = ${chat.id} and sender = 'venter' and to_role is null order by id`;
    for (const msg of written) await deliverMessage(msg, { venter: null, listener: people.listener });
  }
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
  const tags = quickTags(checked.body);
  const topics = cleanTopics([...topicsFor(checked.body, picked), ...topicsOfExperiences(tags.experiences)]);
  const [chat] = await sql`
    insert into chats (venter_id, venter_alias, topics, experiences, language, opening,
                       venter_age_band, venter_gender, venter_wants_age, venter_wants_gender)
    values (${person.id}, ${randomAlias()}, ${topics}, ${tags.experiences}, ${person.language_pref || tags.language}, ${checked.body},
            ${prefArgs(person)[0]}, ${prefArgs(person)[1]}, ${prefArgs(person)[2]}, ${prefArgs(person)[3]})
    returning *`;
  const people = { venter: person, listener: null };
  await addMessage(chat, { sender: 'venter', body: checked.body }, people);

  // 1. The person they chose, or someone free who shares an experience.
  let listenerRow = pick ? await claim(chat, { pick }) : null;
  listenerRow ||= await claim(chat, { closeOnly: true });

  // 2. Nobody close is free. Hold out for a close match only while there is
  //    a real chance of one: listeners with this experience were just
  //    messaged, or the AI may still find experiences the word matching
  //    missed. Otherwise take whoever is free now, because speed matters
  //    more than a wait that cannot pay off.
  const needsTagging = !listenerRow && aiConfigured();
  const wave = listenerRow ? { sent: 0, close: 0 } : await startPings(chat);
  // Only people who share an experience are worth holding out for.
  const holdOut = needsTagging || wave.close > 0;
  if (!listenerRow && !holdOut) listenerRow = await claim(chat);

  let connected = false;
  const aiOn = aiListenerAvailable();
  if (!aiOn) await sql`update chats set ai_active = false where id = ${chat.id}`;
  if (listenerRow) connected = await listenerClaimed(chat, listenerRow);

  if (!connected) {
    // With an AI, it keeps them company. Without one, say so honestly.
    await sql`
      update chats set ai_pending = ${aiOn}, ai_active = ${aiOn}, ping_wave = 1, ping_wave_at = now(),
        match_until = now() + make_interval(secs => ${holdOut ? matchWindowSecs() : 0})
      where id = ${chat.id}`;
    await addMessage(chat, { sender: 'system', toRole: 'venter', body: aiOn ? SYS.aiStart : SYS.waitStart }, people);
  }
  if (looksLikeCrisis(checked.body)) {
    const fresh = (await activeChatFor(person.id))?.chat || chat;
    await crisisCards(fresh, 'venter', await peopleOf(fresh));
  }
  return {
    ok: true,
    chatId: chat.id,
    needsAi: !connected && aiOn,
    needsTagging: needsTagging && !connected,
    holdingOut: holdOut && !connected,
  };
}

/**
 * Read the opening message with the AI for experiences the word matching
 * missed, then look again for a close match. Runs in the background after a
 * chat has started.
 */
export async function refineChatTags(chatId) {
  const sql = db();
  const [chat] = await sql`select * from chats where id = ${chatId} and status = 'active' and mode = 'ai'`;
  if (!chat) return null;
  const tags = mergeTags({ experiences: chat.experiences, language: chat.language }, await aiTags(chat.opening));
  const topics = cleanTopics([...chat.topics, ...topicsOfExperiences(tags.experiences)]);
  const [updated] = await sql`
    update chats set experiences = ${tags.experiences}, language = ${tags.language}, topics = ${topics}
    where id = ${chatId} returning *`;
  // Listeners with a newly found experience can be messaged too. If nobody
  // was ever messaged and there is nothing to match on, stop waiting.
  await pingWave(updated, 0);
  await sql`
    update chats set match_until = now()
    where id = ${chatId}
      and (${tags.experiences.length} = 0 or not exists (select 1 from pings g where g.chat_id = ${chatId}))
      and not exists (
        select 1 from listener_profiles lp join listeners l on l.person_id = lp.person_id
        where l.experiences && ${tags.experiences}::text[])`;
  await sweepAndMatch({ force: true });
  return tags;
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
  await notifyReply(chat, role, people).catch((e) => console.error('[notify]', e));
  // Writing again means "let us keep talking": any request to finish is withdrawn.
  if (chat.end_requested_by) {
    await db()`update chats set end_requested_by = null where id = ${chat.id}`;
    if (chat.end_requested_by !== role) await addMessage(chat, { sender: 'system', toRole: chat.end_requested_by, body: SYS.endKept }, people);
  }
  if (looksLikeCrisis(checked.body)) await crisisCards(chat, role, people);

  const needsAi = chat.mode === 'ai' && chat.ai_active && role === 'venter';
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
export async function goAvailable(person, pickedTopics, { match = true } = {}) {
  if (person.suspended_at) return fail('suspended');
  if (!person.rules_accepted_at) return fail('rules');
  if (await activeChatFor(person.id)) return fail('in_chat');
  const profile = await getProfile(person.id);
  const experiences = profile?.experiences || [];
  const topics = cleanTopics([
    ...(pickedTopics === undefined ? profile?.topics || [] : pickedTopics),
    ...topicsOfExperiences(experiences),
  ]);
  const ttl = person.channel === 'telegram' ? TELEGRAM_LISTENER_TTL : WEB_LISTENER_TTL;
  await db()`
    insert into listeners (person_id, alias, topics, experiences, language, helped, reputation, expires_at,
                           age_band, gender, wants_age, wants_gender)
    values (${person.id}, ${randomAlias()}, ${topics}, ${experiences}, ${person.language_pref || profile?.language || 'en'},
            ${profile?.helped_count || 0}, ${reputationOf(profile?.helped_count || 0, profile?.not_heard_count || 0)},
            now() + make_interval(secs => ${ttl}),
            ${prefArgs(person)[0]}, ${prefArgs(person)[1]}, ${prefArgs(person)[2]}, ${prefArgs(person)[3]})
    on conflict (person_id) do update
      set topics = excluded.topics, experiences = excluded.experiences, language = excluded.language,
          helped = excluded.helped, reputation = excluded.reputation, expires_at = excluded.expires_at,
          misses = 0, age_band = excluded.age_band, gender = excluded.gender,
          wants_age = excluded.wants_age, wants_gender = excluded.wants_gender`;
  if (match) await sweepAndMatch({ force: true });
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

/**
 * A listener who was messaged about a specific chat says they are free.
 * They are connected if that venter is still waiting for a person.
 */
export async function answerPing(person, chatId) {
  if (person.suspended_at) return fail('suspended');
  if (await activeChatFor(person.id)) return fail('in_chat');
  const sql = db();
  const [chat] = await sql`
    select * from chats c
    where c.id = ${chatId} and c.status = 'active' and c.mode = 'ai' and c.wants_human
      and not exists (select 1 from listeners l where l.chat_id = c.id and l.status in ('offered', 'reserved'))`;
  if (!chat) return fail('gone');
  // Join the pool without the usual matching pass: this listener answered
  // for one particular person and goes straight to them.
  const available = await goAvailable(person, undefined, { match: false });
  if (!available.ok) return available;
  await sql`update pings set answered = true where person_id = ${person.id} and chat_id = ${chatId}`;
  const listenerRow = await claim(chat, { pick: person.id });
  if (!listenerRow) {
    await sql`delete from listeners where person_id = ${person.id} and status = 'free'`;
    return fail('gone');
  }
  const connected = await listenerReady(chat, listenerRow);
  return { ok: true, connected, waiting: !connected };
}

/** A Telegram listener answers a request. */
export async function respondOffer(person, accept) {
  const sql = db();
  const [listenerRow] = await sql`select * from listeners where person_id = ${person.id} and status = 'offered'`;
  if (!listenerRow) return fail('no_offer');
  if (accept) await sql`update listeners set misses = 0 where person_id = ${person.id}`;
  const [chat] = await sql`select * from chats where id = ${listenerRow.chat_id} and status = 'active' and mode = 'ai'`;
  if (!accept || !chat) {
    await releaseListener(person.id, listenerRow.chat_id);
    await sweepAndMatch({ force: true });
    return accept ? fail('gone') : { ok: true, connected: false };
  }
  const connected = await listenerReady(chat, listenerRow);
  return { ok: true, connected, waiting: !connected };
}

/**
 * Open a conversation between two specific people who agreed to talk (an
 * accepted invitation), skipping the matching pool. `venter` starts from
 * `opening`; `listener` is the one who listens.
 */
export async function openDirectChat(venter, listener, { opening, venterAlias, listenerAlias, experiences = [] }) {
  if (venter.suspended_at || listener.suspended_at) return fail('suspended');
  if ((await activeChatFor(venter.id)) || (await activeChatFor(listener.id))) return fail('busy');
  const sql = db();
  await sql`delete from listeners where person_id in ${sql([venter.id, listener.id])} and status <> 'busy'`;
  const [chat] = await sql`
    insert into chats (venter_id, listener_id, venter_alias, listener_alias, topics, experiences, opening, mode, wants_human)
    values (${venter.id}, ${listener.id}, ${venterAlias}, ${listenerAlias}, ${cleanTopics(topicsOfExperiences(experiences))},
            ${experiences}, ${opening}, 'human', false)
    returning *`;
  await sql`update people set listens_count = listens_count + 1 where id = ${listener.id}`;
  const people = { venter, listener };
  await addMessage(chat, { sender: 'venter', body: opening }, { venter: null, listener });
  await addMessage(chat, { sender: 'system', toRole: 'venter', body: SYS.connected(listenerAlias) }, people);
  await addMessage(chat, { sender: 'system', toRole: 'listener', body: SYS.listenerIntro }, people);
  await tellEarlier(chat, people).catch((e) => console.error('[earlier]', e));
  await nudge(venter, listener);
  return { ok: true, chatId: chat.id };
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
  // After talking to a person, the venter is asked whether they felt heard.
  const askVenter = Boolean(ended.listener_id) && endedBy !== 'report';
  await Promise.all([
    askVenter ? ratingPrompt(people.venter) : afterChatMenu(people.venter),
    afterChatMenu(people.listener, { again: askVenter }),
  ]);
  return true;
}

/**
 * Ending a conversation between two people needs both of them: the first
 * "End" is a request, and the chat stays open (however long it is quiet)
 * until the other person agrees or keeps talking. With nobody else there
 * (waiting room, AI) it ends at once.
 */
export async function endChat(person) {
  const current = await activeChatFor(person.id);
  if (!current) return fail('no_chat');
  const { chat, role } = current;
  const bothHere = chat.mode === 'human' && Boolean(chat.listener_id);
  if (bothHere) {
    const other = role === 'venter' ? 'listener' : 'venter';
    if (chat.end_requested_by === role) return { ok: true, pending: true };
    if (chat.end_requested_by !== other) {
      await db()`update chats set end_requested_by = ${role} where id = ${chat.id} and status = 'active'`;
      const people = await peopleOf(chat);
      const alias = role === 'venter' ? chat.venter_alias : chat.listener_alias;
      await addMessage(chat, { sender: 'system', toRole: role, body: SYS.endAsked }, people);
      await addMessage(chat, { sender: 'system', toRole: other, body: SYS.endAskedOther(alias) }, people);
      const target = people[other];
      if (target?.channel === 'telegram') {
        await sendText(target.tg_chat_id, 'Done too, or would you like to wait?', [
          [button('I am done too', 'end:yes'), button('Keep talking', 'end:no')],
        ]);
      }
      return { ok: true, pending: true };
    }
    // The other person already asked: both agree, so it ends.
    return finishChat(chat, role);
  }
  return finishChat(chat, role);
}

/** The other person says "let us keep talking": the request is withdrawn. */
export async function keepTalking(person) {
  const current = await activeChatFor(person.id);
  if (!current) return fail('no_chat');
  const { chat, role } = current;
  if (!chat.end_requested_by) return { ok: true };
  await db()`update chats set end_requested_by = null where id = ${chat.id}`;
  const other = role === 'venter' ? 'listener' : 'venter';
  const people = await peopleOf(chat);
  await addMessage(chat, { sender: 'system', toRole: role, body: SYS.endKeptByYou }, people);
  if (chat.end_requested_by === other) await addMessage(chat, { sender: 'system', toRole: other, body: SYS.endKept }, people);
  return { ok: true };
}

async function finishChat(chat, role) {
  const mine = role === 'venter';
  await closeChat(chat, role, {
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

  // Telegram listeners who did not answer an offer in time. Someone who is
  // available for 24 hours may be asleep, so one miss only skips that
  // conversation; after two in a row they are marked as away.
  const missed = await sql`
    update listeners
       set status = 'free', status_at = now(), misses = misses + 1,
           skipped = array_append(skipped, chat_id), chat_id = null
     where status = 'offered' and status_at < now() - make_interval(secs => ${OFFER_SECS})
    returning person_id, misses`;
  for (const row of missed.filter((r) => r.misses >= MAX_MISSES)) {
    await sql`delete from listeners where person_id = ${row.person_id}`;
    await missedOffer(await personById(row.person_id));
  }

  // Venters who ignored "a real person is free": let the listener go.
  const ignored = await sql`
    update listeners
       set status = 'free', status_at = now(), skipped = array_append(skipped, chat_id), chat_id = null
     where status = 'reserved' and status_at < now() - make_interval(secs => ${RESERVE_SECS})
    returning person_id, skipped[array_upper(skipped, 1)] as chat_id`;
  for (const row of ignored) await sql`update chats set wants_human = false where id = ${row.chat_id}`;

  await sql`delete from listeners where status = 'free' and expires_at < now()`;

  // Quiet conversations are never closed for the people in them: only they end
  // a conversation. A gentle reminder goes out after 2 and 24 hours instead.
  await sendReminders().catch((e) => console.error('[reminders]', e));

  // Someone is still waiting with nobody free: ask the next people. Wave 2
  // after 30 seconds, wave 3 after 2 minutes; never while an offer is out.
  const due = await sql`
    update chats c set ping_wave = ping_wave + 1, ping_wave_at = now()
    where c.status = 'active' and c.mode = 'ai' and c.wants_human
      and ((c.ping_wave = 1 and c.created_at < now() - make_interval(secs => ${WAVE2_SECS}))
        or (c.ping_wave = 2 and c.created_at < now() - make_interval(secs => ${WAVE3_SECS})))
      and not exists (select 1 from listeners l where l.chat_id = c.id and l.status in ('offered', 'reserved'))
      and exists (select 1 from people v where v.id = c.venter_id and (v.channel = 'telegram' or v.last_seen_at > now() - interval '10 minutes'))
    returning c.*`;
  for (const chat of due) await pingWave(chat, chat.ping_wave);

  const waiting = await sql`
    select c.*, c.match_until > now() as close_only from chats c
    where c.status = 'active' and c.mode = 'ai' and c.wants_human
      and not exists (select 1 from listeners l where l.chat_id = c.id and l.status in ('offered', 'reserved'))
      and exists (select 1 from people v where v.id = c.venter_id and (v.channel = 'telegram' or v.last_seen_at > now() - interval '10 minutes'))
    order by c.created_at
    limit 20`;
  for (const chat of waiting) {
    const listenerRow = await claim(chat, { closeOnly: chat.close_only });
    if (listenerRow) await listenerClaimed(chat, listenerRow);
  }
}

/** Delete old conversations. Reported ones are kept for review. */
export async function cleanup({ keepDays = KEEP_DAYS } = {}) {
  const sql = db();
  const chats = await sql`
    delete from chats
    where status = 'ended' and not reported and ended_at < now() - make_interval(days => ${keepDays})
    returning id`;
  await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  return { deletedChats: chats.length };
}

/** Whole-app counts shown to everyone: who is here right now. */
export async function presence() {
  const [row] = await db()`
    select
      (select count(*)::int from listeners where status = 'free' and expires_at > now()) as listeners_free,
      (select count(*)::int from listeners where status = 'busy') as listeners_busy,
      (select count(*)::int from chats c where c.status = 'active' and c.mode = 'ai' and c.wants_human
         and exists (select 1 from people v where v.id = c.venter_id and (v.channel = 'telegram' or v.last_seen_at > now() - interval '10 minutes'))) as waiting`;
  return { listenersFree: row.listeners_free, listenersBusy: row.listeners_busy, waiting: row.waiting };
}

/** The messages of a chat as one side is allowed to see them. */
export async function visibleMessages(chat, role, after = 0) {
  const minId = Math.max(Number(after) || 0, role === 'listener' ? Number(chat.listener_from_id) : 0);
  const rows = await db()`
    select id, sender, kind, body, created_at from messages
    where chat_id = ${chat.id} and id > ${minId} and (to_role is null or to_role = ${role})
    order by id`;
  return rows.map((m) => ({
    id: Number(m.id),
    from: m.sender === role ? 'me' : m.sender === 'system' ? 'system' : m.sender === 'ai' ? 'ai' : 'them',
    kind: m.kind,
    body: m.body,
    at: m.created_at,
  }));
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
    prefsSeen: Boolean(person.prefs_seen_at),
    prefs: prefsOf(person),
    notifyLinked: Boolean(person.notify_tg_chat_id),
    rulesAccepted: Boolean(person.rules_accepted_at),
    suspended: Boolean(person.suspended_at),
  };

  if (!current) {
    const [listenerRow] = await sql`select * from listeners where person_id = ${person.id}`;
    const profile = await getProfile(person.id);
    return {
      ...base,
      presence: await presence(),
      thanks: person.channel === 'web' ? await takeThanks(person.id) : [],
      helped: profile?.helped_count || 0,
      profile: profile ? { story: profile.story, topics: profile.topics, experiences: profile.experiences } : null,
      screen: listenerRow ? 'listening' : 'home',
      listening: listenerRow
        ? { alias: listenerRow.alias, topics: listenerRow.topics, experiences: listenerRow.experiences }
        : null,
    };
  }

  const { chat, role } = current;
  const messages = await visibleMessages(chat, role, after);

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
    presence: await presence(),
    chat: {
      id: chat.id,
      role,
      // 'waiting': no person yet and no AI replying.
      mode: chat.mode === 'ai' && !chat.ai_active ? 'waiting' : chat.mode,
      status: chat.status,
      topics: chat.topics,
      experiences: chat.experiences,
      // Still holding out for someone who has been through the same thing.
      searching: chat.status === 'active' && chat.mode === 'ai' && chat.wants_human && new Date(chat.match_until) > new Date(),
      partner: chat.mode === 'ai' ? null : role === 'venter' ? chat.listener_alias : chat.venter_alias,
      typing: chat.mode === 'ai' && chat.ai_pending,
      partnerAway,
      endRequest: chat.status === 'active' && chat.end_requested_by ? (chat.end_requested_by === role ? 'me' : 'them') : null,
      previous: chat.mode === 'human' ? await previousWith(person.id, chat) : null,
      // Seconds the other person has been silent after I wrote last (0 otherwise).
      quietSecs: chat.status === 'active' && chat.mode === 'human' && chat.last_sender === role
        ? Math.max(0, Math.round((Date.now() - new Date(chat.last_message_at).getTime()) / 1000)) : 0,
      canRate: chat.status === 'ended' && role === 'venter' && Boolean(chat.listener_id)
        && (await rateableChat(person.id))?.id === chat.id,
      offer,
    },
    messages,
  };
}
