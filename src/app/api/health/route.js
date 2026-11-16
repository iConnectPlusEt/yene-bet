import { db } from '../../../lib/server/db.js';
import { json, isAdmin } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// Is the deployment wired up? Anyone can see yes/no; the reason for a
// database failure is only shown to the operator (CRON_SECRET bearer).
export async function GET(request) {
  const status = {
    ok: true,
    database: false,
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET),
    ai: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    realtime: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
  try {
    await db()`select count(*) from people`;
    status.database = true;
  } catch (error) {
    status.ok = false;
    if (isAdmin(request)) status.databaseError = String(error?.message || error).slice(0, 200);
  }
  return json(status, status.ok ? 200 : 503);
}
