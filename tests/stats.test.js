import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, endBoth } from './helpers.js';
import { getStats, recordDaily } from '../src/lib/server/stats.js';
import { startVent, goAvailable, sendMessage, endChat } from '../src/lib/server/chat.js';
import { giveFeedback } from '../src/lib/server/feedback.js';
import { createPost } from '../src/lib/server/wall.js';
import { handleStatsRequest } from '../src/lib/server/statsApi.js';

beforeEach(async () => { await resetDb(); process.env.ADMIN_SECRET = 'test-secret-value'; });
after(closeDb);

const request = (token) => new Request('http://localhost/api/stats', {
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': '203.0.113.9' },
});

test('counts people, conversations, waiting time and ratings; test identities are left out', async () => {
  const real1 = await webPerson();
  const real2 = await webPerson();
  const listener = await webPerson();
  const tg = await tgPerson(8001);
  await db()`insert into people (channel, token_hash, poke_key) values ('web', 'visitor-one', 'k1')`;   // only looked

  // One conversation that reached a person after a wait, one that never did.
  const first = await startVent(real1, { text: 'My boss was unfair', topics: [] });
  await goAvailable(listener, []);
  await sendMessage(real1, 'Thank you for being here');
  await endBoth(real1);
  await db()`update chats set connected_at = created_at + interval '40 seconds' where id = ${first.chatId}`;
  await giveFeedback(real1, { heard: 2, note: '' });
  await startVent(real2, { text: 'Nobody was around', topics: [] });
  await createPost(real2, 'I am sharing something hard.');

  // A test identity with its own conversation must not appear anywhere.
  const test = await webPerson();
  await db()`update people set is_test = true where id = ${test.id}`;
  await startVent(test, { text: 'live check', topics: [] });

  const s = await getStats();
  assert.equal(s.people.total, 5, 'real1, real2, listener, telegram, and the one who only looked');
  assert.equal(s.people.gotIn, 4);
  assert.equal(s.people.openedOnly, 1);
  assert.equal(s.people.telegram, 1);
  assert.equal(s.people.web, 4);
  assert.equal(s.people.active24h, 4, 'only people who joined count as active');
  assert.equal(s.people.testExcluded, 1);

  assert.equal(s.conversations.total, 2);
  assert.equal(s.conversations.answered, 1);
  assert.equal(s.conversations.answerRate, 0.5);
  assert.equal(s.conversations.peopleWhoVented, 2);
  assert.equal(s.conversations.peopleWhoListened, 1);
  assert.equal(s.conversations.waitsMeasured, 1);
  assert.equal(s.conversations.waitMedianSecs, 40);
  assert.equal(s.conversations.connectedWithin60s, 1);

  assert.equal(s.supply.waitingNow, 1, 'the second vent is still waiting');
  assert.equal(s.quality.ratings, 1);
  assert.equal(s.quality.yes, 1);
  assert.equal(s.wall.posts, 1);
  assert.equal(s.reach.reachable, 1);

  assert.equal(s.series.length, 14);
  const today = s.series.at(-1);
  assert.equal(today.conversations, 2);
  assert.equal(today.answered, 1);
  assert.equal(today.newGotIn, 4);
});

test('waiting time is only measured where a person joined, and direct chats do not count', async () => {
  const venter = await webPerson();
  await startVent(venter, { text: 'Anyone?', topics: [] });
  const s = await getStats();
  assert.equal(s.conversations.waitsMeasured, 0);
  assert.equal(s.conversations.waitMedianSecs, null);
  assert.equal(s.conversations.connectedWithin60s, null);
});

test('the output holds numbers only: no message text, no aliases, no identifiers', async () => {
  const venter = await webPerson();
  const listener = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'A very private sentence about my family', topics: [] });
  await sendMessage(venter, 'Another private line');
  const text = JSON.stringify(await getStats());
  for (const secret of ['private', 'family', venter.id, listener.id, venter.poke_key]) {
    assert.equal(text.includes(secret), false, `"${secret}" must not appear`);
  }
  const [chat] = await db()`select venter_alias, listener_alias from chats`;
  assert.equal(text.includes(chat.venter_alias), false);
});

