import { relate } from '../../../../lib/server/wall.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

const isId = (v) => /^[0-9a-f-]{36}$/i.test(v || '');

export const POST = (request) =>
  withPerson(request, async (person, body) =>
    reply(isId(body.postId) ? await relate(person, body.postId) : { ok: false, error: 'not_found' }));
