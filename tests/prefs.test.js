import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, reload, fakeTelegram, endBoth } from './helpers.js';
import {
  startVent, sendMessage, goAvailable, candidates, getState, endChat, sweepAndMatch, respondOffer,
} from '../src/lib/server/chat.js';
import { saveProfile } from '../src/lib/server/profiles.js';
import { savePrefs, skipPrefs, cleanPrefs, adjacentBands } from '../src/lib/server/preferences.js';
import { createLinkCode, consumeLinkCode, unlinkChat, sendReminders } from '../src/lib/server/notify.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
let n = 1;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const send = (id, body) => handleUpdate({ update_id: n++, message: { message_id: n, chat: { id, type: 'private' }, text: body } });
const tap = (id, data) => handleUpdate({
  update_id: n++,
  callback_query: { id: String(n), data, from: { id }, message: { message_id: 1, chat: { id, type: 'private' } } },
});
const last = (id) => telegram.to(id).filter((s) => s.method === 'sendMessage').at(-1);
const withPrefs = async (person, prefs) => { await savePrefs(person, prefs); return reload(person.id); };
const away = (person) => db()`update people set last_seen_at = now() - interval '5 minutes' where id = ${person.id}`;

test('preferences keep only known values and are optional', async () => {
  assert.deepEqual(cleanPrefs({ ageBand: '12-17', gender: 'robot', language: 'xx', wantsAge: ['18-24', 'old'], wantsGender: 'everyone' }),
    { ageBand: null, gender: null, language: null, wantsAge: ['18-24'], wantsGender: null });
  assert.deepEqual(adjacentBands('25-34'), ['18-24', '25-34', '35-44']);
  assert.deepEqual(adjacentBands('18-24'), ['18-24', '25-34']);
  assert.deepEqual(adjacentBands(null), []);

  const person = await webPerson();
  assert.equal((await getState(await reload(person.id))).prefsSeen, false);
  await skipPrefs(person);
  const state = await getState(await reload(person.id));
  assert.equal(state.prefsSeen, true);
  assert.deepEqual(state.prefs, { ageBand: null, gender: null, language: null, wantsAge: [], wantsGender: null });
  await savePrefs(person, { ageBand: '25-34', gender: 'woman', language: 'am', wantsAge: ['25-34'], wantsGender: 'same' });
  assert.deepEqual((await getState(await reload(person.id))).prefs,
    { ageBand: '25-34', gender: 'woman', language: 'am', wantsAge: ['25-34'], wantsGender: 'same' });
});

test('a preference puts people first without being required', async () => {
  const early = await withPrefs(await webPerson(), { ageBand: '45+' });          // waited longest
  const fits = await withPrefs(await webPerson(), { ageBand: '25-34' });
  await goAvailable(early, []);
  await goAvailable(fits, []);
  const venter = await withPrefs(await webPerson(), { ageBand: '25-34', wantsAge: ['25-34'] });
  const list = await candidates(venter, 'a rough week', []);
  assert.deepEqual(list.candidates.map((c) => c.id), [fits.id, early.id], 'the preferred age comes first, the other is still offered');
});

test('what the listener asked for counts too, but a shared experience always wins', async () => {
  const sameExperience = await webPerson();
  await saveProfile(sameExperience, { story: 'My father died three years ago.' });
  await goAvailable(sameExperience, []);
  // Fits the venter's preferences perfectly in both directions (4 points), shares no experience.
  const perfect = await withPrefs(await webPerson(), { ageBand: '25-34', gender: 'woman', wantsAge: ['18-24'], wantsGender: 'man' });
  await goAvailable(perfect, []);
  const venter = await withPrefs(await webPerson(), { ageBand: '18-24', gender: 'man', wantsAge: ['25-34'], wantsGender: 'woman' });
  const list = await candidates(venter, 'My dad died last month', []);
  assert.equal(list.candidates[0].id, sameExperience.id);
  assert.equal(list.candidates[1].id, perfect.id);
});

