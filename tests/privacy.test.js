import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent, sendMessage, goAvailable, endChat, keepTalking, sweepAndMatch } from '../src/lib/server/chat.js';
import { sendReminders } from '../src/lib/server/notify.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
let updateId = 9000;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const tap = (id, data) => handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), data, from: { id }, message: { message_id: 1, chat: { id, type: 'private' } } } });
const text = (id, body) => handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id, type: 'private' }, text: body } });

test('what someone writes reaches only the other person in that conversation, never anyone else', async () => {
  const SECRET = 'my-private-sentence-7731';
  const LATER = 'a-second-private-line-4412';
  const listener = await tgPerson(9101);       // the person they talk to
  const bystanders = [await tgPerson(9102), await tgPerson(9103)]; // other bot users, asked to listen
  const linkedWeb = await webPerson();         // a website visitor linked to a third Telegram chat
  await db()`update people set notify_tg_chat_id = 9104 where id = ${linkedWeb.id}`;

  await goAvailable(listener, []);
  const venter = await webPerson();
  const started = await startVent(venter, { text: SECRET, topics: [] });
  assert.ok(started.ok);
  await tap(9101, 'offer:yes').catch(() => {});
  await sendMessage(venter, LATER);
  await endChat(venter);       // asks to finish
  await keepTalking(listener); // chooses to wait
  await sweepAndMatch({ force: true });
  await db()`update chats set last_message_at = now() - interval '5 hours', last_sender = 'venter'`;
  await sendReminders();
  await text(9101, '/history');

  const seen = (chatId) => telegram.to(chatId).map((s) => String(s.text || '')).join('\n');
  for (const id of [9102, 9103, 9104]) {
    const all = seen(id);
    assert.equal(all.includes(SECRET), false, `chat ${id} never sees the opening`);
    assert.equal(all.includes(LATER), false, `chat ${id} never sees later messages`);
  }
  // Nothing sent to anyone but the two people carries the other side's identifiers.
  const everything = telegram.sent.map((s) => String(s.text || '')).join('\n');
  assert.equal(everything.includes(venter.id), false);
  assert.equal(everything.includes(listener.id), false);
});

test('notifications, reminders and end requests carry a name only, never message text', async () => {
  const SECRET = 'do-not-leak-this-9183';
  const listener = await webPerson();
  const venter = await webPerson();
  await db()`update people set notify_tg_chat_id = 9201 where id = ${listener.id}`;
  await db()`update people set notify_tg_chat_id = 9202 where id = ${venter.id}`;
  await goAvailable(listener, []);
  await startVent(venter, { text: SECRET, topics: [] });
  await db()`update people set last_seen_at = now() - interval '10 minutes'`;
  await sendMessage(venter, SECRET);
  await endChat(venter);
  await db()`update chats set last_message_at = now() - interval '5 hours', last_sender = 'venter'`;
  await sendReminders();
  for (const id of [9201, 9202]) {
    assert.equal(telegram.to(id).map((s) => String(s.text || '')).join('\n').includes(SECRET), false);
  }
});
