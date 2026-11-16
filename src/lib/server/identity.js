// Anonymous identities. A web visitor is a random secret kept in their
// browser; only its hash is stored. A Telegram user is their chat id, which
// the bot needs for delivery and never shows to anyone.
import crypto from 'node:crypto';
import { db } from './db.js';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const randomKey = (bytes) => crypto.randomBytes(bytes).toString('base64url');

export async function createWebPerson() {
  const token = randomKey(32);
  const [person] = await db()`
    insert into people (channel, token_hash, poke_key)
    values ('web', ${hash(token)}, ${randomKey(18)})
    returning *`;
  return { token, person };
}

export async function personFromToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const [person] = await db()`
    update people set last_seen_at = now()
    where token_hash = ${hash(token)} returning *`;
  return person || null;
}

export async function personFromTelegram(chatId) {
  const sql = db();
  const [person] = await sql`
    insert into people (channel, tg_chat_id, poke_key)
    values ('telegram', ${chatId}, ${randomKey(18)})
    on conflict (tg_chat_id) do update set last_seen_at = now()
    returning *`;
  return person;
}

export async function acceptRules(personId) {
  await db()`update people set rules_accepted_at = coalesce(rules_accepted_at, now()) where id = ${personId}`;
}

/** Reads the bearer token from a request and returns the person, or null. */
export async function personFromRequest(request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return personFromToken(token);
}
