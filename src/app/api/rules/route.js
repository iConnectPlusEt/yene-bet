import { acceptRules } from '../../../lib/server/identity.js';
import { withPerson, json } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person) => {
    await acceptRules(person.id);
    return json({ ok: true });
  });
