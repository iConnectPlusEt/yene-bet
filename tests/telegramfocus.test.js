import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import { startVent } from '../src/lib/server/chat.js';
import { createPost } from '../src/lib/server/wall.js';
import { nudgeDormant } from '../src/lib/server/nudge.js';
import { handleUpdate } from '../src/lib/server/bot.js';
import { getStats } from '../src/lib/server/stats.js';

let telegram;
let updateId = 40000;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); delete process.env.STATS_TZ; });
after(async () => { delete process.env.STATS_TZ; await telegram.close(); await closeDb(); });

const text = (id, body) => handleUpdate({ update_id: updateId++, message: { message_id: 1, chat: { id, type: 'private' }, text: body } });
const tap = (id, data) => handleUpdate({ update_id: updateId++, callback_query: { id: String(updateId), data, from: { id }, message: { message_id: 1, chat: { id, type: 'private' } } } });
const last = (id) => telegram.to(id).filter((s) => s.method === 'sendMessage').at(-1);

// A time zone where it is currently `hour` o'clock, so the quiet-hours rule can be tested at any time of day.
function zoneWhereHourIs(hour) {
  const utc = new Date().getUTCHours();
  let d = (hour - utc + 24) % 24;
  if (d > 14) d -= 24;
  return d === 0 ? 'Etc/GMT' : d > 0 ? `Etc/GMT-${d}` : `Etc/GMT+${-d}`;
}

test('the first menu says how it works in three lines, once', async () => {
  await tgPerson(9401);
  await text(9401, '/start');
  assert.match(last(9401).text, /How it works:/);
  assert.match(last(9401).text, /Need to talk\?/);
  assert.deepEqual(last(9401).buttons, ['vent', 'listen']);
  await text(9401, '/start');
  assert.equal(/How it works:/.test(last(9401).text), false, 'only the first time');
});

test('/stories shows one story at a time, never your own, and "I have been there" tells the author', async () => {
  const author = await tgPerson(9411);
  const reader = await tgPerson(9412);
  const writer = await webPerson();
  await createPost(author, 'I lost my father two years ago and I still cannot sleep.');
  await createPost(writer, 'I moved abroad alone and I miss my mother every day.');

  // Your own story is never shown to you.
  await text(9411, '/stories');
  assert.match(last(9411).text, /I moved abroad alone/);
  assert.equal(/I lost my father/.test(last(9411).text), false);

  await text(9412, '/stories');
  const first = last(9412);
  assert.ok(first.buttons.some((b) => b.startsWith('story:been:')));
  assert.ok(first.buttons.some((b) => b.startsWith('story:next:')));
  const been = first.buttons.find((b) => b.startsWith('story:been:'));
  telegram.clear();
  await tap(9412, been);
  assert.ok(telegram.to(9412).some((s) => /told them you have been there/.test(s.text || '')));
  if (/lost my father/.test(first.text)) {
    assert.ok(telegram.to(9411).some((s) => /has been there too/.test(s.text || '')), 'the author is told');
  }
  // Next moves on and stops when there is nothing more.
  await tap(9412, 'story:next:' + been.slice('story:been:'.length));
  assert.ok(last(9412).text.length > 0);
});

test('a person waiting on Telegram can read stories from the status message', async () => {
  const author = await webPerson();
  await createPost(author, 'Exams are next week and I cannot focus on anything.');
  const waiting = await tgPerson(9421);
  for (let i = 0; i < 3; i++) await tgPerson(9430 + i);
  telegram.clear();
  await startVent(waiting, { text: 'the breakup', topics: [] });
  const status = telegram.to(9421).find((s) => /I have asked/.test(s.text || ''));
  assert.ok(status.buttons.includes('story:next:0'));
  await tap(9421, 'story:next:0');
  assert.match(last(9421).text, /Exams are next week/);
});

test('nudges: two at most, a week apart, only for people who never started, never at night, "not for me" stops them', async () => {
  process.env.STATS_TZ = zoneWhereHourIs(12);
  const dormant = await tgPerson(9441);
  const old = (id) => db()`update people set rules_accepted_at = now() - interval '3 days' where tg_chat_id = ${id}`;
  await old(9441);

  // Not eligible: joined today, already vented, blocked the bot, turned messages off, a test identity.
  const fresh = await tgPerson(9442);
  const vented = await tgPerson(9443); await old(9443);
  await startVent(vented, { text: 'a hard week', topics: [] });
  const blocked = await tgPerson(9444); await old(9444);
  await db()`update people set unreachable_at = now() where id = ${blocked.id}`;
  const quiet = await tgPerson(9445); await old(9445);
  await db()`update people set notify_requests = false where id = ${quiet.id}`;
  const tester = await tgPerson(9446); await old(9446);
  await db()`update people set is_test = true where id = ${tester.id}`;
  telegram.clear();

  assert.equal(await nudgeDormant(), 1);
  const nudge = telegram.to(9441).find((s) => /joined My Home a few days ago/.test(s.text || ''));
  assert.ok(nudge, 'the first nudge');
  assert.deepEqual(nudge.buttons, ['vent', 'listen', 'nudge:stop']);
  for (const id of [9442, 9443, 9444, 9445, 9446]) assert.equal(telegram.to(id).some((s) => /joined My Home a few days ago|quiet reminder/.test(s.text || '')), false, `nobody else: ${id}`);

  assert.equal(await nudgeDormant(), 0, 'a week apart');
  await db()`update people set nudged_at = now() - interval '8 days' where id = ${dormant.id}`;
  assert.equal(await nudgeDormant(), 1);
  assert.ok(telegram.to(9441).some((s) => /quiet reminder/.test(s.text || '')), 'the second nudge is worded differently');
  await db()`update people set nudged_at = now() - interval '8 days' where id = ${dormant.id}`;
  assert.equal(await nudgeDormant(), 0, 'never more than two');

  // "Not for me" stops them for good.
  const other = await tgPerson(9447); await old(9447);
  assert.equal(await nudgeDormant(), 1);
  await tap(9447, 'nudge:stop');
  await db()`update people set nudged_at = now() - interval '8 days' where id = ${other.id}`;
  assert.equal(await nudgeDormant(), 0);

  // Never at night.
  const sleeper = await tgPerson(9448); await old(9448);
  process.env.STATS_TZ = zoneWhereHourIs(23);
  assert.equal(await nudgeDormant(), 0, 'quiet hours');
  process.env.STATS_TZ = zoneWhereHourIs(3);
  assert.equal(await nudgeDormant(), 0, 'quiet hours');
  process.env.STATS_TZ = zoneWhereHourIs(9);
  assert.equal(await nudgeDormant(), 1, 'and fine in the morning');

  const stats = await getStats();
  assert.equal(stats.nudges.stopped, 1);
  assert.ok(stats.nudges.sent >= 4 && stats.nudges.people >= 3, 'nudges are counted, numbers only');
});
