import { processUpdate } from '../../../../lib/server/telegramWebhook.js';
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
  let update = null;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }
  const result = await processUpdate(update);
  // Always 200 so Telegram does not redeliver the same update.
  return json({ ok: true, ...(result.duplicate ? { duplicate: true } : {}) });
}
