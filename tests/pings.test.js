import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram, endBoth } from './helpers.js';
import {
  startVent, getState, answerPing, goAvailable, sweepAndMatch, endChat, TELEGRAM_LISTENER_TTL,
} from '../src/lib/server/chat.js';
import { saveProfile } from '../src/lib/server/profiles.js';
import { setPings, pingWave, WAVE_SIZES, WAVE2_SECS, WAVE3_SECS, MIN_FIRST_WAVE } from '../src/lib/server/pings.js';
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
const requests = (chatId) => telegram.to(chatId).filter((s) => /Can you listen right now/.test(s.text || ''));
const chatOf = async (chatId) => (await db()`select * from chats where id = ${chatId}`)[0];
const ago = (chatId, secs) => db()`update chats set created_at = now() - make_interval(secs => ${secs}) where id = ${chatId}`;

test('everyone on Telegram is asked, best fit first, even with no profile and nothing turned on', async () => {
  const fits = await tgPerson(9001);
  await saveProfile(fits, { story: 'My father died three years ago.' });
  await tgPerson(9002);                                                // never said anything about themselves
  await db()`update people set last_seen_at = now() + interval '1 minute' where tg_chat_id = 9002`;   // the most recently active
  const stopped = await tgPerson(9003);
  await setPings(stopped.id, false);
  const other = await tgPerson(9004);
  await saveProfile(other, { story: 'I was laid off twice.' });
  await tgPerson(9005);

  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My dad died last month', topics: [] });
  assert.ok(started.ok);

  assert.equal(requests(9001).length, 1);
  assert.match(requests(9001)[0].text, /losing a parent, which you have been through/, 'the person who fits is told why');
  assert.match(requests(9002)[0].text, /Someone is going through losing a parent\./);
  assert.equal(requests(9003).length, 0, 'stopped these messages');
  const asked = [9001, 9002, 9004, 9005].filter((id) => requests(id).length);
  // Wave 1: the two people who have a profile (they have listened or offered), topped up with one newer person.
  assert.equal(asked.length, MIN_FIRST_WAVE, 'warm people first, topped up to three');
  assert.ok(asked.includes(9001) && asked.includes(9002), 'best fit first');
  assert.deepEqual(requests(9001)[0].buttons, ['ping:' + started.chatId, 'ping:no', 'ping:week', 'ping:stop']);
  assert.equal(/what they wrote|dad died/i.test(requests(9002)[0].text), false, 'what they wrote is never shown');
});

test('later waves widen to everyone else: 8, then 15, then the rest, nobody asked twice', async () => {
  for (let i = 0; i < 40; i++) await tgPerson(9100 + i);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });
  const total = () => [...Array(40)].filter((_, i) => requests(9100 + i).length).length;
  assert.equal(total(), MIN_FIRST_WAVE, 'nobody here has answered before, so the first wave is the small top-up');

  await sweepAndMatch({ force: true });
  assert.equal(total(), MIN_FIRST_WAVE, 'nothing more before 20 seconds');
  await ago(started.chatId, WAVE2_SECS + 1);
  await sweepAndMatch({ force: true });
  assert.equal(total(), MIN_FIRST_WAVE + WAVE_SIZES[1]);
  await sweepAndMatch({ force: true });
  assert.equal(total(), MIN_FIRST_WAVE + WAVE_SIZES[1], 'a wave goes out once');
  await ago(started.chatId, WAVE3_SECS + 1);
  await sweepAndMatch({ force: true });
  assert.equal(total(), 40, 'wave 3 asks everyone left');
  for (let i = 0; i < 40; i++) assert.ok(requests(9100 + i).length <= 1);
  assert.equal((await chatOf(started.chatId)).ping_wave, 3);
});

test('limits: once per chat, 30 minutes apart, three a day, never in a conversation or with a blocked pair', async () => {
  const person = await tgPerson(9201);
  await saveProfile(person, { story: 'I was laid off twice.' });   // someone who has offered to listen is "warm"
  const chats = [];
  for (let i = 0; i < 5; i++) {
    const v = await webPerson();
    const s = await startVent(v, { text: `the breakup ${i}`, topics: [] });
    chats.push(await chatOf(s.chatId));
  }
  assert.equal(requests(9201).length, 1, 'the 30 minute gap holds back the rest');
  assert.equal((await pingWave(chats[0], 2)).sent, 0, 'never twice for the same chat');

  for (const i of [1, 2]) {
    await db()`update pings set created_at = now() - interval '31 minutes'`;
    assert.equal((await pingWave(chats[i], 2)).sent, 1);
  }
  await db()`update pings set created_at = now() - interval '31 minutes'`;
  assert.equal((await pingWave(chats[3], 2)).sent, 0, 'three a day is the cap');

  await db()`delete from pings`;
  await db()`insert into blocks (blocker_id, blocked_id) values (${chats[4].venter_id}, ${person.id})`;
  assert.equal((await pingWave(chats[4], 2)).sent, 0, 'blocked pairs are never put in touch');
  await db()`delete from blocks`;
  await db()`update pings set created_at = now() - interval '2 days'`;
  await goAvailable(person);
  assert.equal((await pingWave(chats[4], 2)).sent, 0, 'people in the pool are offered conversations, not asked');
});