test('preferences never make anyone wait: the only free listener is connected at once', async () => {
  const listener = await withPrefs(await webPerson(), { ageBand: '45+', gender: 'man' });
  await goAvailable(listener, []);
  const venter = await withPrefs(await webPerson(), { ageBand: '18-24', gender: 'woman', wantsAge: ['18-24'], wantsGender: 'woman' });
  const started = await startVent(venter, { text: 'Rough day', topics: [] });
  assert.equal(started.needsAi, false);
  assert.equal((await getState(venter)).chat.mode, 'human');
});

test('language preference decides the conversation language and who is offered first', async () => {
  const english = await withPrefs(await webPerson(), { language: 'en' });
  const amharic = await withPrefs(await webPerson(), { language: 'am' });
  await goAvailable(english, []);
  await goAvailable(amharic, []);
  const venter = await withPrefs(await webPerson(), { language: 'am' });
  const list = await candidates(venter, 'I feel low today', []);
  assert.equal(list.candidates[0].id, amharic.id);
  const started = await startVent(venter, { text: 'I feel low today', topics: [] });
  assert.equal((await db()`select language from chats where id = ${started.chatId}`)[0].language, 'am');
});

test('nobody can see anyone else\'s age or gender', async () => {
  const listener = await withPrefs(await webPerson(), { ageBand: '35-44', gender: 'woman', wantsGender: 'same' });
  await goAvailable(listener, []);
  const venter = await withPrefs(await webPerson(), { ageBand: '25-34', gender: 'woman' });
  const text = JSON.stringify(await candidates(venter, 'a rough week', []));
  for (const value of ['35-44', '25-34', 'woman', 'age_band', 'gender']) assert.equal(text.includes(value), false, value);

  await startVent(venter, { text: 'a rough week', topics: [] });
  for (const person of [venter, listener]) {
    const state = JSON.stringify((await getState(person)).chat);
    assert.equal(/35-44|25-34|woman/.test(state), false, 'the conversation holds nothing about the other person\'s age or gender');
  }
});

test('Telegram: preferences in one message; Skip leaves everything alone', async () => {
  await send(7001, '/start');
  await tap(7001, 'rules:ok');
  assert.ok(last(7001).buttons.includes('pf:skip'));
  await tap(7001, 'pf:skip');
  assert.equal((await db()`select prefs_seen_at is not null as seen, age_band from people where tg_chat_id = 7001`)[0].seen, true);
  assert.equal((await db()`select age_band from people where tg_chat_id = 7001`)[0].age_band, null);

  await send(7001, '/prefs');
  await tap(7001, 'pf:age:25-34');
  await tap(7001, 'pf:g:woman');
  await tap(7001, 'pf:l:am');
  await tap(7001, 'pf:ws');
  await tap(7001, 'pf:wg');
  assert.ok(telegram.to(7001).some((s) => s.method === 'editMessageReplyMarkup'), 'the ticks update on the same message');
  await tap(7001, 'pf:done');
  const [row] = await db()`select age_band, gender, language_pref, wants_age, wants_gender from people where tg_chat_id = 7001`;
  assert.deepEqual(
    [row.age_band, row.gender, row.language_pref, row.wants_age, row.wants_gender],
    ['25-34', 'woman', 'am', ['18-24', '25-34', '35-44'], 'same'],
  );
  assert.match(last(7001).text, /Saved/);
});

test('a conversation that goes quiet stays open, and says how long it has been quiet', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Hard week', topics: [] });
  await sendMessage(venter, 'Are you there?');
  await db()`update chats set last_message_at = now() - interval '4 hours'`;
  await sweepAndMatch({ force: true });
  const state = await getState(venter);
  assert.equal(state.screen, 'chat');
  assert.equal(state.chat.status, 'active');
  assert.ok(state.chat.quietSecs >= 4 * 3600 - 5, 'the writer is told how long the other has been silent');
  assert.equal((await getState(listener)).chat.quietSecs, 0, 'the one who owes the reply is not');
  assert.equal((await sendMessage(listener, 'Sorry, I am here now')).ok, true, 'and it simply continues when they write');
  assert.equal((await getState(venter)).chat.quietSecs, 0);
});

