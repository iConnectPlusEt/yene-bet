import { handleStatsRequest } from '../../../lib/server/statsApi.js';
import { json } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

// Totals about how the app is used. Needs the ADMIN_SECRET as a bearer token.
export async function GET(request) {
  const { status, body } = await handleStatsRequest(request);
  return json(body, status);
}
