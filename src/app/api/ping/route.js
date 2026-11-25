import { db } from '../../../lib/server/db.js';
import { withPerson, json, reply } from '../../../lib/server/api.js';
import { answerPing } from '../../../lib/server/chat.js';
import { requestBody, snoozePings } from '../../../lib/server/pings.js';

export const dynamic = 'force-dynamic';

const asId = (v) => (/^[0-9a-f-]{36}$/i.test(v || '') ? v : null);

// GET  /api/ping?chat=…  → what is being asked (a category, never what was written), if it is still open
// POST /api/ping {chat, accept} → "I can listen" joins that person; "not now" snoozes requests for a while
export const GET = (request) =>
  withPerson(request, async (person) => {
    const chatId = asId(new URL(request.url).searchParams.get('chat'));
    if (!chatId) return json({ ok: true, open: false });
    const [chat] = await db()`
      select id, experiences, intent from chats
      where id = ${chatId} and status = 'active' and mode = 'ai' and wants_human and venter_id <> ${person.id}`;
    if (!chat) return json({ ok: true, open: false });
    return json({ ok: true, open: true, text: requestBody(chat), intent: chat.intent || null });
  });

export const POST = (request) =>
  withPerson(request, async (person, body) => {
    const chatId = asId(body.chat);
    if (!chatId) return json({ ok: false, error: 'gone' }, 400);
    if (body.accept === false) {
      await snoozePings(person.id);
      return json({ ok: true });
    }
    return reply(await answerPing(person, chatId));
  });
