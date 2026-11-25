import { withPerson, json, reply } from '../../../lib/server/api.js';
import { pushConfigured, vapidPublicKey, saveSubscription, removeSubscription, hasPush } from '../../../lib/server/push.js';

export const dynamic = 'force-dynamic';

// GET    /api/push → { supported, publicKey, subscribed }
// POST   /api/push → save this browser's subscription
// DELETE /api/push → stop alerts for this person
export const GET = (request) =>
  withPerson(request, async (person) =>
    json({ ok: true, supported: pushConfigured(), publicKey: vapidPublicKey(), subscribed: await hasPush(person.id) }));

export const POST = (request) =>
  withPerson(request, async (person, body) => {
    if (!pushConfigured()) return reply({ ok: false, error: 'not_supported' });
    return reply(await saveSubscription(person, body?.subscription));
  });

export const DELETE = (request) =>
  withPerson(request, async (person, body) => reply(await removeSubscription(person, body?.endpoint)));
