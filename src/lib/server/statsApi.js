// The access rules for the stats page, kept separate from the route so they
// can be tested without Next.js.
import { getStats } from './stats.js';
import { ipHash, safeEqual } from './secrets.js';
import { over, allow } from './rateLimit.js';

/** Returns { status, body } for a request to /api/stats. */
export async function handleStatsRequest(request) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return { status: 503, body: { ok: false, error: 'not_configured' } };
  try {
    const key = `statsfail:${ipHash(request)}`;
    // Ten wrong guesses an hour from one address and it stops answering, even to the right secret.
    if (await over(key, 10, 3600)) return { status: 429, body: { ok: false, error: 'rate_limited' } };
    const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!safeEqual(given, secret)) {
      await allow(key, 10, 3600);
      return { status: 401, body: { ok: false, error: 'unauthorized' } };
    }
    return { status: 200, body: { ok: true, ...(await getStats()) } };
  } catch (error) {
    console.error('[api] stats', error);
    return { status: 500, body: { ok: false, error: 'server' } };
  }
}