test('inactive, suspended and busy people are skipped', async () => {
  const old = await tgPerson(9301);
  await db()`update people set last_seen_at = now() - interval '31 days' where id = ${old.id}`;
  const suspended = await tgPerson(9302);
  await db()`update people set suspended_at = now() where id = ${suspended.id}`;
  const busy = await tgPerson(9303);
  await startVent(busy, { text: 'I am venting right now', topics: [] });       // in a conversation of their own
  await tgPerson(9304);
  telegram.clear();

  const venter = await webPerson();
  await startVent(venter, { text: 'the breakup', topics: [] });
  for (const id of [9301, 9302, 9303]) assert.equal(requests(id).length, 0, `${id} is skipped`);
  assert.equal(requests(9304).length, 1, 'the one eligible person is asked');
});

test('"Not now" leaves someone alone for two hours; "Stop these" until they turn it back on', async () => {
  await tgPerson(9401);
  const v1 = await webPerson();
  await startVent(v1, { text: 'the breakup', topics: [] });
  const ask = requests(9401)[0];
  assert.ok(ask);

  await tap(9401, 'ping:no');
  assert.match(telegram.to(9401).at(-1).text, /leave you alone for a couple of hours/);
  await db()`delete from pings`;
  const v2 = await webPerson();
  await startVent(v2, { text: 'the breakup again', topics: [] });
  assert.equal(requests(9401).length, 1, 'snoozed: not asked again');
  await db()`update people set notify_snoozed_until = now() - interval '1 minute'`;
  const v3 = await webPerson();
  await startVent(v3, { text: 'a third breakup', topics: [] });
  assert.equal(requests(9401).length, 2, 'asked again after the snooze');

  await tap(9401, 'ping:stop');
  assert.match(telegram.to(9401).at(-1).text, /\/pings on/);
  await db()`delete from pings`;
  const v4 = await webPerson();
  await startVent(v4, { text: 'a fourth breakup', topics: [] });
  assert.equal(requests(9401).length, 2, 'stopped');

  await send(9401, '/pings on');
  await db()`delete from pings`;
  const v5 = await webPerson();
  await startVent(v5, { text: 'a fifth breakup', topics: [] });
  assert.equal(requests(9401).length, 3, 'back on');
});

test('someone who blocked the bot is never messaged again, until they write to it themselves', async () => {
  await tgPerson(9501);
  telegram.block(9501);
  const v1 = await webPerson();
  await startVent(v1, { text: 'the breakup', topics: [] });
  assert.ok((await db()`select unreachable_at from people where tg_chat_id = 9501`)[0].unreachable_at, 'marked unreachable');
  const attempts = await db()`select count(*)::int as n from pings`;
  const v2 = await webPerson();
  await db()`delete from pings`;
  await startVent(v2, { text: 'the breakup again', topics: [] });
  assert.equal((await db()`select count(*)::int as n from pings`)[0].n, 0, 'not even tried again');
  assert.equal(attempts[0].n, 1);
  telegram.unblock(9501);                                                          // they write to the bot themselves
  await send(9501, '/start');
  assert.equal((await db()`select unreachable_at from people where tg_chat_id = 9501`)[0].unreachable_at, null);
});

test('the answer goes straight in with one tap; a second person who taps too late can become available for 24 hours', async () => {
  const first = await tgPerson(9601);
  await tgPerson(9602);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'the breakup', topics: [] });

  await tap(9601, `ping:${started.chatId}`);
  assert.ok(telegram.to(9601).some((s) => s.text === 'the breakup'), 'what was written arrives at once');
  assert.match(telegram.to(9601).at(-1).text, /Send \/end/);
  assert.equal((await getState(venter)).chat.mode, 'human');
  assert.equal((await db()`select answered from pings where person_id = ${first.id}`)[0].answered, true);

  await tap(9602, `ping:${started.chatId}`);
  const late = telegram.to(9602).at(-1);
  assert.match(late.text, /already been connected with someone else/);
  assert.deepEqual(late.buttons, ['listen:go']);
  await tap(9602, 'listen:go');
  const [row] = await db()`
    select extract(epoch from expires_at - now()) as secs
    from listeners l join people p on p.id = l.person_id where p.tg_chat_id = 9602`;
  assert.ok(Number(row.secs) > 23 * 3600, 'available for 24 hours');
});

