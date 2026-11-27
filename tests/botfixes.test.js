import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent, goAvailable, getState, endChat, sendMessage } from '../src/lib/server/chat.js';
import { getStats } from '../src/lib/server/stats.js';
import { report } from '../src/lib/server/chat.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

test('someone who blocked the bot cannot hold a conversation open: the other person can end it at once', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await tgPerson(9951);
  const started = await startVent(venter, { text: 'Hard night', topics: [] });
  assert.ok(started.ok);
  // The Telegram person blocks the bot.
  telegram.block(9951);
  await sendMessage(listener, 'Are you still there?');
  const [gone] = await db()`select unreachable_at from people where id = ${venter.id}`;
  assert.ok(gone.unreachable_at, 'the failed send marks them unreachable');

  // The sender is told they have left, and the chat shows the partner as away.
  const s = await getState(listener);
  assert.ok(s.messages.some((m) => m.from === 'system' && /seem to have left/.test(m.body)));
  assert.equal(s.chat.partnerAway, true);

  // Ending does not wait for someone who can never answer.
  const r = await endChat(listener);
  assert.equal(r.pending, undefined);
  assert.equal((await getState(listener, { chatId: started.chatId })).chat.status, 'ended');
});

test('two people who are both reachable: one End closes it for both', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'Long day', topics: [] });
  const r = await endChat(venter);
  assert.equal(r.ok, true);
  assert.equal((await getState(listener, { chatId: started.chatId })).chat.status, 'ended');
});

test('the same Telegram update is handled once, and a failure is answered politely', async () => {
  const { processUpdate } = await import('../src/lib/server/telegramWebhook.js');
  const update = { update_id: 777001, message: { message_id: 1, chat: { id: 9961, type: 'private' }, text: '/start' } };
  assert.equal((await processUpdate(update)).duplicate, false);
  const first = telegram.to(9961).length;
  assert.ok(first > 0, 'the first delivery is answered');
  assert.equal((await processUpdate(update)).duplicate, true);
  assert.equal(telegram.to(9961).length, first, 'a redelivery is ignored');

  // Something throws inside the bot: the person is told, not left in silence.
  const bad = { update_id: 777002, message: { message_id: 2, chat: { id: 9962, type: 'private' }, get text() { throw new Error('boom'); } } };
  const result = await processUpdate(bad);
  assert.equal(result.failed, true);
  assert.match(telegram.to(9962).at(-1).text, /Something went wrong on my side/);

  // Never in groups.
  await processUpdate({ update_id: 777003, message: { message_id: 3, chat: { id: -5, type: 'group' }, get text() { throw new Error('boom'); } } });
  assert.equal(telegram.to(-5).length, 0);
});

test('reports are counted on the private stats, as numbers only', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await webPerson();
  await startVent(venter, { text: 'Someone is rude', topics: [] });
  await report(listener, 'rude');
  const stats = await getStats();
  assert.equal(stats.safety.reports, 1);
  assert.equal(stats.safety.reports7d, 1);
  assert.equal(JSON.stringify(stats.safety).includes('rude'), false);
});
