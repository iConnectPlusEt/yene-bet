import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent, sendMessage, goAvailable, getState } from '../src/lib/server/chat.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
let updateId = 12000;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const idOf = async (person, body) => (await getState(person)).messages.find((m) => m.body === body)?.id;

test('a reply shows both people which message it answers', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'My boss blamed me', topics: [] });
  await sendMessage(listener, 'What did you do?');
  await sendMessage(venter, 'I froze.');
  const asked = await idOf(venter, 'What did you do?');

  const sent = await sendMessage(venter, 'I said nothing, which I regret.', { replyTo: asked });
  assert.equal(sent.ok, true);

  const theirs = (await getState(listener)).messages.find((m) => m.body.startsWith('I said nothing'));
  assert.deepEqual(theirs.reply, { id: asked, from: 'me', body: 'What did you do?' }, 'the listener sees it was their own question');
  const mine = (await getState(venter)).messages.find((m) => m.body.startsWith('I said nothing'));
  assert.equal(mine.reply.from, 'them');
  assert.equal(mine.reply.body, 'What did you do?');
  const plain = (await getState(venter)).messages.find((m) => m.body === 'I froze.');
  assert.equal(plain.reply, null, 'ordinary messages have no quote');
});

test('a long quoted message is shortened', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Hello', topics: [] });
  await sendMessage(listener, 'x'.repeat(400));
  const longId = (await getState(venter)).messages.find((m) => m.body.startsWith('xxx')).id;
  await sendMessage(venter, 'ok', { replyTo: longId });
  const reply = (await getState(listener)).messages.find((m) => m.body === 'ok').reply;
  assert.ok(reply.body.length <= 141);
  assert.ok(reply.body.endsWith('…'));
});

test('only a real, visible message of the same conversation can be answered', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'First chat', topics: [] });
  const mineId = await idOf(venter, 'First chat');

  // A message from a different conversation, and a system note, cannot be quoted.
  const other = await webPerson();
  const another = await webPerson();
  await goAvailable(another, []);
  await startVent(other, { text: 'Somebody else private words', topics: [] });
  const foreign = await idOf(other, 'Somebody else private words');
  const note = (await getState(venter)).messages.find((m) => m.from === 'system').id;

  for (const bad of [foreign, note, 99999999, 'abc', -1, null]) {
    const r = await sendMessage(venter, `try ${bad}`, { replyTo: bad });
    assert.equal(r.ok, true, 'still sent, just without a quote');
    const stored = (await getState(listener)).messages.find((m) => m.body === `try ${bad}`);
    assert.equal(stored.reply, null, `no quote for ${bad}`);
  }
  assert.equal(JSON.stringify(await getState(listener)).includes('Somebody else private words'), false);
  const ok = await sendMessage(venter, 'with a good one', { replyTo: mineId });
  assert.equal(ok.ok, true);
});

test('Telegram: the quote is shown to the other person, and Telegram\'s own reply is understood', async () => {
  const listener = await webPerson();
  const venter = await tgPerson(9301);
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Rent went up again', topics: [] });
  await sendMessage(listener, 'That sounds really stressful.');
  const saidId = await idOf(listener, 'That sounds really stressful.');
  const venterMsg = await idOf(listener, 'Rent went up again');
  telegram.clear();

  // The website listener answers the venter's first message: the Telegram user sees what it answers.
  await sendMessage(listener, 'How much did it go up?', { replyTo: venterMsg });
  const got = telegram.to(9301).map((s) => s.text).find((t) => t?.includes('How much did it go up?'));
  assert.equal(got, '↪ “Rent went up again”\nHow much did it go up?');

  // The Telegram user uses Telegram's reply on the listener's message.
  await handleUpdate({
    update_id: updateId++,
    message: {
      message_id: 5, chat: { id: 9301, type: 'private' }, text: 'Yes, it is a lot.',
      reply_to_message: { message_id: 4, text: 'That sounds really stressful.' },
    },
  });
  const seen = (await getState(listener)).messages.find((m) => m.body === 'Yes, it is a lot.');
  assert.equal(seen.reply.id, saidId);
  assert.equal(seen.reply.from, 'me');

  // A Telegram reply to text we cannot match is simply sent as a normal message.
  await handleUpdate({
    update_id: updateId++,
    message: { message_id: 6, chat: { id: 9301, type: 'private' }, text: 'Another thing.', reply_to_message: { message_id: 1, text: 'text that is nowhere' } },
  });
  assert.equal((await getState(listener)).messages.find((m) => m.body === 'Another thing.').reply, null);
});

test('history keeps the quotes', async () => {
  const { endBoth } = await import('./helpers.js');
  const { openHistory } = await import('../src/lib/server/history.js');
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  const started = await startVent(venter, { text: 'Long day', topics: [] });
  await sendMessage(listener, 'Tell me about it.');
  await sendMessage(venter, 'Everything went wrong.', { replyTo: await idOf(venter, 'Tell me about it.') });
  await endBoth(venter);
  const opened = await openHistory(venter, started.chatId);
  assert.equal(opened.messages.find((m) => m.body === 'Everything went wrong.').reply.body, 'Tell me about it.');
});
