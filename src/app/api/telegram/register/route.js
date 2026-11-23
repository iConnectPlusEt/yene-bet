import { tg } from '../../../../lib/server/telegramApi.js';
import { json, isAdmin } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// One-time setup after deploying: points the Telegram bot at this site.
//   curl -X POST https://<site>/api/telegram/register -H "Authorization: Bearer $CRON_SECRET"
export async function POST(request) {
  if (!isAdmin(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = (process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');
  if (!process.env.TELEGRAM_BOT_TOKEN || !secret) return json({ ok: false, error: 'bot_not_configured' }, 503);

  const hook = await tg('setWebhook', {
    url: `${base}/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  });
  if (!hook.ok) return json({ ok: false, error: hook.description || 'setWebhook failed' }, 502);
  await tg('setMyCommands', {
    commands: [
      { command: 'vent', description: 'Find someone to vent to' },
      { command: 'listen', description: 'Be available to listen' },
      { command: 'end', description: 'End the conversation' },
      { command: 'report', description: 'Report and block this person' },
      { command: 'share', description: 'Share something on the wall' },
      { command: 'people', description: 'People you agreed to talk with again' },
      { command: 'stop', description: 'Stop being available' },
      { command: 'prefs', description: 'Who you would like to talk to' },
      { command: 'unlink', description: 'Stop website notifications on Telegram' },
      { command: 'pings', description: 'Message me when someone needs my experience (on/off)' },
    ],
  });
  return json({ ok: true, webhook: `${base}/api/telegram/webhook` });
}
