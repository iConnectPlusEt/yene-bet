import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import {
  startVent, sendMessage, goAvailable, getState, endChat, sweepAndMatch, presence, cleanup, report,
} from '../src/lib/server/chat.js';
import { runAi } from '../src/lib/server/aiListener.js';
import { listHistory, openHistory, removeHistory, removeAllHistory } from '../src/lib/server/history.js';
import { saveProfile } from '../src/lib/server/profiles.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); delete process.env.AI_FAKE; delete process.env.AI_FAKE_FAIL; });
after(async () => { process.env.AI_FAKE = '1'; delete process.env.AI_FAKE_FAIL; await telegram.close(); await closeDb(); });

const bodies = (state) => state.messages.map((m) => `${m.from}:${m.body}`);

test('with no AI, nothing replies: the venter is told the truth and can keep writing', async () => {
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  assert.equal(started.needsAi, false);
  for (const line of ['we are not talking', '3 days', 'dont hurt someone']) {
    const sent = await sendMessage(venter, line);
    assert.equal(sent.needsAi, false);
  }
  assert.equal(await runAi(started.chatId), null, 'even if asked, no scripted reply is produced');

  const state = await getState(venter);
  assert.equal(state.chat.mode, 'waiting');
  assert.equal(state.chat.typing, false);
  assert.equal(state.messages.filter((m) => m.from === 'ai').length, 0);
  assert.equal(state.messages.filter((m) => m.from === 'system').length, 1);
  assert.match(state.messages.find((m) => m.from === 'system').body, /No one is free this second/);
});

test('whoever joins the waiting room sees everything written and is connected at once', async () => {
  const venter = await webPerson();
  await startVent(venter, { text: 'the breakup', topics: [] });
  await sendMessage(venter, 'we are not talking');
  await sendMessage(venter, 'it has been 3 days');

  const listener = await webPerson();
  await goAvailable(listener, []);
  const v = await getState(venter);
  assert.equal(v.chat.mode, 'human', 'no "switch or stay" question: nobody was replying');
  assert.equal(v.chat.offer, null);
  const seen = bodies(await getState(listener));
  for (const line of ['the breakup', 'we are not talking', 'it has been 3 days']) assert.ok(seen.includes(`them:${line}`));
  assert.equal(seen.filter((b) => b === 'them:the breakup').length, 1, 'the opening is not shown twice');
});

test('a Telegram listener who joins is sent what was written so far', async () => {
  const venter = await webPerson();
  await startVent(venter, { text: 'the breakup', topics: [] });
  await sendMessage(venter, 'we are not talking');
  const listener = await tgPerson(6001);
  await goAvailable(listener, []);
  await handleUpdate({ update_id: 1, callback_query: { id: '1', data: 'offer:yes', from: { id: 6001 }, message: { message_id: 1, chat: { id: 6001, type: 'private' } } } });
  const texts = telegram.to(6001).map((s) => s.text);
  assert.ok(texts.includes('the breakup') && texts.includes('we are not talking'));
});

test('a failing AI says so and becomes a waiting room', async () => {
  process.env.AI_FAKE = '1';
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'I feel so alone', topics: [] });
  assert.equal(started.needsAi, true);
  process.env.AI_FAKE_FAIL = '1';
  await runAi(started.chatId);
  const state = await getState(venter);
  assert.equal(state.chat.mode, 'waiting');
  assert.ok(state.messages.some((m) => m.from === 'system' && /AI listener is not available/.test(m.body)));
  assert.equal(state.messages.filter((m) => m.from === 'ai').length, 0);
  assert.equal((await sendMessage(venter, 'still here')).needsAi, false);
});

test('presence counts listeners free and busy, and people waiting', async () => {
  assert.deepEqual(await presence(), { listenersFree: 0, listenersBusy: 0, waiting: 0 });
  const [a, b] = [await webPerson(), await webPerson()];
  await goAvailable(a, []);
  await goAvailable(b, []);
  assert.deepEqual(await presence(), { listenersFree: 2, listenersBusy: 0, waiting: 0 });
  const v1 = await webPerson();
  await startVent(v1, { text: 'one', topics: [] });
  assert.deepEqual(await presence(), { listenersFree: 1, listenersBusy: 1, waiting: 0 });
  const v2 = await webPerson();
  await startVent(v2, { text: 'two', topics: [] });
  const v3 = await webPerson();
  await startVent(v3, { text: 'three', topics: [] });
  assert.deepEqual(await presence(), { listenersFree: 0, listenersBusy: 2, waiting: 1 });
  assert.deepEqual((await getState(v3)).presence, { listenersFree: 0, listenersBusy: 2, waiting: 1 });
});

