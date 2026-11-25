import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram, endBoth } from './helpers.js';
import { startVent, goAvailable, getState, sendMessage, sweepAndMatch } from '../src/lib/server/chat.js';
import { saveSubscription, removeSubscription, hasPush } from '../src/lib/server/push.js';
import { sendReminders } from '../src/lib/server/notify.js';
import { pingWave, WAVE2_SECS } from '../src/lib/server/pings.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
let updateId = 20000;
before(async () => { telegram = await fakeTelegram(); process.env.PUSH_FAKE = '1'; });
beforeEach(async () => { await resetDb(); telegram.clear(); globalThis.__pushSent = []; });
after(async () => { delete process.env.PUSH_FAKE; await telegram.close(); await closeDb(); });

const sub = (n) => ({ endpoint: `https://push.example.test/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });
const pushes = (person) => (globalThis.__pushSent || []).filter((p) => p.personId === person.id);

test('a browser subscription is saved, validated, and can be removed', async () => {
  const a = await webPerson();
  assert.equal(await hasPush(a.id), false);
  assert.equal((await saveSubscription(a, { endpoint: 'http://insecure.test/x', keys: { p256dh: 'a', auth: 'b' } })).ok, false, 'https only');
  assert.equal((await saveSubscription(a, { endpoint: 'https://x.test/1' })).ok, false, 'keys are required');
  assert.equal((await saveSubscription(a, sub(1))).ok, true);
  assert.equal(await hasPush(a.id), true);
  await removeSubscription(a);
  assert.equal(await hasPush(a.id), false);
});

test('a website visitor who allowed alerts is asked when someone is waiting; the alert has a category, never words', async () => {
  const listener = await webPerson();
  await saveSubscription(listener, sub(2));
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My secret sentence 4471 about my boss', topics: [], intent: 'advice' });
  const got = pushes(listener);
  assert.equal(got.length, 1, 'asked in the first wave');
  assert.match(got[0].body, /They would like advice/);
  assert.equal(got[0].url, `/?help=${started.chatId}`);
  assert.equal(JSON.stringify(got).includes('secret sentence'), false, 'never what was written');
  const [ping] = await db()`select channel from pings where person_id = ${listener.id}`;
  assert.equal(ping.channel, 'web');
});

test('answering the alert joins the person at once, and marks the request answered', async () => {
  const listener = await webPerson();
  await saveSubscription(listener, sub(3));
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'I cannot cope', topics: [] });
  const { answerPing } = await import('../src/lib/server/chat.js');
  const r = await answerPing(listener, started.chatId);
  assert.equal(r.ok, true);
  assert.equal(r.connected, true);
  assert.equal((await getState(listener)).screen, 'chat');
  const [ping] = await db()`select answered, answered_at from pings where person_id = ${listener.id}`;
  assert.equal(ping.answered, true);
  assert.ok(ping.answered_at);
});

test('people who answer fast and often are asked first; people who ignored three requests go last', async () => {
  const fast = await tgPerson(9801);
  const slow = await tgPerson(9802);
  const ignorer = await tgPerson(9803);
  // History: fast answered quickly twice; slow answered once, slowly; the ignorer ignored three in a row.
  const chat = (await db()`insert into chats (venter_id, venter_alias, opening, status, ended_at) select id, 'x', 'old', 'ended', now() - interval '2 days' from people limit 1 returning id`)[0];
  for (const [p, secs] of [[fast, 5], [fast, 8], [slow, 900]]) {
    await db()`insert into pings (person_id, chat_id, answered, answered_at, created_at)
               values (${p.id}, ${chat.id}, true, now() - interval '2 days' + make_interval(secs => ${secs}), now() - interval '2 days')`;
  }
  for (let i = 0; i < 3; i++) {
    await db()`insert into pings (person_id, chat_id, answered, created_at) values (${ignorer.id}, ${chat.id}, false, now() - make_interval(hours => ${40 + i}))`;
  }
  await db()`update people set last_seen_at = now() where tg_chat_id in (9801, 9802, 9803)`;
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  const order = telegram.sent.filter((s) => /Someone/.test(s.text || '')).map((s) => Number(s.chat_id));
  assert.deepEqual(order, [9801, 9802, 9803]);
});

test('a joined or replying person is alerted in the browser when away, with no message text', async () => {
  const venter = await webPerson();
  await saveSubscription(venter, sub(4));
  const listener = await webPerson();
  await db()`update people set last_seen_at = now() - interval '5 minutes' where id = ${venter.id}`;
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Hello there 9921', topics: [] });
  const joined = pushes(venter);
  assert.equal(joined.length, 1);
  assert.match(joined[0].body, /has joined/);
  await db()`update chats set last_notified_at = null`;
  await sendMessage(listener, 'A private reply 5532');
  const all = pushes(venter);
  assert.ok(all.some((p) => /replied/.test(p.body)));
  assert.equal(JSON.stringify(all).includes('private reply'), false);
  assert.equal(JSON.stringify(all).includes('Hello there'), false);
});

test('the waiting person is told how many people were asked', async () => {
  for (let i = 0; i < 5; i++) await tgPerson(9700 + i);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  const state = await getState(venter, { chatId: started.chatId });
  assert.equal(state.chat.asked, 5);
});

test('Telegram: /invite gives a share link, with a share button and no personal details', async () => {
  const p = await tgPerson(9901);
  telegram.clear();
  await handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id: 9901, type: 'private' }, text: '/invite' } });
  const msg = telegram.to(9901).at(-1);
  assert.match(msg.text, /Know someone who could listen/);
  assert.equal(JSON.stringify(msg).includes(p.id), false);
});

test('Telegram: someone waiting is told how many people were asked, in each wave', async () => {
  for (let i = 0; i < 12; i++) await tgPerson(9600 + i);
  const venter = await tgPerson(9690);
  telegram.clear();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  const told = () => telegram.to(9690).map((s) => s.text).filter((t) => /asked/.test(t || ''));
  assert.equal(told().length, 1);
  assert.match(told()[0], /I have asked 8 people to listen\. You will be connected the moment one says yes\./);
  assert.equal(JSON.stringify(told()).includes('breakup'), false, 'only a count, never what was written');

  await db()`update chats set created_at = now() - make_interval(secs => ${WAVE2_SECS + 1}) where id = ${started.chatId}`;
  await sweepAndMatch({ force: true });
  assert.equal(told().length, 2);
  assert.match(told()[1], /Still looking: I have now asked 12 people/);
});
