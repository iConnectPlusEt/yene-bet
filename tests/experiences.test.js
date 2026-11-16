import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb, resetDb, webPerson } from './helpers.js';
import { startVent, goAvailable, candidates, getState, sweepAndMatch, MATCH_WINDOW_SECS } from '../src/lib/server/chat.js';
import { saveProfile, getProfile } from '../src/lib/server/profiles.js';
import { detectExperiences, detectLanguage, topicsOfExperiences } from '../src/lib/experiences.js';
import { parseTags, mergeTags, quickTags } from '../src/lib/server/tagging.js';

beforeEach(resetDb);
after(closeDb);

async function listenerWith(story, topics = []) {
  const person = await webPerson();
  await saveProfile(person, { story, topics });
  await goAvailable(person);
  return person;
}

test('word matching finds specific experiences and the language', () => {
  assert.deepEqual(detectExperiences('My father passed away in March and I cannot sleep'), ['lost_parent', 'sleep']);
  assert.deepEqual(detectExperiences('I was laid off last week'), ['job_loss']);
  assert.deepEqual(detectExperiences('nice weather today'), []);
  assert.deepEqual(topicsOfExperiences(['lost_parent', 'sleep']).sort(), ['grief', 'health']);
  assert.equal(detectLanguage('I feel alone'), 'en');
  assert.equal(detectLanguage('ብቸኝነት ይሰማኛል'), 'am');
});

test('the AI reply is read safely: unknown keys dropped, junk ignored', () => {
  assert.deepEqual(parseTags('Sure! {"experiences": ["lost_parent", "made_up", "sleep"], "language": "EN"}'),
    { experiences: ['lost_parent', 'sleep'], language: 'en' });
  assert.equal(parseTags('no json here'), null);
  assert.equal(parseTags('{"experiences": '), null);
  assert.deepEqual(mergeTags(quickTags('I was fired'), { experiences: ['burnout'], language: null }),
    { experiences: ['burnout', 'job_loss'], language: 'en' });
  assert.deepEqual(mergeTags(quickTags('I was fired'), null), { experiences: ['job_loss'], language: 'en' });
});

test('a listener profile is saved once and reused', async () => {
  const person = await webPerson();
  await saveProfile(person, { story: 'I lost my mother three years ago.', topics: ['work'] });
  await goAvailable(person);
  let state = await getState(person);
  assert.deepEqual(state.listening.experiences, ['lost_parent']);
  assert.deepEqual(state.listening.topics.sort(), ['grief', 'work']);

  // Changing only the topics keeps the story and its experiences.
  await saveProfile(person, { topics: ['money'] });
  const profile = await getProfile(person.id);
  assert.equal(profile.story, 'I lost my mother three years ago.');
  assert.deepEqual(profile.experiences, ['lost_parent']);
  assert.deepEqual(profile.topics, ['money']);
});

test('the same experience beats the same topic, which beats waiting longest', async () => {
  const waitedLongest = await listenerWith('', []);
  const sameTopic = await listenerWith('My brother and I have not spoken in a year.', ['grief']);
  const sameExperience = await listenerWith('My dad died when I was nineteen.');

  const venter = await webPerson();
  const text = 'My father died last month and I do not know how to keep going';
  const list = await candidates(venter, text, []);
  assert.deepEqual(list.candidates.map((c) => c.id), [sameExperience.id, sameTopic.id, waitedLongest.id]);
  assert.deepEqual(list.candidates[0].sharedExperiences, ['lost_parent']);

  await startVent(venter, { text, topics: [] });
  assert.equal((await getState(sameExperience)).screen, 'chat');
  assert.equal((await getState(sameTopic)).screen, 'listening');
});

test('same language is preferred when nothing else separates two listeners', async () => {
  const english = await listenerWith('Work has been hard.');
  const amharic = await listenerWith('ሥራዬ በጣም ከባድ ነበር።');
  const venter = await webPerson();
  const list = await candidates(venter, 'ዛሬ በጣም ከፍቶኛል', []);
  assert.equal(list.candidates[0].id, amharic.id);
  assert.equal(list.candidates[1].id, english.id);
});

test('with no close match and nothing to wait for, anyone free is taken at once', async () => {
  const listener = await listenerWith('I went through a divorce.');
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'I failed my exam and my parents are furious', topics: [] });
  assert.equal(started.needsAi, false, 'speed first: no pointless wait');
  assert.equal((await getState(listener)).screen, 'chat');
});

test('during the match window only a shared experience connects; after it anyone does', async () => {
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My father died last month', topics: [] });
  assert.equal(started.needsAi, true);
  // Simulate the window being open (as it is while the AI is still reading the message).
  await db()`update chats set match_until = now() + make_interval(secs => ${MATCH_WINDOW_SECS}) where id = ${started.chatId}`;
  assert.equal((await getState(venter)).chat.searching, true);

  const unrelated = await listenerWith('I was laid off and could not find work.');
  assert.equal((await getState(unrelated)).screen, 'listening', 'held back while a closer match may still appear');

  const close = await listenerWith('I lost my dad too.');
  assert.equal((await getState(close)).screen, 'chat', 'the close match is taken immediately');
  assert.equal((await getState(unrelated)).screen, 'listening');

  // A second venter whose window has passed gets whoever is free.
  const other = await webPerson();
  const second = await startVent(other, { text: 'My mother passed away', topics: [] });
  assert.equal(second.needsAi, false);
  assert.equal((await getState(unrelated)).screen, 'chat');
});

test('when the window closes without a close match, the venter is offered whoever is free', async () => {
  const venter = await webPerson();
  const started = await startVent(venter, { text: 'My father died last month', topics: [] });
  await db()`update chats set match_until = now() + interval '20 seconds' where id = ${started.chatId}`;
  const unrelated = await listenerWith('Money has always been tight for me.');
  assert.equal((await getState(venter)).chat.mode, 'ai');
  await db()`update chats set match_until = now() - interval '1 second' where id = ${started.chatId}`;
  await sweepAndMatch({ force: true });
  assert.equal((await getState(venter)).chat.mode, 'human');
  assert.equal((await getState(unrelated)).screen, 'chat');
});
