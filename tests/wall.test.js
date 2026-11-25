import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson, tgPerson, fakeTelegram, endBoth } from './helpers.js';
import { createPost, listPosts, relate, reportPost, deletePost, expirePosts } from '../src/lib/server/wall.js';
import {
  inviteRelater, respondInvite, pendingInvites, wantAgain, listConnections, inviteConnection, keepState,
} from '../src/lib/server/invites.js';
import { startVent, goAvailable, getState, endChat, sendMessage, report } from '../src/lib/server/chat.js';
import { saveProfile } from '../src/lib/server/profiles.js';
import { handleUpdate } from '../src/lib/server/bot.js';

let telegram;
before(async () => { telegram = await fakeTelegram(); });
beforeEach(async () => { await resetDb(); telegram.clear(); });
after(async () => { await telegram.close(); await closeDb(); });

const bodies = (state) => state.messages.map((m) => `${m.from}:${m.body}`);

test('posting: anonymous, tagged, and guarded', async () => {
  const author = await webPerson();
  assert.equal((await createPost(author, '   ')).error, 'empty');
  assert.equal((await createPost(author, 'reach me at someone@example.com')).error, 'contact');
  assert.equal((await createPost(author, 'I want to kill myself')).error, 'crisis');
  const made = await createPost(author, 'My father died in spring and I still set a place for him.');
  assert.equal(made.ok, true);
  assert.deepEqual(made.post.experiences, ['lost_parent']);

  const reader = await webPerson();
  const [post] = await listPosts(reader);
  assert.equal(post.mine, false);
  assert.ok(post.alias);
  assert.equal(JSON.stringify(post).includes(author.id), false, 'the author is not identifiable');
  for (let i = 0; i < 4; i++) await createPost(author, `another thought ${i}`);
  assert.equal((await createPost(author, 'one too many')).error, 'rate_limited');
});

test('"I have been there" leads to an invitation and a conversation', async () => {
  const author = await webPerson();
  const { post } = await createPost(author, 'My father died in spring and I still set a place for him.');
  const reader = await webPerson();
  await saveProfile(reader, { story: 'I lost my dad two years ago.' });
  assert.equal((await listPosts(reader))[0].shared, true, 'posts about your own experience are marked');

  assert.equal((await relate(author, post.id)).error, 'own_post');
  assert.equal((await relate(reader, post.id)).ok, true);
  assert.equal((await relate(reader, post.id)).already, true);

  const mine = (await listPosts(author))[0];
  assert.equal(mine.relateCount, 1);
  assert.equal(mine.relaters.length, 1);
  const stranger = await webPerson();
  assert.equal((await inviteRelater(stranger, mine.relaters[0].id)).error, 'not_found', 'only the author can invite');

  assert.equal((await inviteRelater(author, mine.relaters[0].id)).ok, true);
  assert.equal((await inviteRelater(author, mine.relaters[0].id)).already, true);
  assert.equal((await listPosts(author))[0].relaters[0].invited, true);

  const [invite] = await pendingInvites(reader.id);
  assert.equal(invite.kind, 'post');
  assert.match(invite.text, /set a place for him/);
  const answered = await respondInvite(reader, invite.id, true);
  assert.equal(answered.connected, true);

  const a = await getState(author);
  const r = await getState(reader);
  assert.equal(a.chat.role, 'venter');
  assert.equal(r.chat.role, 'listener');
  assert.ok(bodies(r).includes('them:My father died in spring and I still set a place for him.'));
  await sendMessage(reader, 'I did the same for a year.');
  assert.ok(bodies(await getState(author)).includes('them:I did the same for a year.'));
  assert.equal((await pendingInvites(reader.id)).length, 0);
});

test('an invitation stays open while someone is busy, and can be declined', async () => {
  const author = await webPerson();
  const { post } = await createPost(author, 'Work has swallowed my whole life.');
  const reader = await webPerson();
  await relate(reader, post.id);
  await inviteRelater(author, (await listPosts(author))[0].relaters[0].id);
  await startVent(author, { text: 'in another conversation', topics: [] });
  const [invite] = await pendingInvites(reader.id);
  assert.equal((await respondInvite(reader, invite.id, true)).error, 'busy');
  assert.equal((await pendingInvites(reader.id)).length, 1);
  assert.equal((await respondInvite(reader, invite.id, false)).ok, true);
  assert.equal((await pendingInvites(reader.id)).length, 0);
});

