import { createLinkCode } from '../../../lib/server/notify.js';
import { botUsernameNow } from '../../../lib/server/telegramApi.js';
import { withPerson, json } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// A one-time link that opens the Telegram bot and ties this visitor to it for
// notifications only. Nothing about the visitor is sent to Telegram.
export const POST = (request) =>
  withPerson(request, async (person) => {
    const bot = await botUsernameNow();
    if (!bot) return json({ ok: false, error: 'bot_unavailable' }, 503);
    const code = await createLinkCode(person);
    if (!code) return json({ ok: false, error: 'rate_limited' }, 429);
    return json({ ok: true, url: `https://t.me/${bot}?start=link_${code}` });
  });
