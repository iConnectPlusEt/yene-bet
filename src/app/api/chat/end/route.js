import { endChat, keepTalking } from '../../../../lib/server/chat.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person) => {
    const body = await request.json().catch(() => ({}));
    return reply(body?.keep ? await keepTalking(person) : await endChat(person));
  });