test('reported posts disappear: for the reporter at once, for everyone after two reports', async () => {
  const author = await webPerson();
  const { post } = await createPost(author, 'Something that should not be here.');
  const [a, b, c] = [await webPerson(), await webPerson(), await webPerson()];
  await reportPost(a, post.id);
  assert.equal((await listPosts(a)).length, 0);
  assert.equal((await listPosts(c)).length, 1);
  await reportPost(a, post.id);
  assert.equal((await listPosts(c)).length, 1, 'one person cannot hide a post alone');
  await reportPost(b, post.id);
  assert.equal((await listPosts(c)).length, 0);
  assert.equal((await relate(c, post.id)).error, 'not_found');
});

test('posts expire after a week and authors can delete their own', async () => {
  const author = await webPerson();
  const { post: old } = await createPost(author, 'An old thought.');
  const { post: fresh } = await createPost(author, 'A new thought.');
  await db()`update posts set created_at = now() - interval '8 days' where id = ${old.id}`;
  const reader = await webPerson();
  assert.deepEqual((await listPosts(reader)).map((p) => p.id), [fresh.id]);
  assert.equal(await expirePosts(), 1);
  await deletePost(reader, fresh.id);
  assert.equal((await listPosts(reader)).length, 1, 'only the author can delete');
  await deletePost(author, fresh.id);
  assert.equal((await listPosts(reader)).length, 0);
});

test('talk again needs both people; then either can invite the other', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  const started = await startVent(venter, { text: 'Hard week', topics: [] });
  await endBoth(venter);

  assert.deepEqual(await keepState(venter.id, started.chatId), { canKeep: true, kept: false, mutual: false });
  assert.equal((await wantAgain(venter)).mutual, false);
  assert.equal((await listConnections(venter.id)).length, 0, 'one-sided is not a connection');
  assert.equal((await keepState(venter.id, started.chatId)).kept, true);
  assert.equal((await wantAgain(listener)).mutual, true);

  const [forVenter] = await listConnections(venter.id);
  const [forListener] = await listConnections(listener.id);
  assert.ok(forVenter.alias && forListener.alias);
  assert.notEqual(forVenter.alias, forListener.alias);

  assert.equal((await inviteConnection(listener, forListener.id, 'call 0911 234 567')).error, 'contact');
  assert.equal((await inviteConnection(listener, forListener.id, 'It is my turn tonight. Are you around?')).ok, true);
  const [invite] = await pendingInvites(venter.id);
  assert.equal(invite.kind, 'again');
  assert.equal(invite.from, forVenter.alias, 'the invitation uses the name they already know');
  assert.equal((await respondInvite(venter, invite.id, true)).connected, true);
  assert.equal((await getState(listener)).chat.role, 'venter', 'whoever invites is the one who talks');
  assert.equal((await getState(venter)).chat.role, 'listener');
});

test('a reported conversation can never become a connection', async () => {
  const listener = await webPerson();
  const venter = await webPerson();
  await goAvailable(listener, []);
  await startVent(venter, { text: 'Hard week', topics: [] });
  await report(venter, 'abusive');
  assert.equal((await wantAgain(listener)).error, 'no_chat');
});

test('Telegram: share, be told someone related, invite, talk, talk again', async () => {
  let n = 1;
  const send = (id, body) => handleUpdate({ update_id: n++, message: { message_id: n, chat: { id, type: 'private' }, text: body } });
  const tap = (id, data) => handleUpdate({ update_id: n++, callback_query: { id: String(n), data, from: { id }, message: { message_id: 1, chat: { id, type: 'private' } } } });
  const last = (id) => telegram.to(id).filter((s) => s.method === 'sendMessage').at(-1);

  for (const id of [5001, 5002]) { await send(id, '/start'); await tap(id, 'rules:ok'); }
  await send(5001, '/share');
  await send(5001, 'I failed my exam and cannot tell my parents.');
  const reader = await tgPerson(5002);
  const [post] = await listPosts(reader);
  await relate(reader, post.id);
  const told = last(5001);
  assert.match(told.text, /has been there too/);
  await tap(5001, told.buttons[0]);
  const invitation = last(5002);
  assert.match(invitation.text, /would like to talk with you/);
  await tap(5002, invitation.buttons[0]);
  assert.ok(telegram.to(5002).some((s) => s.text === 'I failed my exam and cannot tell my parents.'));
  await send(5002, 'I failed mine twice. You will get through this.');
  assert.equal(last(5001).text, 'I failed mine twice. You will get through this.');

  await send(5001, '/end');
  await tap(5002, 'end:yes');
  await tap(5001, 'again:yes');
  await tap(5002, 'again:yes');
  assert.match(last(5002).text, /They said the same/);
  await send(5002, '/people');
  const people = last(5002);
  assert.equal(people.buttons.length, 1);
  await tap(5002, people.buttons[0]);
  await send(5002, 'Rough night. Are you around?');
  assert.match(last(5001).text, /would like to talk again/);
});
