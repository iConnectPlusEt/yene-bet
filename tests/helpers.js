// Shared test setup: a clean local database and a stand-in for Telegram that
// records what the bot would have sent.
import http from 'node:http';
import { db, closeDb } from '../src/lib/server/db.js';
import { createWebPerson, personFromTelegram, acceptRules } from '../src/lib/server/identity.js';

process.env.DATABASE_URL ||= 'postgres://postgres@127.0.0.1:54329/yb_test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
// Tests of the AI path use scripted replies; tests of the waiting room turn this off.
process.env.AI_FAKE = '1';

export async function resetDb() {
  // Deletes (not TRUNCATE) so the tests can run as the restricted app role.
  await db()`delete from people`; // cascades to chats, listeners, messages, reports, blocks
  await db()`delete from rate_limits`;
}

export { db, closeDb };

export async function webPerson() {
  const { person, token } = await createWebPerson();
  await acceptRules(person.id);
  return { ...(await reload(person.id)), token };
}

// A Telegram user who joined after the bot started asking people to listen:
// they were told on the rules screen, so no separate heads-up is owed.
export async function tgPerson(chatId, { told = true } = {}) {
  const person = await personFromTelegram(chatId);
  await acceptRules(person.id);
  if (told) await db()`update people set notice_shown_at = now() where id = ${person.id}`;
  return reload(person.id);
}

export async function reload(id) {
  const [p] = await db()`select * from people where id = ${id}`;
  return p;
}

/** Starts a fake Telegram API. `sent` collects { method, chat_id, text, buttons }. */
export async function fakeTelegram() {
  const sent = [];
  const blocked = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (blocked.has(String(body.chat_id))) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
        return;
      }
      sent.push({
        method: req.url.split('/').pop(),
        chat_id: body.chat_id,
        text: body.text,
        buttons: (body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  return {
    sent,
    to: (chatId) => sent.filter((s) => String(s.chat_id) === String(chatId)),
    clear: () => { sent.length = 0; },
    block: (chatId) => blocked.add(String(chatId)),
    unblock: (chatId) => blocked.delete(String(chatId)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
