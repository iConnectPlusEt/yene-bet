// What happens to one update from Telegram: handled once, and never left unanswered.
// Kept free of the web framework so tests can run it directly.
import { handleUpdate } from './bot.js';
import { allow } from './rateLimit.js';
import { sendText } from './telegramApi.js';

/** Returns { duplicate: true } for an update that was already handled. */
export async function processUpdate(update) {
  try {
    // Telegram redelivers an update when it does not get an answer in time: handle each only once.
    if (Number.isSafeInteger(update?.update_id) && !(await allow(`tgupd:${update.update_id}`, 1, 3600))) {
      return { duplicate: true };
    }
    await handleUpdate(update);
    return { duplicate: false };
  } catch (error) {
    console.error('[telegram] update failed', error);
    // Never leave someone staring at silence.
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? update?.callback_query?.from?.id;
    const isGroup = update?.message?.chat?.type && update.message.chat.type !== 'private';
    if (chatId && !isGroup) {
      await sendText(chatId, 'Something went wrong on my side. Please try again in a moment.').catch(() => {});
    }
    return { duplicate: false, failed: true };
  }
}