test('someone on Telegram who never turned anything on is asked when a venter is waiting', async () => {
  const away = await tgPerson(6101);
  await saveProfile(away, { story: 'I was laid off.' });
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  await sweepAndMatch({ force: true });
  await sweepAndMatch({ force: true });
  const pings = telegram.to(6101).filter((s) => /Can you listen right now/.test(s.text));
  assert.equal(pings.length, 1, 'asked once, straight away');
  assert.match(pings[0].text, /a breakup/);
  await handleUpdate({ update_id: 2, callback_query: { id: '2', data: pings[0].buttons[0], from: { id: 6101 }, message: { message_id: 1, chat: { id: 6101, type: 'private' } } } });
  assert.equal((await getState(venter)).chat.mode, 'human');
});

test('history: each person sees their own conversations and nobody else\'s', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  const answered = await startVent(venter, { text: 'My boss blamed me again', topics: [] });
  await sendMessage(listener, 'That is unfair.');
  await endChat(venter);
  const alone = await startVent(venter, { text: 'Nobody answered this one', topics: [] });
  await endChat(venter);

  const mine = await listHistory(venter);
  assert.deepEqual(mine.map((c) => c.id), [alone.chatId, answered.chatId]);
  assert.deepEqual(mine.map((c) => c.answered), [false, true]);
  assert.equal(JSON.stringify(mine).includes(listener.id), false);

  const theirs = await listHistory(listener);
  assert.deepEqual(theirs.map((c) => c.id), [answered.chatId]);
  assert.equal(theirs[0].role, 'listener');

  const opened = await openHistory(venter, answered.chatId);
  assert.ok(opened.messages.some((m) => m.from === 'them' && m.body === 'That is unfair.'));
  const stranger = await webPerson();
  assert.equal((await openHistory(stranger, answered.chatId)).error, 'not_found');
  assert.equal((await listHistory(stranger)).length, 0);
});

test('removing a conversation hides it from me only; it is deleted once nobody can see it', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  const started = await startVent(venter, { text: 'Hard week', topics: [] });
  await endChat(venter);

  await removeHistory(venter, started.chatId);
  assert.equal((await listHistory(venter)).length, 0);
  assert.equal((await listHistory(listener)).length, 1, 'the other person keeps their copy');
  assert.equal((await openHistory(venter, started.chatId)).error, 'not_found');
  await removeAllHistory(listener);
  assert.equal((await db()`select 1 from chats where id = ${started.chatId}`).length, 0, 'gone for good');
  assert.equal((await db()`select 1 from messages where chat_id = ${started.chatId}`).length, 0);

  // An unanswered vent has only one owner.
  const alone = await startVent(venter, { text: 'Just me', topics: [] });
  await endChat(venter);
  await removeHistory(venter, alone.chatId);
  assert.equal((await db()`select 1 from chats where id = ${alone.chatId}`).length, 0);
});

test('conversations are kept 30 days, and reported ones survive removal', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  const kept = await startVent(venter, { text: 'Recent', topics: [] });
  await endChat(venter);
  await db()`update chats set ended_at = now() - interval '29 days' where id = ${kept.chatId}`;
  assert.equal((await cleanup()).deletedChats, 0);
  await db()`update chats set ended_at = now() - interval '31 days' where id = ${kept.chatId}`;
  assert.equal((await cleanup()).deletedChats, 1);

  await goAvailable(listener, []);
  const other = await webPerson();
  const bad = await startVent(other, { text: 'This went badly', topics: [] });
  await report(other, 'abusive');
  await removeAllHistory(other);
  await removeAllHistory(listener);
  assert.equal((await db()`select 1 from chats where id = ${bad.chatId}`).length, 1, 'kept for review');
  assert.equal((await listHistory(other)).length, 0);
});
