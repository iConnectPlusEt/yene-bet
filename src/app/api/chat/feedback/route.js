import { giveFeedback } from '../../../../lib/server/feedback.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const POST = (request) =>
  withPerson(request, async (person, body) => reply(await giveFeedback(person, { heard: body.heard, note: body.note })));
