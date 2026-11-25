import { sweepAndMatch } from '../../../../lib/server/chat.js';
import { json, isAdmin } from '../../../../lib/server/api.js';
import { recordDaily } from '../../../../lib/server/stats.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Called every minute by netlify/functions/tick.mjs: asks the next people about
// anyone still waiting, hands out expired holds, and closes silent chats.
async function run(request) {
  if (!isAdmin(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  await sweepAndMatch({ force: true });
  await recordDaily().catch((e) => console.error('[stats] daily', e));
  return json({ ok: true });
}

export const GET = run;
export const POST = run;
