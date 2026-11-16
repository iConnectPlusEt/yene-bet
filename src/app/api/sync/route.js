import { getState } from '../../../lib/server/chat.js';
import { withPerson, json } from '../../../lib/server/api.js';
import { localHelpline } from '../../../lib/strings.js';
import { botUsername } from '../../../lib/server/telegramApi.js';
import { pendingInvites, listConnections, keepState } from '../../../lib/server/invites.js';

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
    // Invitations and "talk again" belong to the screens between conversations.
    if (state.screen !== 'chat') {
      state.invites = await pendingInvites(person.id);
      state.connections = await listConnections(person.id);
    } else if (state.chat.status === 'ended' && state.chat.mode === 'human') {
      state.chat.again = await keepState(person.id, state.chat.id);
    }
    return json({ ok: true, pokeKey: person.poke_key, helpline: localHelpline(), bot: botUsername(), ...state });
  });
