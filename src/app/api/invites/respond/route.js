import { respondInvite } from '../../../../lib/server/invites.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person, body) =>
    reply(Number.isInteger(body.inviteId)
      ? await respondInvite(person, body.inviteId, body.accept === true)
      : { ok: false, error: 'not_found' }));
