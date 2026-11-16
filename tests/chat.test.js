import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram } from './helpers.js';
import {
  startVent, sendMessage, goAvailable, candidates, getState, endChat, report,
  decideHandoff, respondOffer, sweepAndMatch, cleanup, stopListening,
} from '../src/lib/server/chat.js';
import { runAi } from '../src/lib/server/aiListener.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const bodies = (state) => state.messages.map((m) => `${m.from}:${m.kind === 'help' ? '[help]' : m.body}`);

test('a venter is connected straight to a free web listener', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, ['work']);

  const started = await startVent(venter, { text: 'My boss humiliated me in front of everyone', topics: [] });
  assert.equal(started.ok, true);
  assert.equal(started.needsAi, false);

  const v = await getState(venter);
  assert.equal(v.chat.mode, 'human');
  assert.ok(v.chat.partner);
  const l = await getState(listener);
  assert.equal(l.screen, 'chat');
  assert.equal(l.chat.role, 'listener');
  assert.ok(bodies(l).includes('them:My boss humiliated me in front of everyone'), 'listener sees the opening message');

  await sendMessage(listener, 'That sounds awful. What happened?');
  await sendMessage(venter, 'He read my mistake out loud in the meeting');
  assert.ok(bodies(await getState(venter)).includes('them:That sounds awful. What happened?'));
  assert.ok(bodies(await getState(listener)).includes('them:He read my mistake out loud in the meeting'));
});

test('the listener who shares a topic wins; with no shared topic the longest waiting wins', async () => {
  const early = await webPerson();
  const relatable = await webPerson();
  await goAvailable(early, ['money']);
  await goAvailable(relatable, ['family', 'grief']);

  const venter = await webPerson();
  const list = await candidates(venter, 'My mother passed away last month', []);
  assert.deepEqual(list.topics.sort(), ['family', 'grief']);
  assert.equal(list.candidates[0].id, relatable.id);
  assert.equal(list.candidates.length, 2, 'a listener with no shared topic is still offered');

  await startVent(venter, { text: 'My mother passed away last month', topics: [] });
  assert.equal((await getState(relatable)).screen, 'chat');
  assert.equal((await getState(early)).screen, 'listening');

  const other = await webPerson();
  await startVent(other, { text: 'I failed my exam', topics: [] });
  assert.equal((await getState(early)).screen, 'chat', 'no shared topic still matches rather than waiting');
});

test('a venter can choose a specific listener', async () => {
  const a = await webPerson();
  const b = await webPerson();
  await goAvailable(a, ['work']);
  await goAvailable(b, ['school']);
  const venter = await webPerson();
  await startVent(venter, { text: 'Work is crushing me', topics: [], pick: b.id });
  assert.equal((await getState(b)).screen, 'chat');
  assert.equal((await getState(a)).screen, 'listening');
});

test('many venters at once never share a listener', async () => {
  const listeners = [];
  for (let i = 0; i < 5; i++) { const l = await webPerson(); await goAvailable(l, ['work']); listeners.push(l); }
  const venters = [];
  for (let i = 0; i < 12; i++) venters.push(await webPerson());

  const results = await Promise.all(venters.map((v, i) => startVent(v, { text: `work trouble ${i}`, topics: ['work'] })));
  assert.ok(results.every((r) => r.ok));
  const human = await db()`select listener_id from chats where mode = 'human'`;
  assert.equal(human.length, 5, 'every listener is used exactly once');
  assert.equal(new Set(human.map((r) => r.listener_id)).size, 5);
  assert.equal(results.filter((r) => r.needsAi).length, 7, 'the rest start with the AI');
});

