import { getState } from '../../../lib/server/chat.js';
import { withPerson, json } from '../../../lib/server/api.js';
import { localHelpline } from '../../../lib/strings.js';
import { botUsername } from '../../../lib/server/telegramApi.js';

export const dynamic = 'force-dynamic';

// The browser calls this every second or two (and whenever it is poked) to
// learn what to show. It also keeps a waiting listener marked as available.
export const GET = (request) =>
  withPerson(request, async (person) => {
    const params = new URL(request.url).searchParams;
    const chatId = params.get('chat');
    const state = await getState(person, {
      after: Number(params.get('after')) || 0,
      chatId: /^[0-9a-f-]{36}$/i.test(chatId || '') ? chatId : null,
    });
    return json({ ok: true, pokeKey: person.poke_key, helpline: localHelpline(), bot: botUsername(), ...state });
  });
