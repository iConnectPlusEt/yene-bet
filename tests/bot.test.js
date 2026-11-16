import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, fakeTelegram } from './helpers.js';
import { handleUpdate } from '../src/lib/server/bot.js';
import { goAvailable, getState, sendMessage } from '../src/lib/server/chat.js';

let telegram;
let updateId = 1;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const text = (chatId, body) =>
  handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat: { id: chatId, type: 'private' }, text: body } });
const tap = (chatId, data) =>
  handleUpdate({
    update_id: updateId++,
    callback_query: { id: String(updateId), data, from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: 'private' } } },
  });
const last = (chatId) => telegram.to(chatId).filter((s) => s.method === 'sendMessage').at(-1);
const texts = (chatId) => telegram.to(chatId).map((s) => s.text).filter(Boolean);

async function join(chatId) {
  await text(chatId, '/start');
  assert.ok(last(chatId).buttons.includes('rules:ok'), 'rules are shown first');
  await tap(chatId, 'rules:ok');
  assert.deepEqual(last(chatId).buttons, ['vent', 'listen']);
}

test('two Telegram users: listen, vent, pick, chat, end', async () => {
  await join(100);
  await join(200);

  // 200 becomes a listener for family topics.
  await tap(200, 'listen');
  await tap(200, 'lt:family');
  assert.ok(telegram.to(200).some((s) => s.method === 'editMessageReplyMarkup'), 'the tick is shown on the keyboard');
  await tap(200, 'lt:go');
  assert.match(last(200).text, /available to listen/);

  // 100 vents and is shown who is available.
  await tap(100, 'vent');
  await text(100, 'My sister and I are not speaking');
  const choice = last(100);
  assert.ok(choice.buttons.includes('pick:auto'));
  assert.equal(choice.buttons.length, 2, 'one candidate plus "connect me now"');
  await tap(100, choice.buttons[1]);

  // 200 is asked, and the AI covers the gap for 100.
  assert.ok(last(200).buttons.includes('offer:yes'));
  assert.ok(texts(100).some((t) => t.startsWith('AI listener:')));

  // 100 has not replied to the AI, so accepting connects at once.
  await tap(200, 'offer:yes');
  assert.ok(texts(200).includes('My sister and I are not speaking'));
  assert.ok(texts(100).some((t) => /real person/.test(t)));

  await text(200, 'I am sorry, that hurts. What happened?');
  assert.equal(last(100).text, 'I am sorry, that hurts. What happened?');
  await text(100, 'She said something at the wedding');
  assert.equal(last(200).text, 'She said something at the wedding');

  await text(100, '/end');
  assert.ok(texts(200).some((t) => /other person ended/.test(t)));
  assert.deepEqual(last(200).buttons, ['vent', 'listen'], 'both get the menu back');
  assert.deepEqual(last(100).buttons, ['vent', 'listen']);

  const leaked = telegram.sent.some((s) => /\b(100|200)\b/.test(String(s.text)));
  assert.equal(leaked, false, 'neither chat id appears in any text');
});

test('Telegram venter with nobody free talks to the AI', async () => {
  await join(300);
  await tap(300, 'vent');
  await text(300, 'I cannot sleep and I am exhausted');
  assert.ok(texts(300).some((t) => /AI listener is here/.test(t)));
  const before = texts(300).filter((t) => t.startsWith('AI listener:')).length;
  assert.equal(before, 1);
  await text(300, 'It has been weeks');
  assert.equal(texts(300).filter((t) => t.startsWith('AI listener:')).length, 2);
});

test('Telegram venter is matched with a web listener, and asked before leaving the AI', async () => {
  await join(400);
  await tap(400, 'vent');
  await text(400, 'Rent went up again and I am scared');
  await text(400, 'I do not know what to do');

  const listener = await webPerson();
  await goAvailable(listener, ['money']);
  const banner = last(400);
  assert.ok(banner.buttons.includes('handoff:yes'));
  await tap(400, 'handoff:yes');

  const state = await getState(listener);
  assert.equal(state.chat.role, 'listener');
  assert.ok(state.messages.some((m) => m.body === 'Rent went up again and I am scared'));
  assert.ok(!state.messages.some((m) => m.body === 'I do not know what to do'));

  await sendMessage(listener, 'That is frightening. I am here.');
  assert.equal(last(400).text, 'That is frightening. I am here.');
  await text(400, 'Thank you');
  assert.ok((await getState(listener)).messages.some((m) => m.body === 'Thank you'));
});

test('contact details on Telegram need a tap to confirm, and photos are refused', async () => {
  await join(500);
  await join(600);
  await tap(600, 'listen');
  await tap(600, 'lt:go');
  await tap(500, 'vent');
  await text(500, 'Bad day at work');
  await tap(500, 'pick:auto');
  await tap(600, 'offer:yes');
  telegram.clear();

  await text(500, 'message me @someone_real');
  assert.ok(last(500).buttons.includes('confirm:send'));
  assert.equal(telegram.to(600).length, 0, 'nothing is relayed before confirming');
  await tap(500, 'confirm:send');
  assert.equal(last(600).text, 'message me @someone_real');

  await handleUpdate({ update_id: updateId++, message: { message_id: 9, chat: { id: 500, type: 'private' }, photo: [{}] } });
  assert.match(last(500).text, /Only text/);
});

test('report from Telegram closes the chat; group chats are ignored', async () => {
  await join(700);
  await join(800);
  await tap(800, 'listen');
  await tap(800, 'lt:go');
  await tap(700, 'vent');
  await text(700, 'Lonely tonight');
  await tap(700, 'pick:auto');
  await tap(800, 'offer:yes');
  await text(700, '/report');
  assert.ok(texts(700).some((t) => /will not be matched/.test(t)));
  const [row] = await db()`select count(*)::int as n from blocks`;
  assert.equal(row.n, 1);

  telegram.clear();
  await handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id: -5, type: 'group' }, text: 'hi' } });
  assert.equal(telegram.sent.length, 0);
});
