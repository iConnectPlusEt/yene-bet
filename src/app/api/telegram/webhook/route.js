import { handleUpdate } from '../../../../lib/server/bot.js';
import { json, safeEqual } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Telegram calls this for every message sent to the bot. The secret header
// proves the call really comes from Telegram.
export async function POST(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!process.env.TELEGRAM_BOT_TOKEN || !secret) return json({ ok: false, error: 'bot_not_configured' }, 503);
  if (!safeEqual(request.headers.get('x-telegram-bot-api-secret-token'), secret)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  try {
    await handleUpdate(await request.json());
  } catch (error) {
    console.error('[telegram] update failed', error);
  }
  // Always 200 so Telegram does not redeliver the same update.
  return json({ ok: true });
}
