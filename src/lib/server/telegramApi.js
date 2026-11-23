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

let username = null;
let usernameAsked = false;

/**
 * The bot's @username, for "open in Telegram" links. Looked up once in the
 * background; returns null until it is known.
 */
export async function botUsernameNow() {
  if (username) return username;
  if (!botToken()) return null;
  const r = await tg('getMe', {});
  username = r?.result?.username || null;
  return username;
}

export function botUsername() {
  if (!usernameAsked && botToken()) {
    usernameAsked = true;
    tg('getMe', {}).then((r) => { username = r?.result?.username || null; if (!username) usernameAsked = false; });
  }
  return username;
}

// Telegram says the person blocked the bot or deleted their account: never
// message them again (until they write to the bot themselves).
function isGone(result) {
  if (!result || result.ok) return false;
  return result.error_code === 403 || /bot was blocked|user is deactivated|chat not found/i.test(result.description || '');
}

async function markUnreachable(chatId) {
  try {
    const { db } = await import('./db.js');
    await db()`update people set unreachable_at = now() where tg_chat_id = ${chatId}`;
  } catch { /* the next send will find out again */ }
}

/** Send plain text (no markup, so nothing a stranger types can be interpreted). */
export async function sendText(chatId, text, buttons) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  const result = await tg('sendMessage', payload);
  if (isGone(result)) await markUnreachable(chatId);
  return result;
}

export const button = (text, data) => ({ text, callback_data: data });
