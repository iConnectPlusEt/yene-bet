import { candidates } from '../../../lib/server/chat.js';
import { withPerson, json } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person, body) =>
    json({ ok: true, ...(await candidates(person, String(body.text || ''), body.topics)) }));
