import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, resetDb, webPerson, tgPerson, fakeTelegram, endBoth } from './helpers.js';
import { startVent, goAvailable, getState, endChat, sendMessage } from '../src/lib/server/chat.js';
import { removeHistory } from '../src/lib/server/history.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
let updateId = 5000;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

async function talk(venter, listener, text) {
  await goAvailable(listener, []);
  const started = await startVent(venter, { text, topics: [] });
  assert.ok(started.ok);
  await sendMessage(venter, `${text} more`);
  return started.chatId;
}

test('a second chat with the same person points back at the first, by the name used then', async () => {
  const venter = await webPerson();
  const listener = await webPerson();
  await talk(venter, listener, 'first time');
  const before = await getState(venter);
  assert.equal(before.chat.previous, null, 'nothing earlier on the first chat');
  const firstName = before.chat.partner;
  await endBoth(venter);

  await talk(venter, listener, 'second time');
  const now = await getState(venter);
  assert.equal(now.chat.previous.with, firstName);
  const theirs = await getState(listener);
  assert.ok(theirs.chat.previous, 'the other side sees it too');
  assert.notEqual(theirs.chat.previous.with, firstName === theirs.chat.previous.with ? null : firstName);
});

test('someone else, or a removed conversation, shows no earlier chat', async () => {
  const venter = await webPerson();
  const listener = await webPerson();
  await talk(venter, listener, 'first time');
  await endBoth(venter);

  const stranger = await webPerson();
  await talk(stranger, listener, 'someone new');
  assert.equal((await getState(stranger)).chat.previous, null, 'a different person');
  await endBoth(stranger);

  const first = (await import('../src/lib/server/history.js')).listHistory;
  const mine = (await first(venter))[0];
  await removeHistory(venter, mine.id);
  await talk(venter, listener, 'third time');
  assert.equal((await getState(venter)).chat.previous, null, 'removed by the venter');
  assert.ok((await getState(listener)).chat.previous, 'the listener still has theirs');
});

test('Telegram: /history lists and opens saved conversations', async () => {
  const listener = await webPerson();
  const venter = await tgPerson(910);
  await talk(venter, listener, 'a hard week');
  await sendMessage(venter, 'I am tired');
  await endBoth(venter);
  telegram.clear();

  const text = (body) => handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id: 910, type: 'private' }, text: body } });
  const tap = (data) => handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), data, from: { id: 910 }, message: { message_id: 1, chat: { id: 910, type: 'private' } } } });
  await text('/history');
  const list = telegram.to(910).filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(list.text, /past conversations/);
  const open = list.buttons.find((b) => b.startsWith('hist:'));
  assert.ok(open);
  await tap(open);
  const shown = telegram.to(910).filter((s) => s.method === 'sendMessage').at(-1);
  assert.match(shown.text, /I am tired|a hard week/);
  assert.ok(shown.buttons.some((b) => b.startsWith('histdel:')));
});
