import { wantAgain } from '../../../../lib/server/invites.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) => withPerson(request, async (person) => reply(await wantAgain(person)));
