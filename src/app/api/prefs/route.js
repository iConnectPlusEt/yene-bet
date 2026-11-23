import { savePrefs, skipPrefs, prefsOf } from '../../../lib/server/preferences.js';
import { withPerson, json } from '../../../lib/server/api.js';

export const dynamic = 'force-dynamic';

export const GET = (request) =>
  withPerson(request, async (person) => json({ ok: true, prefsSeen: Boolean(person.prefs_seen_at), prefs: prefsOf(person) }));

// Save preferences, or { skip: true } to say the screen was seen and nothing was chosen.
export const POST = (request) =>
  withPerson(request, async (person, body) => {
    if (body.skip === true) {
      await skipPrefs(person);
      return json({ ok: true });
    }
    return json({ ok: true, prefs: await savePrefs(person, body) });
  });
