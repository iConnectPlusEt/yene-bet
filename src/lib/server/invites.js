// Invitations to talk outside the matching pool: from a post's author to
// someone who related to it, or between two people who both chose to talk
// again after a conversation.
import { db } from './db.js';
import { LIMITS } from './rateLimit.js';
import { nudge } from './delivery.js';
import { sendText, button } from './telegramApi.js';
import { openDirectChat } from './chat.js';
import { checkBody, looksLikeContact } from '../safety.js';

export const INVITE_HOURS = 24;
const fail = (error) => ({ ok: false, error });

async function blocked(a, b) {
  const [row] = await db()`
    select 1 from blocks where (blocker_id = ${a} and blocked_id = ${b}) or (blocker_id = ${b} and blocked_id = ${a})`;
  return Boolean(row);
}

async function sendInvite(from, to, { fromAlias, toAlias, kind, opening }) {
  if (from.suspended_at) return fail('suspended');
  if (!to || to.suspended_at || (await blocked(from.id, to.id))) return fail('not_found');
  if (!(await LIMITS.invite(from.id))) return fail('rate_limited');
  const [invite] = await db()`
    insert into invites (from_id, to_id, from_alias, to_alias, kind, opening)
    values (${from.id}, ${to.id}, ${fromAlias}, ${toAlias}, ${kind}, ${opening})
    on conflict (from_id, to_id) where status = 'pending' do nothing
    returning *`;
  if (!invite) return { ok: true, already: true };
  if (to.channel === 'telegram') {
    const about = opening.length > 140 ? `${opening.slice(0, 140)}…` : opening;
    await sendText(
      to.tg_chat_id,
      kind === 'post'
        ? `${fromAlias}, whose story you related to, would like to talk with you.\n\n"${about}"`
        : `${fromAlias}, who you talked with before, would like to talk again.\n\n"${about}"`,
      [[button('Talk now', `inv:${invite.id}:y`), button('Not now', `inv:${invite.id}:n`)]],
    );
  } else {
    await nudge(to);
  }
  return { ok: true, inviteId: Number(invite.id) };
}

/** A post's author invites someone who said "I have been there". */
export async function inviteRelater(person, relateId) {
  const sql = db();
  const [row] = await sql`
    select r.person_id, r.alias as relater_alias, p.alias as author_alias, p.body, p.author_id
    from post_relates r join posts p on p.id = r.post_id
    where r.id = ${relateId}`;
  if (!row || row.author_id !== person.id) return fail('not_found');
  const [to] = await sql`select * from people where id = ${row.person_id}`;
  return sendInvite(person, to, { fromAlias: row.author_alias, toAlias: row.relater_alias, kind: 'post', opening: row.body });
}

// ── talk again ──

const ordered = (x, y) => (x < y ? [x, y] : [y, x]);

/** The ended conversation this person may still mark as "talk again". */
async function keepableChat(personId) {
  const [chat] = await db()`
    select * from chats
    where status = 'ended' and listener_id is not null and not reported
      and (venter_id = ${personId} or listener_id = ${personId})
      and ended_at > now() - interval '1 day'
    order by ended_at desc limit 1`;
  return chat || null;
}

/** State of "talk again" for the person's most recent conversation. */
export async function keepState(personId, chatId) {
  const chat = await keepableChat(personId);
  if (!chat || chat.id !== chatId) return { canKeep: false, kept: false, mutual: false };
  const otherId = chat.venter_id === personId ? chat.listener_id : chat.venter_id;
  const [a, b] = ordered(personId, otherId);
  const [c] = await db()`select * from connections where a_id = ${a} and b_id = ${b}`;
  const mine = c ? (personId === a ? c.a_wants : c.b_wants) : false;
  return { canKeep: !(await blocked(personId, otherId)), kept: mine, mutual: Boolean(c?.a_wants && c?.b_wants) };
}