test('with nobody free the AI listens, then a real person is offered and joins', async () => {
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'I feel so alone lately', topics: [] });
  assert.equal(started.needsAi, true);
  let v = await getState(venter);
  assert.equal(v.chat.mode, 'ai');
  assert.equal(v.chat.typing, true);

  await runAi(started.chatId);
  v = await getState(venter);
  assert.equal(v.chat.typing, false);
  assert.ok(v.messages.some((m) => m.from === 'ai'));

  const sent = await sendMessage(venter, 'It started when I moved cities');
  assert.equal(sent.needsAi, true);
  await runAi(started.chatId);

  // A listener arrives while the venter is mid-conversation with the AI.
  const listener = await webPerson();
  await goAvailable(listener, ['loneliness']);
  v = await getState(venter);
  assert.equal(v.chat.mode, 'ai', 'the venter is asked first, not switched silently');
  assert.ok(v.chat.offer?.alias);
  assert.equal((await getState(listener)).screen, 'listening');

  const decided = await decideHandoff(venter, true);
  assert.equal(decided.connected, true);
  const l = await getState(listener);
  assert.equal(l.chat.role, 'listener');
  const seen = bodies(l);
  assert.ok(seen.includes('them:I feel so alone lately'), 'listener sees the opening');
  assert.ok(!seen.some((b) => b.includes('moved cities')), 'listener does not see what was said to the AI');
  assert.ok(!l.messages.some((m) => m.from === 'ai'));

  const after = await sendMessage(venter, 'Hi, thank you for being here');
  assert.equal(after.needsAi, false, 'the AI steps back once a person joins');
});

test('a waiting venter who has not talked to the AI yet is connected without being asked', async () => {
  const venter = await webPerson();
  await startVent(venter, { text: 'Money is so tight', topics: [] });
  const listener = await webPerson();
  await goAvailable(listener, []);
  assert.equal((await getState(venter)).chat.mode, 'human');
});

test('declining the handoff keeps the AI and frees the listener for others', async () => {
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'School is too much', topics: [] });
  await runAi(started.chatId);
  await sendMessage(venter, 'I have three exams this week');
  const listener = await webPerson();
  await goAvailable(listener, []);
  assert.ok((await getState(venter)).chat.offer);

  await decideHandoff(venter, false);
  assert.equal((await getState(venter)).chat.offer, null);
  await sweepAndMatch({ force: true });
  assert.equal((await getState(venter)).chat.offer, null, 'not offered again');

  const second = await webPerson();
  await startVent(second, { text: 'My partner left', topics: [] });
  assert.equal((await getState(listener)).screen, 'chat', 'the listener is free for the next venter');
});

test('web venter and Telegram listener: offer, accept, relay both ways', async () => {
  const listener = await tgPerson(7001);
  await goAvailable(listener, ['family']);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My dad and I keep fighting', topics: [] });
  assert.equal(started.needsAi, true, 'the AI covers the wait for the Telegram listener to accept');

  const offer = telegram.to(7001).find((s) => s.buttons.includes('offer:yes'));
  assert.ok(offer, 'the Telegram listener is asked to accept');
  assert.match(offer.text, /Family/);

  const accepted = await respondOffer(listener, true);
  assert.equal(accepted.connected, true);
  assert.ok(telegram.to(7001).some((s) => s.text === 'My dad and I keep fighting'), 'opening is relayed to Telegram');

  await sendMessage(venter, 'It was about money again');
  assert.ok(telegram.to(7001).some((s) => s.text === 'It was about money again'));
  await sendMessage(listener, 'That sounds exhausting');
  assert.ok(bodies(await getState(venter)).includes('them:That sounds exhausting'));
  assert.ok(!telegram.sent.some((s) => String(s.text).includes('7001')), 'no Telegram id leaks into any message');
});

test('a Telegram listener who does not answer in time is dropped and the next one is asked', async () => {
  const slow = await tgPerson(7101);
  await goAvailable(slow, ['work']);
  const venter = await webPerson();
  await startVent(venter, { text: 'Work stress', topics: ['work'] });
  await db()`update listeners set status_at = now() - interval '30 seconds' where person_id = ${slow.id}`;

  const next = await tgPerson(7102);
  await goAvailable(next, []);
  assert.equal((await db()`select 1 from listeners where person_id = ${slow.id}`).length, 0);
  assert.ok(telegram.to(7101).some((s) => /missed a request/.test(s.text)));
  assert.ok(telegram.to(7102).some((s) => s.buttons.includes('offer:yes')));
});

test('skipping an offer does not offer the same chat again', async () => {
  const listener = await tgPerson(7201);
  await goAvailable(listener, []);
  const venter = await webPerson();
  await startVent(venter, { text: 'Just a bad day', topics: [] });
  await respondOffer(listener, false);
  await sweepAndMatch({ force: true });
  assert.equal(telegram.to(7201).filter((s) => s.buttons.includes('offer:yes')).length, 1);
});

