import { inviteRelater, inviteConnection } from '../../../lib/server/invites.js';
import { withPerson, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// Invite someone to talk: a person who related to your post ({ relateId }),
// or someone you both agreed to talk to again ({ connectionId, text }).
export const POST = (request) =>
  withPerson(request, async (person, body) => {
    if (Number.isInteger(body.relateId)) return reply(await inviteRelater(person, body.relateId));
    if (Number.isInteger(body.connectionId)) return reply(await inviteConnection(person, body.connectionId, body.text));
    return reply({ ok: false, error: 'not_found' });
  });