/** "I would talk to them again." Becomes a connection once both have said it. */
export async function wantAgain(person) {
  const chat = await keepableChat(person.id);
  if (!chat) return fail('no_chat');
  const otherId = chat.venter_id === person.id ? chat.listener_id : chat.venter_id;
  if (await blocked(person.id, otherId)) return fail('not_found');
  const [a, b] = ordered(person.id, otherId);
  const aliasOf = (id) => (id === chat.venter_id ? chat.venter_alias : chat.listener_alias);
  const sql = db();
  const [c] = await sql`
    insert into connections (a_id, b_id, a_alias, b_alias, a_wants, b_wants)
    values (${a}, ${b}, ${aliasOf(a)}, ${aliasOf(b)}, ${person.id === a}, ${person.id === b})
    on conflict (a_id, b_id) do update
      set a_wants = connections.a_wants or excluded.a_wants,
          b_wants = connections.b_wants or excluded.b_wants
    returning *`;
  const mutual = c.a_wants && c.b_wants;
  if (mutual) {
    const [other] = await sql`select * from people where id = ${otherId}`;
    if (other?.channel === 'telegram') {
      await sendText(other.tg_chat_id, `${aliasOf(person.id)} would talk with you again too. Send /people when you want to reach them.`);
    } else {
      await nudge(other);
    }
  }
  return { ok: true, mutual };
}

/** People this person can invite again (both said yes). */
export async function listConnections(personId) {
  const rows = await db()`
    select c.* from connections c
    where c.a_wants and c.b_wants and (c.a_id = ${personId} or c.b_id = ${personId})
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = c.a_id and b.blocked_id = c.b_id) or (b.blocker_id = c.b_id and b.blocked_id = c.a_id))
    order by c.created_at desc limit 30`;
  return rows.map((c) => ({ id: Number(c.id), alias: c.a_id === personId ? c.b_alias : c.a_alias }));
}

/** Invite a connection to talk, with a line about what is going on. */
export async function inviteConnection(person, connectionId, rawText) {
  const checked = checkBody(rawText);
  if (!checked.ok) return fail(checked.error);
  if (looksLikeContact(checked.body)) return fail('contact');
  const sql = db();
  const [c] = await sql`
    select * from connections
    where id = ${connectionId} and a_wants and b_wants and (a_id = ${person.id} or b_id = ${person.id})`;
  if (!c) return fail('not_found');
  const iAmA = c.a_id === person.id;
  const [to] = await sql`select * from people where id = ${iAmA ? c.b_id : c.a_id}`;
  return sendInvite(person, to, {
    fromAlias: iAmA ? c.a_alias : c.b_alias,
    toAlias: iAmA ? c.b_alias : c.a_alias,
    kind: 'again',
    opening: checked.body,
  });
}

// ── answering ──

export async function pendingInvites(personId) {
  const rows = await db()`
    select id, from_alias, kind, opening from invites
    where to_id = ${personId} and status = 'pending' and created_at > now() - make_interval(hours => ${INVITE_HOURS})
    order by id desc limit 10`;
  return rows.map((r) => ({ id: Number(r.id), from: r.from_alias, kind: r.kind, text: r.opening }));
}

/** Accept or decline. Accepting opens a conversation with the person who invited. */
export async function respondInvite(person, inviteId, accept) {
  const sql = db();
  const [invite] = await sql`
    select * from invites
    where id = ${inviteId} and to_id = ${person.id} and status = 'pending'
      and created_at > now() - make_interval(hours => ${INVITE_HOURS})`;
  if (!invite) return fail('not_found');
  if (!accept) {
    await sql`update invites set status = 'declined' where id = ${invite.id}`;
    return { ok: true, connected: false };
  }
  const [from] = await sql`select * from people where id = ${invite.from_id}`;
  if (!from || (await blocked(person.id, from.id))) return fail('not_found');
  // The inviter is the one with something to say; the invited person listens.
  const opened = await openDirectChat(from, person, {
    opening: invite.opening,
    venterAlias: invite.from_alias,
    listenerAlias: invite.to_alias,
  });
  if (!opened.ok) return opened; // 'busy' leaves the invitation open for later
  await sql`update invites set status = 'accepted' where id = ${invite.id}`;
  return { ok: true, connected: true, chatId: opened.chatId };
}