test('crisis wording shows the help card to the writer and a note to the listener', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await webPerson();
  await startVent(venter, { text: 'Everything is falling apart', topics: [] });
  await sendMessage(venter, 'Honestly I want to kill myself');
  const v = await getState(venter);
  assert.ok(v.messages.some((m) => m.kind === 'help'));
  const l = await getState(listener);
  assert.ok(!l.messages.some((m) => m.kind === 'help'));
  assert.ok(l.messages.some((m) => m.from === 'system' && /may be in danger/.test(m.body)));
});

test('contact details need a second confirmation before they are sent', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await webPerson();
  await startVent(venter, { text: 'Rough week', topics: [] });
  const first = await sendMessage(venter, 'call me on 0911 234 567');
  assert.equal(first.ok, false);
  assert.equal(first.warn, 'contact');
  assert.ok(!bodies(await getState(listener)).some((b) => b.includes('0911')));
  const second = await sendMessage(venter, 'call me on 0911 234 567', { confirm: true });
  assert.equal(second.ok, true);
});

test('ending a chat closes it for both and returns them to the start', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'Long day', topics: [] });
  await endChat(venter);
  const l = await getState(listener, { chatId: started.chatId });
  assert.equal(l.chat.status, 'ended');
  assert.ok(l.messages.some((m) => /other person ended/.test(m.body)));
  assert.equal((await getState(listener)).screen, 'home');
  assert.equal((await sendMessage(venter, 'hello?')).error, 'no_chat');
});

test('a report ends the chat, blocks the pair, and three reporters suspend the person', async () => {
  const bad = await webPerson();
  for (let i = 0; i < 3; i++) {
    await goAvailable(bad, []);
    const venter = await webPerson();
    await startVent(venter, { text: `need to talk ${i}`, topics: [] });
    assert.equal((await getState(bad)).screen, 'chat');
    await report(venter, 'abusive');
    assert.equal((await getState(venter)).screen, 'home');
    if (i === 0) {
      // The same pair is never matched again.
      await goAvailable(bad, []);
      await startVent(venter, { text: 'trying again', topics: [] });
      assert.equal((await getState(venter)).chat.mode, 'ai');
      await endChat(venter);
      await stopListening(bad);
    }
  }
  const [row] = await db()`select suspended_at from people where id = ${bad.id}`;
  assert.ok(row.suspended_at);
  const [fresh] = await db()`select * from people where id = ${bad.id}`;
  assert.equal((await goAvailable(fresh, [])).error, 'suspended');
});

test('a web listener who closes the page drops out of the pool', async () => {
  const listener = await webPerson();
  await goAvailable(listener, []);
  await db()`update listeners set expires_at = now() - interval '1 second'`; // no heartbeat for longer than the allowed gap
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'Anyone there?', topics: [] });
  assert.equal(started.needsAi, true);
});

test('silent chats are closed and old chats are deleted, except reported ones', async () => {
  const venter = await webPerson();
  const a = await startVent(venter, { text: 'first', topics: [] });
  await db()`update chats set last_message_at = now() - interval '31 minutes' where id = ${a.chatId}`;
  await sweepAndMatch({ force: true });
  assert.equal((await getState(venter)).screen, 'home');

  const b = await startVent(venter, { text: 'second', topics: [] });
  await report(venter, 'testing');
  await db()`update chats set ended_at = now() - interval '31 days'`;
  const result = await cleanup();
  assert.equal(result.deletedChats, 1);
  const left = await db()`select id from chats`;
  assert.deepEqual(left.map((r) => r.id), [b.chatId]);
  assert.equal((await db()`select 1 from messages where chat_id = ${a.chatId}`).length, 0);
});

test('message limits: empty and oversized messages are refused', async () => {
  const venter = await webPerson();
  assert.equal((await startVent(venter, { text: '   ', topics: [] })).error, 'empty');
  await startVent(venter, { text: 'ok', topics: [] });
  assert.equal((await sendMessage(venter, 'x'.repeat(2001))).error, 'too_long');
});
