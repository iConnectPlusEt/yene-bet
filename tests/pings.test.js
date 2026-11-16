import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent, getState, answerPing, goAvailable, sweepAndMatch } from '../src/lib/server/chat.js';
import { saveProfile } from '../src/lib/server/profiles.js';
import { setPings, pingForChat } from '../src/lib/server/pings.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); process.env.MATCH_WINDOW_SECS = '1'; });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { delete process.env.MATCH_WINDOW_SECS; await telegram.close(); await closeDb(); });

async function pingable(chatId, story, { enabled = true } = {}) {
  const person = await tgPerson(chatId);
  await saveProfile(person, { story });
  if (enabled) await setPings(person.id, true);
  return person;
}
const pingsTo = (chatId) => telegram.to(chatId).filter((s) => s.buttons.some((b) => b.startsWith('ping:') && b !== 'ping:no'));

test('only opted-in listeners with the same experience are messaged, and the venter waits for them', async () => {
  const same = await pingable(9001, 'My father died three years ago.');
  await pingable(9002, 'I was laid off twice.');
  await pingable(9003, 'I lost my mom last year.', { enabled: false });

  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My dad died last month', topics: [] });
  assert.equal(started.holdingOut, true);
  assert.equal(pingsTo(9001).length, 1);
  assert.match(pingsTo(9001)[0].text, /losing a parent/);
  assert.equal(pingsTo(9002).length, 0, 'different experience');
  assert.equal(pingsTo(9003).length, 0, 'did not opt in');
  assert.equal((await getState(venter)).chat.searching, true);

  const answered = await answerPing(same, started.chatId);
  assert.equal(answered.connected, true);
  assert.equal((await getState(venter)).chat.mode, 'human');
  assert.ok(telegram.to(9001).some((s) => s.text === 'My dad died last month'));
});

test('the second listener to answer is told the person is already connected', async () => {
  const first = await pingable(9101, 'I lost my father.');
  const second = await pingable(9102, 'My mother passed away.');
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My dad died last month', topics: [] });
  assert.equal((await answerPing(first, started.chatId)).connected, true);
  assert.equal((await answerPing(second, started.chatId)).error, 'gone');
});

test('limits: once per chat, 30 minutes apart, three a day, never while busy or blocked', async () => {
  const listener = await pingable(9201, 'I lost my father.');
  const chats = [];
  for (let i = 0; i < 5; i++) {
    const v = await webPerson();
    const s = await startVent(v, { text: `My dad died last month ${i}`, topics: [] });
    const [chat] = await db()`select * from chats where id = ${s.chatId}`;
    chats.push(chat);
  }
  assert.equal(pingsTo(9201).length, 1, 'the 30 minute gap holds back the rest');
  assert.equal(await pingForChat(chats[0]), 0, 'never twice for the same chat');

  await db()`update pings set created_at = now() - interval '31 minutes'`;
  assert.equal(await pingForChat(chats[1]), 1);
  await db()`update pings set created_at = now() - interval '31 minutes'`;
  assert.equal(await pingForChat(chats[2]), 1);
  await db()`update pings set created_at = now() - interval '31 minutes'`;
  assert.equal(await pingForChat(chats[3]), 0, 'three a day is the cap');

  await db()`delete from pings`;
  await db()`insert into blocks (blocker_id, blocked_id) values (${chats[4].venter_id}, ${listener.id})`;
  assert.equal(await pingForChat(chats[4]), 0, 'blocked pairs are never put in touch');
  await goAvailable(listener);
  assert.equal(await pingForChat(chats[3]), 0, 'already available listeners are matched, not pinged');
});

test('if nobody answers in time, the venter gets whoever is free', async () => {
  await pingable(9301, 'I lost my father.');
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My dad died last month', topics: [] });
  const unrelated = await webPerson();
  await goAvailable(unrelated, ['work']);
  assert.equal((await getState(venter)).chat.mode, 'ai', 'still holding out for the listeners who were messaged');
  await db()`update chats set match_until = now() - interval '1 second' where id = ${started.chatId}`;
  await sweepAndMatch({ force: true });
  assert.equal((await getState(venter)).chat.mode, 'human');
});

test('Telegram: opting in, being pinged, tapping "I am free"', async () => {
  let n = 1;
  const send = (chatId, body) => handleUpdate({ update_id: n++, message: { message_id: n, chat: { id: chatId, type: 'private' }, text: body } });
  const tap = (chatId, data) => handleUpdate({ update_id: n++, callback_query: { id: String(n), data, from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: 'private' } } } });

  await send(9401, '/start');
  await tap(9401, 'rules:ok');
  await send(9401, '/listen');
  await send(9401, 'I lost my father when I was young.');
  await send(9401, '/pings on');
  assert.match(telegram.to(9401).at(-1).text, /losing a parent/);

  await send(9402, '/start');
  await tap(9402, 'rules:ok');
  await tap(9402, 'vent');
  await send(9402, 'My dad died last month and I feel lost');   // waits out the 1 second window
  const ping = pingsTo(9401)[0];
  assert.ok(ping, 'the away listener was messaged');
  await tap(9401, ping.buttons[0]);
  assert.ok(telegram.to(9401).some((s) => s.text === 'My dad died last month and I feel lost'));
  await send(9401, 'I am here. Tell me about him.');
  assert.equal(telegram.to(9402).at(-1).text, 'I am here. Tell me about him.');

  await send(9401, '/pings off');
  const [profile] = await db()`select ping_enabled from listener_profiles lp join people p on p.id = lp.person_id where p.tg_chat_id = 9401`;
  assert.equal(profile.ping_enabled, false);
});