test('today\'s figures are recorded once a day and shown in the series', async () => {
  const a = await webPerson();
  await recordDaily();
  await recordDaily();
  assert.equal((await db()`select count(*)::int as n from daily_stats`)[0].n, 1, 'one row per day');
  const s = await getStats();
  assert.equal(s.series.at(-1).active, 1);
  assert.equal(s.series[0].active, null, 'no record for earlier days');
  await db()`update people set last_seen_at = now() - interval '2 days' where id = ${a.id}`;
  await recordDaily();
  assert.equal((await getStats()).series.at(-1).active, 0, 'the latest value of the day wins');
});

test('the stats API needs the secret, and stops answering after ten wrong guesses', async () => {
  await webPerson();
  assert.equal((await handleStatsRequest(request())).status, 401);
  assert.equal((await handleStatsRequest(request('wrong'))).status, 401);
  const ok = await handleStatsRequest(request('test-secret-value'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.people.total, 1);

  for (let i = 0; i < 12; i++) await handleStatsRequest(request(`guess-${i}`));
  assert.equal((await handleStatsRequest(request('test-secret-value'))).status, 429, 'locked out, even with the right secret');

  delete process.env.ADMIN_SECRET;
  assert.equal((await handleStatsRequest(request('anything'))).status, 503);
});

test('drop-off funnel, request waves and Telegram-vs-website are counted per channel, tests excluded', async () => {
  // Telegram: 4 people. One only opened, one agreed, one vented, one vented and talked.
  const tgOpen = await tgPerson(8101);
  await db()`update people set rules_accepted_at = null where id = ${tgOpen.id}`;
  const tgAgreed = await tgPerson(8102);
  const tgVent = await tgPerson(8103);
  const tgTalk = await tgPerson(8104);
  // Website: a listener who talks to the Telegram venter.
  const listener = await webPerson();
  await db()`update people set prefs_seen_at = now() where id = ${tgAgreed.id}`;

  await startVent(tgVent, { text: 'Nobody is free tonight', topics: [] });           // waits, never answered
  await goAvailable(listener, []);
  await startVent(tgTalk, { text: 'Please listen to me', topics: [] });
  // The listener joined the oldest waiting vent: that is the answered conversation.
  await db()`update chats set connected_at = created_at + interval '30 seconds' where listener_id is not null`;

  // Request waves: the vents above sent real requests; start from a clean slate and seed exactly three.
  await db()`delete from pings`;
  const [oldChat] = await db()`select id from chats limit 1`;
  const ping = (who, wave, answered, secs) => db()`
    insert into pings (person_id, chat_id, wave, channel, answered, answered_at, created_at)
    values (${who.id}, ${oldChat.id}, ${wave}, 'telegram', ${answered},
            ${answered ? db()`now() + make_interval(secs => ${secs})` : null}, now())`;
  await ping(tgAgreed, 1, true, 12);
  await ping(tgOpen, 1, false, 0);
  await ping(tgVent, 2, false, 0);

  // A test identity must not change anything.
  await db()`insert into people (channel, token_hash, poke_key, is_test, rules_accepted_at) values ('web', 'tester', 'kt', true, now())`;

  const s = await getStats();
  assert.deepEqual(s.funnel.telegram, { opened: 4, agreed: 3, preferences: 1, vented: 2, listened: 0, talked: 1 });
  assert.equal(s.funnel.web.opened, 1, 'the test identity is not counted');
  assert.equal(s.funnel.web.listened, 1, 'the web listener who got a conversation');
  assert.equal(s.funnel.web.talked, 1);

  const w1 = s.waves.find((w) => w.wave === 1 && w.channel === 'telegram');
  assert.equal(w1.sent, 2);
  assert.equal(w1.answered, 1);
  assert.equal(w1.ignored, 1, 'one request nobody answered');
  assert.equal(w1.notNow + w1.week + w1.stop, 0);
  assert.deepEqual(s.nudges, { sent: 0, people: 0, started: 0, stopped: 0 });
  assert.equal(w1.medianSecs, 12);
  assert.equal(s.waves.find((w) => w.wave === 2).sent, 1);

  assert.equal(s.channels.telegram.conversations, 2);
  assert.equal(s.channels.telegram.answered, 1);
  assert.equal(s.channels.telegram.waitMedianSecs, 30);
  assert.equal(s.channels.web, undefined, 'no conversation was started from the website');

  // Numbers only: no text, aliases or ids leak into the new sections.
  const text = JSON.stringify({ f: s.funnel, w: s.waves, c: s.channels });
  for (const secret of ['Nobody is free tonight', 'Please listen to me', tgVent.id, listener.id]) {
    assert.equal(text.includes(secret), false);
  }
});
