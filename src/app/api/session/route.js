import { createWebPerson } from '../../../lib/server/identity.js';
import { LIMITS } from '../../../lib/server/rateLimit.js';
import { json, ipHash } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// Creates a new anonymous identity. The token is shown once and kept only in
// the visitor's browser.
export async function POST(request) {
  try {
    if (!(await LIMITS.session(ipHash(request)))) return json({ ok: false, error: 'rate_limited' }, 429);
    const { token, person } = await createWebPerson();
    return json({ ok: true, token, pokeKey: person.poke_key });
  } catch (error) {
    console.error('[api] session', error);
    return json({ ok: false, error: 'server' }, 500);
  }
}