test('listening is one tap once they have told us what they have been through, and lasts 24 hours', async () => {
  await send(9701, '/start');
  await tap(9701, 'rules:ok');
  await send(9701, '/listen');
  assert.ok(telegram.to(9701).at(-1).buttons.includes('lt:go'), 'the first time: the short form');
  await send(9701, 'I lost my father when I was young.');
  await tap(9701, 'lt:go');
  assert.match(telegram.to(9701).at(-1).text, /next 24 hours/);
  assert.match(telegram.to(9701).at(-1).text, /losing a parent/);

  await send(9701, '/stop');
  assert.equal((await db()`select 1 from listeners`).length, 0);
  await send(9701, '/listen');                                                      // saved profile: no form
  assert.match(telegram.to(9701).at(-1).text, /next 24 hours/);
  assert.deepEqual(telegram.to(9701).at(-1).buttons, ['listen:edit']);
  const [row] = await db()`select extract(epoch from expires_at - now()) as secs from listeners`;
  assert.ok(Math.abs(row.secs - TELEGRAM_LISTENER_TTL) < 60);

  await tap(9701, 'listen:edit');
  assert.ok(telegram.to(9701).at(-1).buttons.includes('lt:go'), 'changing it shows the form again');
});

test('people who joined before are told once about the messages; new people see it on the rules screen', async () => {
  await tgPerson(9801, { told: false });
  await send(9801, '/start');
  const notices = () => telegram.to(9801).filter((s) => /I may message you to ask if you can listen/.test(s.text));
  assert.equal(notices().length, 1);
  assert.deepEqual(notices()[0].buttons, ['ping:stop']);
  await send(9801, '/start');
  assert.equal(notices().length, 1, 'only once');

  await send(9802, '/start');
  assert.match(telegram.to(9802)[0].text, /I may also message you when someone is waiting/);
  await tap(9802, 'rules:ok');
  await send(9802, '/start');
  assert.equal(telegram.to(9802).filter((s) => /I may message you to ask/.test(s.text)).length, 0, 'the rules screen already told them');

  // The first request to someone who has not yet been told repeats how to stop.
  await tgPerson(9803, { told: false });
  const venter = await webPerson();
  await startVent(venter, { text: 'the breakup', topics: [] });
  assert.match(requests(9803)[0].text, /Tap "Stop these" any time/);
});

test('a venter can set off the wide request waves four times a day, not more', async () => {
  for (let i = 0; i < 6; i++) await tgPerson(9900 + i);
  const venter = await webPerson();
  for (let i = 0; i < 5; i++) {
    await db()`delete from pings`;
    const started = await startVent(venter, { text: `breakup number ${i}`, topics: [] });
    const asked = [...Array(6)].filter((_, k) => requests(9900 + k).length).length;
    telegram.clear();
    if (i < 4) assert.ok(asked > 0, `vent ${i + 1} sets off a wave`);
    else assert.equal(asked, 0, 'the fifth does not');
    await endBoth(venter);
    await db()`delete from rate_limits where key like 'start:%'`;
    assert.ok(started.ok);
  }
});

test('people who have never answered are asked once a day, and left alone for a week after ignoring three', async () => {
  const cold = await tgPerson(9251);
  const chats = [];
  for (let i = 0; i < 4; i++) {
    const v = await webPerson();
    chats.push(await chatOf((await startVent(v, { text: `the breakup ${i}`, topics: [] })).chatId));
  }
  assert.equal(requests(9251).length, 1, 'asked about the first');
  await db()`update pings set created_at = now() - interval '31 minutes'`;
  assert.equal((await pingWave(chats[1], 2)).sent, 0, 'a person who never answers is asked once a day, not three times');

  // A day later they may be asked again; after three ignored requests in a row they are paused for a week.
  for (const i of [1, 2]) {
    await db()`update pings set created_at = created_at - interval '2 days'`;
    assert.equal((await pingWave(chats[i], 2)).sent, 1);
  }
  await db()`update pings set created_at = created_at - interval '2 days'`;
  await db()`update pings set created_at = now() - interval '2 days' where id = (select max(id) from pings)`;
  assert.equal((await pingWave(chats[3], 2)).sent, 0, 'three ignored in a row: left alone for a week');
  await db()`update pings set created_at = now() - interval '8 days'`;
  assert.equal((await pingWave(chats[3], 2)).sent, 1, 'asked again once the week is over');
});

test('what people answer is recorded, and "not now" is not counted as ignoring', async () => {
  const { recordResponse } = await import('../src/lib/server/pings.js');
  const p = await tgPerson(9261);
  const v = await webPerson();
  await startVent(v, { text: 'the breakup', topics: [] });
  await recordResponse(p.id, 'not_now');
  const [row] = await db()`select response, answered from pings where person_id = ${p.id}`;
  assert.deepEqual([row.response, row.answered], ['not_now', false]);

  // Tapping the buttons does the same, and a week-long pause is applied.
  const tap = (data) => handleUpdate({ update_id: 30000 + Math.floor(Math.random() * 1e6), callback_query: { id: 'x', data, from: { id: 9261 }, message: { message_id: 1, chat: { id: 9261, type: 'private' } } } });
  await db()`update pings set response = null`;
  await tap('ping:week');
  const [after] = await db()`select response from pings where person_id = ${p.id}`;
  assert.equal(after.response, 'week');
  const [snooze] = await db()`select notify_snoozed_until > now() + interval '6 days' as long from people where id = ${p.id}`;
  assert.equal(snooze.long, true);
});
