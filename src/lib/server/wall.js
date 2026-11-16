// The sharing wall: short anonymous posts that others can answer with
// "I have been there".
import { db } from './db.js';
import { LIMITS } from './rateLimit.js';
import { nudge } from './delivery.js';
import { sendText, button } from './telegramApi.js';
import { randomAlias } from '../aliases.js';
import { quickTags, aiTags, mergeTags, aiConfigured } from './tagging.js';
import { looksLikeCrisis, looksLikeContact } from '../safety.js';

export const MAX_POST_LENGTH = 600;
export const POST_DAYS = 7;
export const REPORTS_TO_HIDE = 2;

const fail = (error) => ({ ok: false, error });

export async function createPost(person, rawBody) {
  if (person.suspended_at) return fail('suspended');
  if (!person.rules_accepted_at) return fail('rules');
  const body = typeof rawBody === 'string' ? rawBody.replace(/\u0000/g, '').trim() : '';
  if (!body) return fail('empty');
  if (body.length > MAX_POST_LENGTH) return fail('too_long');
  if (looksLikeContact(body)) return fail('contact');
  // Someone in danger needs a person now, not a public post.
  if (looksLikeCrisis(body)) return fail('crisis');
  if (!(await LIMITS.post(person.id))) return fail('rate_limited');
  const tags = quickTags(body);
  const [post] = await db()`
    insert into posts (author_id, alias, body, experiences, language)
    values (${person.id}, ${randomAlias()}, ${body}, ${tags.experiences}, ${tags.language})
    returning *`;
  return { ok: true, post, needsTagging: aiConfigured() };
}

export async function refinePostTags(postId) {
  const sql = db();
  const [post] = await sql`select * from posts where id = ${postId}`;
  if (!post) return;
  const tags = mergeTags({ experiences: post.experiences, language: post.language }, await aiTags(post.body));
  await sql`update posts set experiences = ${tags.experiences}, language = ${tags.language} where id = ${postId}`;
}

/** Recent posts as this person should see them. */
export async function listPosts(person) {
  const sql = db();
  const posts = await sql`
    select p.*, (select count(*)::int from post_relates r where r.post_id = p.id) as relate_count,
           exists(select 1 from post_relates r where r.post_id = p.id and r.person_id = ${person.id}) as i_related,
           coalesce((select lp.experiences && p.experiences from listener_profiles lp where lp.person_id = ${person.id}), false) as shared
    from posts p
    where not p.hidden
      and p.created_at > now() - make_interval(days => ${POST_DAYS})
      and not exists (select 1 from post_reports x where x.post_id = p.id and x.person_id = ${person.id})
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = ${person.id} and b.blocked_id = p.author_id)
           or (b.blocker_id = p.author_id and b.blocked_id = ${person.id}))
    order by p.created_at desc
    limit 40`;
  const mine = posts.filter((p) => p.author_id === person.id).map((p) => p.id);
  const relaters = mine.length
    ? await sql`
        select r.id, r.post_id, r.alias,
               exists(select 1 from invites i where i.from_id = ${person.id} and i.to_id = r.person_id and i.status = 'pending') as invited
        from post_relates r where r.post_id in ${sql(mine)} order by r.id`
    : [];
  return posts.map((p) => ({
    id: p.id,
    alias: p.alias,
    body: p.body,
    experiences: p.experiences,
    at: p.created_at,
    mine: p.author_id === person.id,
    shared: p.shared,
    relateCount: p.relate_count,
    iRelated: p.i_related,
    relaters: relaters.filter((r) => r.post_id === p.id).map((r) => ({ id: Number(r.id), alias: r.alias, invited: r.invited })),
  }));
}

/** "I have been there." Tells the author, who may then invite this person to talk. */
export async function relate(person, postId) {
  if (person.suspended_at) return fail('suspended');
  const sql = db();
  const [post] = await sql`
    select * from posts where id = ${postId} and not hidden and created_at > now() - make_interval(days => ${POST_DAYS})`;
  if (!post) return fail('not_found');
  if (post.author_id === person.id) return fail('own_post');
  const [row] = await sql`
    insert into post_relates (post_id, person_id, alias) values (${postId}, ${person.id}, ${randomAlias()})
    on conflict (post_id, person_id) do nothing returning *`;
  if (!row) return { ok: true, already: true };
  const [author] = await sql`select * from people where id = ${post.author_id}`;
  if (author?.channel === 'telegram') {
    await sendText(
      author.tg_chat_id,
      `${row.alias} has been there too. They read what you shared: "${post.body.slice(0, 120)}${post.body.length > 120 ? '…' : ''}"`,
      [[button('Invite them to talk', `rel:${row.id}`)]],
    );
  } else {
    await nudge(author);
  }
  return { ok: true };
}

export async function reportPost(person, postId) {
  const sql = db();
  const [post] = await sql`select * from posts where id = ${postId}`;
  if (!post) return fail('not_found');
  await sql`insert into post_reports (post_id, person_id) values (${postId}, ${person.id}) on conflict do nothing`;
  const [{ n }] = await sql`select count(*)::int as n from post_reports where post_id = ${postId}`;
  if (n >= REPORTS_TO_HIDE) await sql`update posts set hidden = true where id = ${postId}`;
  return { ok: true };
}

export async function deletePost(person, postId) {
  await db()`delete from posts where id = ${postId} and author_id = ${person.id}`;
  return { ok: true };
}

/** Remove posts past their week. */
export async function expirePosts() {
  const rows = await db()`delete from posts where created_at < now() - make_interval(days => ${POST_DAYS}) returning id`;
  return rows.length;
}
