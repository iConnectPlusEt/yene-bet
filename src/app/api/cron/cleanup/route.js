import { cleanup, sweepAndMatch } from '../../../../lib/server/chat.js';
import { json, isAdmin } from '../../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// Run on a schedule (hourly is plenty): closes silent chats and deletes
// conversations that ended more than 7 days ago.
async function run(request) {
  if (!isAdmin(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  await sweepAndMatch({ force: true });
  return json({ ok: true, ...(await cleanup()) });
}

export const GET = run;
export const POST = run;
