// What a listener has been through, saved once and reused each time they
// make themselves available.
import { db } from './db.js';
import { quickTags, aiTags, mergeTags, aiConfigured } from './tagging.js';
import { cleanTopics } from '../topics.js';
import { topicsOfExperiences } from '../experiences.js';

export const MAX_STORY_LENGTH = 600;

export async function getProfile(personId) {
  const [profile] = await db()`select * from listener_profiles where person_id = ${personId}`;
  return profile || null;
}

/**
 * Save a listener's story and topics. Experiences come from word matching
 * straight away; when `needsTagging` is true the caller should run
 * refineProfile in the background for a more careful reading.
 */
export async function saveProfile(person, { story, topics }) {
  const existing = await getProfile(person.id);
  const text = typeof story === 'string' ? story.replace(/\u0000/g, '').trim().slice(0, MAX_STORY_LENGTH) : existing?.story || '';
  const picked = topics === undefined ? existing?.topics || [] : cleanTopics(topics);
  const storyChanged = text !== (existing?.story || '');
  const tags = storyChanged || !existing ? quickTags(text) : { experiences: existing.experiences, language: existing.language };
  const [profile] = await db()`
    insert into listener_profiles (person_id, story, topics, experiences, language)
    values (${person.id}, ${text}, ${picked}, ${tags.experiences}, ${tags.language})
    on conflict (person_id) do update
      set story = excluded.story, topics = excluded.topics, experiences = excluded.experiences,
          language = excluded.language, updated_at = now()
    returning *`;
  return { profile, needsTagging: storyChanged && Boolean(text) && aiConfigured() };
}

/** Re-read the story with the AI and update the profile and any live listing. */
export async function refineProfile(personId) {
  const profile = await getProfile(personId);
  if (!profile?.story) return null;
  const tags = mergeTags(quickTags(profile.story), await aiTags(profile.story));
  const sql = db();
  await sql`update listener_profiles set experiences = ${tags.experiences}, language = ${tags.language} where person_id = ${personId}`;
  await sql`
    update listeners
       set experiences = ${tags.experiences}, language = ${tags.language},
           topics = ${cleanTopics([...profile.topics, ...topicsOfExperiences(tags.experiences)])}
     where person_id = ${personId}`;
  return tags;
}
