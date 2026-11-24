import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent, goAvailable, getState, candidates } from '../src/lib/server/chat.js';
import { requestText } from '../src/lib/server/pings.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

test('advice or just listening: only those two are accepted; none means "just listen"', async () => {
  const venter = await webPerson();
  assert.equal((await startVent(venter, { text: 'Hard week', topics: [], intent: 'fix me' })).error, 'intent_needed');
  assert.equal((await db()`select count(*)::int as n from chats`)[0].n, 0, 'nothing was started');

  const started = await startVent(venter, { text: 'Hard week', topics: [] });
  assert.equal(started.ok, true);
  assert.equal((await db()`select intent from chats`)[0].intent, 'listen', 'advice is never assumed');
});

test('the listener is told what the person asked for, in the chat and in the header data', async () => {
  for (const [intent, intro, label] of [
    ['advice', /would like your advice/, 'advice'],
    ['listen', /just want to be heard/, 'listen'],
  ]) {
    await resetDb();
    const listener = await webPerson();
    await goAvailable(listener, []);
    const venter = await webPerson();
    await startVent(venter, { text: 'My boss blamed me', topics: [], intent });
    const state = await getState(listener);
    assert.equal(state.chat.intent, label);
    assert.ok(state.messages.some((m) => m.from === 'system' && intro.test(m.body)), `intro for ${intent}`);
    assert.equal((await getState(venter)).chat.intent, label, 'the venter sees their own choice');
  }
});

test('Telegram listeners are told in the offer and in the request wave', async () => {
  const listener = await tgPerson(9501);
  await goAvailable(listener, []);
  const venter = await webPerson();
  await startVent(venter, { text: 'I cannot cope', topics: [], intent: 'advice' });
  const offer = telegram.to(9501).map((s) => s.text).find((t) => /needs to vent/.test(t || ''));
  assert.match(offer, /They would like advice\./);

  assert.match(requestText({ experiences: [], intent: 'advice' }, {}), /They would like advice\./);
  assert.match(requestText({ experiences: [], intent: 'listen' }, {}), /They just want to be heard\./);
});

test('the choice never changes who is offered or in what order', async () => {
  const a = await webPerson();
  const b = await webPerson();
  await goAvailable(a, []);
  await goAvailable(b, []);
  const venter = await webPerson();
  const order = (await candidates(venter, 'I need to talk', [])).candidates.map((c) => c.id);
  const first = await startVent(venter, { text: 'I need to talk', topics: [], intent: 'advice' });
  const chat = (await db()`select listener_id from chats where id = ${first.chatId}`)[0];
  assert.equal(chat.listener_id, order[0], 'the same person is picked either way');
});
