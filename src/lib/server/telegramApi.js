// Minimal Telegram Bot API client. TELEGRAM_API_BASE exists so tests can
// point it at a local stand-in.
export function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

export async function tg(method, payload) {
  const token = botToken();
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not set' };
  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: String(e?.message || e) };
  }
}

/** Send plain text (no markup, so nothing a stranger types can be interpreted). */
export function sendText(chatId, text, buttons) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  return tg('sendMessage', payload);
}

export const button = (text, data) => ({ text, callback_data: data });