test('reminders go out after 2 and 24 hours, then stop, and a new message starts over; nothing is ended', async () => {
  const listener = await webPerson();
  const venter = await tgPerson(7101);
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Hard week', topics: [] });
  await sendMessage(listener, 'I am here. Tell me more.');          // the venter (Telegram) now owes a reply
  const reminders = () => telegram.to(7101).filter((s) => /is waiting to hear from you/.test(s.text || ''));

  await db()`update chats set last_message_at = now() - interval '1 hour'`;
  assert.equal(await sendReminders(), 0);
  await db()`update chats set last_message_at = now() - interval '3 hours'`;
  assert.equal(await sendReminders(), 1);
  assert.match(reminders()[0].text, /Just reply here/);
  assert.equal(await sendReminders(), 0, 'not again straight away');
  await db()`update chats set last_message_at = now() - interval '25 hours'`;
  assert.equal(await sendReminders(), 1);
  await db()`update chats set last_message_at = now() - interval '5 days'`;
  assert.equal(await sendReminders(), 0, 'two reminders, then it stops');
  assert.equal(reminders().length, 2);
  assert.equal((await db()`select status from chats`)[0].status, 'active', 'never ended for them');

  await sendMessage(venter, 'Sorry, I was away');                   // moves the conversation on
  await db()`update chats set last_message_at = now() - interval '3 hours'`;
  assert.equal(await sendReminders(), 0, 'the listener is reachable only on the website and has not linked Telegram');
  assert.equal((await db()`select reminders_sent from chats`)[0].reminders_sent, 1, 'the count started over');
});

test('linking Telegram: one-time, short-lived, and for notifications only', async () => {
  const web = await webPerson();
  const code = await createLinkCode(web);
  assert.match(code, /^[0-9a-f]{24}$/);

  await send(7201, `/start link_${code}`);
  assert.match(last(7201).text, /Done. I will message you here/);
  assert.equal((await db()`select notify_tg_chat_id from people where id = ${web.id}`)[0].notify_tg_chat_id, '7201');
  // The Telegram user is a separate person: nothing was merged or copied.
  assert.equal((await db()`select channel from people where tg_chat_id = 7201`)[0].channel, 'telegram');

  await send(7202, `/start link_${code}`);
  assert.match(last(7202).text, /expired or was already used/, 'a code works once');
  const old = await createLinkCode(web);
  await db()`update link_codes set expires_at = now() - interval '1 minute'`;
  assert.equal(await consumeLinkCode(old, 7203), false, 'and only for 15 minutes');
  assert.equal(await consumeLinkCode('not-a-code', 7203), false);

  assert.equal(await unlinkChat(7201), 1);
  assert.equal((await db()`select notify_tg_chat_id from people where id = ${web.id}`)[0].notify_tg_chat_id, null);
  const again = await createLinkCode(web);
  await send(7201, `/start link_${again}`);
  await send(7201, '/unlink');
  assert.match(last(7201).text, /not message you about the website/);
  assert.equal((await db()`select notify_tg_chat_id from people where id = ${web.id}`)[0].notify_tg_chat_id, null);
});

