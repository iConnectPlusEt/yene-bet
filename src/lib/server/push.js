// Browser push notifications for website visitors who asked for them. A push
// never carries what anyone wrote: only a name or a category, and a link.
import { db } from './db.js';

export const PUSH_TTL_SECS = 600;   // a request nobody saw in 10 minutes is no longer worth showing

/** Tests set PUSH_FAKE=1 and read what would have been sent from globalThis.__pushSent. */
const fake = () => process.env.PUSH_FAKE === '1';
export const pushConfigured = () => fake() || Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || (fake() ? 'test-public-key' : '');

let configured = false;
async function lib() {
  const mod = await import('web-push');
  const webpush = mod.default || mod;
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:support@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    configured = true;
  }
  return webpush;
}

const clean = (s, max) => (typeof s === 'string' && s.length > 0 && s.length <= max ? s : null);

/** Save a browser's subscription for this person (replaces one with the same endpoint). */
export async function saveSubscription(person, sub) {
  const endpoint = clean(sub?.endpoint, 1000);
  const p256dh = clean(sub?.keys?.p256dh, 200);
  const auth = clean(sub?.keys?.auth, 100);
  if (!endpoint || !p256dh || !auth || !/^https:\/\//.test(endpoint)) return { ok: false, error: 'bad_subscription' };
  await db()`
    insert into push_subs (endpoint, person_id, p256dh, auth, alerts)
    values (${endpoint}, ${person.id}, ${p256dh}, ${auth}, true)
    on conflict (endpoint) do update
      set person_id = excluded.person_id, p256dh = excluded.p256dh, auth = excluded.auth,
          alerts = true, failed_at = null`;
  return { ok: true };
}

export async function removeSubscription(person, endpoint) {
  await db()`delete from push_subs where person_id = ${person.id} and (${endpoint || null}::text is null or endpoint = ${endpoint || null})`;
  return { ok: true };
}

export async function hasPush(personId) {
  const [row] = await db()`
    select exists(select 1 from push_subs where person_id = ${personId} and alerts and failed_at is null) as on`;
  return Boolean(row?.on);
}

/**
 * Send to every browser this person subscribed. Returns how many accepted it.
 * A subscription the push service says is gone is deleted.
 */
export async function sendPush(personId, { title, body, url = '/', tag = undefined }) {
  if (!pushConfigured()) return 0;
  const subs = await db()`
    select endpoint, p256dh, auth from push_subs where person_id = ${personId} and alerts and failed_at is null`;
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title, body, url, tag });
  if (fake()) {
    (globalThis.__pushSent ||= []).push({ personId, title, body, url, tag, count: subs.length });
    return subs.length;
  }
  const webpush = await lib();
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: PUSH_TTL_SECS, urgency: 'high' },
      );
      ok += 1;
      await db()`update push_subs set last_ok_at = now() where endpoint = ${s.endpoint}`;
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db()`delete from push_subs where endpoint = ${s.endpoint}`;
      else await db()`update push_subs set failed_at = now() where endpoint = ${s.endpoint}`;
    }
  }
  return ok;
}
