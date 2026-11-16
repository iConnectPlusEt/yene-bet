import { after } from 'next/server';
import { listPosts, createPost, deletePost, refinePostTags } from '../../../lib/server/wall.js';
import { withPerson, json, reply } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const GET = (request) =>
  withPerson(request, async (person) => json({ ok: true, posts: await listPosts(person) }));

export const POST = (request) =>
  withPerson(request, async (person, body) => {
    const result = await createPost(person, body.body);
    if (!result.ok) return reply(result);
    if (result.needsTagging) after(() => refinePostTags(result.post.id).catch((e) => console.error('[tags]', e)));
    return json({ ok: true, id: result.post.id });
  });

export const DELETE = (request) =>
  withPerson(request, async (person) => {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: 'not_found' }, 404);
    return reply(await deletePost(person, id));
  });
