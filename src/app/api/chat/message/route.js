import { after } from 'next/server';
import { sendMessage } from '../../../../lib/server/chat.js';
import { runAi } from '../../../../lib/server/aiListener.js';
import { withPerson, reply } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = (request) =>
  withPerson(request, async (person, body) => {
    const result = await sendMessage(person, body.body, { confirm: body.confirm === true });
    if (result.ok && result.needsAi) after(() => runAi(result.chatId).catch((e) => console.error('[ai]', e)));
    if (!result.ok) return reply(result);
    return reply({ ok: true, id: Number(result.message.id) });
  });
