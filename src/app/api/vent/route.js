import { after } from 'next/server';
import { startVent, refineChatTags } from '../../../lib/server/chat.js';
import { runAi } from '../../../lib/server/aiListener.js';
import { withPerson, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = (request) =>
  withPerson(request, async (person, body) => {
    const pick = /^[0-9a-f-]{36}$/i.test(body.pick || '') ? body.pick : null;
    const result = await startVent(person, { text: body.text, topics: body.topics, pick });
    // The AI's reply is written after this response is sent, so starting is instant.
    if (result.ok && result.needsAi) after(() => runAi(result.chatId).catch((e) => console.error('[ai]', e)));
    // A closer reading of what they wrote, to find someone with the same experience.
    if (result.ok && result.needsTagging) after(() => refineChatTags(result.chatId).catch((e) => console.error('[tags]', e)));
    return reply(result);
  });
