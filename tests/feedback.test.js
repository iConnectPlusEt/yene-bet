import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson } from './helpers.js';
import { startVent, goAvailable, candidates, getState, endChat, stopListening } from '../src/lib/server/chat.js';
import { giveFeedback, reputationOf } from '../src/lib/server/feedback.js';

beforeEach(resetDb);
after(closeDb);

async function chatBetween(venter, listener, text = 'Rough day') {
  await goAvailable(listener, []);
  const started = await startVent(venter, { text, topics: [] });
  await endChat(venter);
  return started.chatId;
}

test('reputation: helping counts for a listener, repeated "no" counts against', () => {
  assert.equal(reputationOf(0, 0), 0);
  assert.equal(reputationOf(2, 0), 2);
  assert.equal(reputationOf(10, 0), 3);
  assert.equal(reputationOf(1, 2), -3);
});

test('the venter can rate once; the listener sees the thank-you once', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  const chatId = await chatBetween(venter, listener);

  let state = await getState(venter, { chatId });
  assert.equal(state.chat.canRate, true);
  assert.equal((await getState(listener, { chatId })).chat.canRate, false, 'only the venter is asked');

  assert.equal((await giveFeedback(venter, { heard: 2, note: 'call me 0911 234 567' })).error, 'contact_in_note');
  assert.equal((await giveFeedback(venter, { heard: 2, note: 'You made tonight bearable.' })).ok, true);
  assert.equal((await giveFeedback(venter, { heard: 2 })).error, 'nothing_to_rate');
  assert.equal((await getState(venter, { chatId })).chat.canRate, false);

  const home = await getState(listener);
  assert.equal(home.thanks.length, 1);
  assert.match(home.thanks[0].text, /felt heard/);
  assert.match(home.thanks[0].text, /You made tonight bearable\./);
  assert.equal(home.helped, 1);
  assert.equal((await getState(listener)).thanks.length, 0, 'shown once');
});

test('a "no" is recorded quietly and AI chats are never rated', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await chatBetween(venter, listener);
  await giveFeedback(venter, { heard: 0 });
  assert.equal((await getState(listener)).thanks.length, 0);
  const [profile] = await db()`select helped_count, not_heard_count from listener_profiles where person_id = ${listener.id}`;
  assert.deepEqual([profile.helped_count, profile.not_heard_count], [0, 1]);

  const alone = await webPerson();
  const started = await startVent(alone, { text: 'Nobody is here', topics: [] });
  await endChat(alone);
  assert.equal((await getState(alone, { chatId: started.chatId })).chat.canRate, false);
});

test('listeners who helped are ranked above equally matched ones, poorly rated ones below', async () => {
  const fresh = await webPerson();
  const helpful = await webPerson();
  const poor = await webPerson();
  for (const [listener, heard, times] of [[helpful, 2, 2], [poor, 0, 1]]) {
    for (let i = 0; i < times; i++) {
      const v = await webPerson();
      await chatBetween(v, listener);
      await giveFeedback(v, { heard });
    }
  }
  // "fresh" has waited longest, which would otherwise put them first.
  await goAvailable(fresh, []);
  await goAvailable(poor, []);
  await goAvailable(helpful, []);
  const venter = await webPerson();
  const list = await candidates(venter, 'I need to talk', []);
  assert.deepEqual(list.candidates.map((c) => c.id), [helpful.id, fresh.id, poor.id]);
  assert.equal(list.candidates[0].helped, 2);
  for (const l of [fresh, poor, helpful]) await stopListening(l);
});
