import { after } from 'next/server';
import { goAvailable, stopListening } from '../../../lib/server/chat.js';
import { saveProfile, refineProfile } from '../../../lib/server/profiles.js';
import { withPerson, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Become available to listen. A story and topics, when sent, are saved to the
// listener's profile first so they do not have to be entered again.
export const POST = (request) =>
  withPerson(request, async (person, body) => {
    if (body.story !== undefined || body.topics !== undefined) {
      const saved = await saveProfile(person, { story: body.story, topics: body.topics });
      if (saved.needsTagging) after(() => refineProfile(person.id).catch((e) => console.error('[tags]', e)));
    }
    return reply(await goAvailable(person));
  });

export const DELETE = (request) =>
  withPerson(request, async (person) => reply(await stopListening(person)));
