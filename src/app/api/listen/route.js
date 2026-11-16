import { goAvailable, stopListening } from '../../../lib/server/chat.js';
import { withPerson, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person, body) => reply(await goAvailable(person, body.topics)));

export const DELETE = (request) =>
  withPerson(request, async (person) => reply(await stopListening(person)));
