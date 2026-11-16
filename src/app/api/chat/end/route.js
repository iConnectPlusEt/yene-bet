import { endChat } from '../../../../lib/server/chat.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) => withPerson(request, async (person) => reply(await endChat(person)));
