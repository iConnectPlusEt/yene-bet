import { listHistory, openHistory, removeHistory, removeAllHistory } from '../../../lib/server/history.js';
import { withPerson, json, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

const idFrom = (request) => {
  const id = new URL(request.url).searchParams.get('id') || '';
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

// GET /api/history        → this person's past conversations
// GET /api/history?id=…   → one of them, in full
export const GET = (request) =>
  withPerson(request, async (person) => {
    const id = idFrom(request);
    if (id) return reply(await openHistory(person, id));
    return json({ ok: true, conversations: await listHistory(person) });
  });

// DELETE /api/history?id=…  → remove one from my history
// DELETE /api/history?all=1 → remove all of them
export const DELETE = (request) =>
  withPerson(request, async (person) => {
    const id = idFrom(request);
    if (id) return reply(await removeHistory(person, id));
    if (new URL(request.url).searchParams.get('all') === '1') return reply(await removeAllHistory(person));
    return reply({ ok: false, error: 'not_found' });
  });