test('a linked website visitor who is away is told about replies, joins, and waiting: never what was written', async () => {
  const web = await webPerson();
  await consumeLinkCode(await createLinkCode(web), 7301);
  const tgListener = await tgPerson(7302);
  const webVenter = web;

  // Waiting room, then a Telegram listener joins while the visitor is away.
  await startVent(webVenter, { text: 'A very private sentence', topics: [] });
  await away(webVenter);
  await goAvailable(tgListener, []);
  await respondOffer(await reload(tgListener.id), true);
  const toVisitor = () => telegram.to(7301).filter((s) => s.text);
  assert.equal(toVisitor().length, 1);
  assert.match(toVisitor()[0].text, /has joined. Open My Home to talk./);

  // A reply while away: one notification per 10 minutes at most.
  await db()`update chats set last_notified_at = now() - interval '11 minutes'`;
  await sendMessage(await reload(tgListener.id), 'I am here. What happened?');
  assert.equal(toVisitor().length, 2);
  assert.match(toVisitor()[1].text, /replied. Open My Home to read it./);
  await sendMessage(await reload(tgListener.id), 'Take your time.');
  assert.equal(toVisitor().length, 2, 'not for every message');
  for (const s of toVisitor()) assert.equal(/private sentence|What happened|Take your time/.test(s.text), false, 'no message text in a notification');

  // Present on the website: no notification.
  await db()`update chats set last_notified_at = now() - interval '11 minutes'`;
  await db()`update people set last_seen_at = now() where id = ${web.id}`;
  await sendMessage(await reload(tgListener.id), 'Still here.');
  assert.equal(toVisitor().length, 2, 'they are looking at it already');

  // Reminders reach the linked chat too.
  await sendMessage(await reload(tgListener.id), 'Whenever you are ready.');
  await db()`update chats set last_message_at = now() - interval '3 hours'`;
  assert.equal(await sendReminders(), 1);
  assert.match(toVisitor().at(-1).text, /is waiting to hear from you\./);
});

test('without a linked Telegram, a website visitor is simply not messaged', async () => {
  const web = await webPerson();
  const tgListener = await tgPerson(7401);
  await startVent(web, { text: 'Hello', topics: [] });
  await goAvailable(tgListener, []);
  await respondOffer(await reload(tgListener.id), true);
  await away(web);
  await sendMessage(await reload(tgListener.id), 'Hi there');
  assert.equal(telegram.sent.filter((s) => /replied/.test(s.text || '')).length, 0);
});

test('a web venter who left the waiting room is not offered to listeners; a Telegram venter still is', async () => {
  const webVenter = await webPerson();
  const started = await startVent(webVenter, { text: 'Is anyone there?', topics: [] });
  await db()`update people set last_seen_at = now() - interval '20 minutes' where id = ${webVenter.id}`;   // left the page
  const listener = await webPerson();
  await goAvailable(listener, []);
  assert.equal((await db()`select mode from chats where id = ${started.chatId}`)[0].mode, 'ai', 'nobody is sent to an empty room');
  await db()`update people set last_seen_at = now() where id = ${webVenter.id}`;                 // they come back
  await sweepAndMatch({ force: true });
  assert.equal((await db()`select mode from chats where id = ${started.chatId}`)[0].mode, 'human');

  const tgVenter = await tgPerson(7501);
  await startVent(tgVenter, { text: 'Hello from Telegram', topics: [] });
  await db()`update people set last_seen_at = now() - interval '3 hours' where id = ${tgVenter.id}`;
  const second = await webPerson();
  await goAvailable(second, []);
  assert.equal((await getState(tgVenter)).chat.mode, 'human', 'their listener\'s messages reach them as notifications later');
});

test('Telegram: in a conversation, /vent asks whether to keep it or end it', async () => {
  const listener = await webPerson();
  const venter = await tgPerson(7601);
  await goAvailable(listener, []);
  await startVent(venter, { text: 'First conversation', topics: [] });
  await send(7601, '/vent');
  assert.deepEqual(last(7601).buttons, ['restart:no', 'restart:vent']);
  assert.equal((await db()`select status from chats`)[0].status, 'active');

  await tap(7601, 'restart:no');
  assert.match(last(7601).text, /stays open/);
  assert.equal((await db()`select status from chats`)[0].status, 'active');

  await send(7601, '/vent');
  await tap(7601, 'restart:vent');
  assert.equal((await db()`select status from chats`)[0].status, 'ended');
});
