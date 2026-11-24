// Getting things to people, whichever way they are connected. Website users
// are "poked" so their browser refreshes; Telegram users get a bot message.
import { poke } from './realtime.js';
import { sendText, button } from './telegramApi.js';
import { topicLabels } from '../topics.js';
import { AI_NAME, helpText } from '../strings.js';

function telegramText(msg) {
  if (msg.kind === 'help') return helpText();
  if (msg.sender === 'ai') return `${AI_NAME}: ${msg.body}`;
  if (msg.sender === 'system') return `— ${msg.body}`;
  return msg.quote ? `↪ “${msg.quote}”\n${msg.body}` : msg.body;
}

/**
 * Deliver one stored message. `people` is { venter, listener } (listener may
 * be null). The sender is not sent their own message back.
 */
export async function deliverMessage(msg, people) {
  const pokes = [];
  const sends = [];
  for (const role of ['venter', 'listener']) {
    const person = people[role];
    if (!person) continue;
    if (msg.to_role && msg.to_role !== role) continue;
    if (!msg.to_role && msg.sender === role) continue;
    if (person.channel === 'telegram') sends.push(sendText(person.tg_chat_id, telegramText(msg)));
    else pokes.push(person.poke_key);
  }
  await Promise.all([...sends, poke(pokes)]);
}

/** Tell people their screen changed without a message (state-only changes). */
export async function nudge(...people) {
  await poke(people.filter((p) => p && p.channel === 'web').map((p) => p.poke_key));
}

export const MENU_BUTTONS = [[button('I need to vent', 'vent')], [button("I'm here to listen", 'listen')]];

export async function offerToListener(person, chat) {
  if (person.channel !== 'telegram') return;
  await sendText(
    person.tg_chat_id,
    `Someone needs to vent about: ${topicLabels(chat.topics)}.\nCan you listen now?`,
    [[button('Accept', 'offer:yes'), button('Skip', 'offer:no')]],
  );
}

export async function handoffBanner(venter, listenerAlias) {
  if (venter.channel !== 'telegram') return nudge(venter);
  await sendText(
    venter.tg_chat_id,
    `A real person (${listenerAlias}) is free now. They would see your first message, not your chat with the AI.`,
    [[button('Talk to them', 'handoff:yes'), button('Stay with AI', 'handoff:no')]],
  );
}

const AGAIN_ROW = [button('I would talk to them again', 'again:yes')];

/** `again`: offer "talk again" (only after a conversation with a person). */
export async function afterChatMenu(person, { again = false } = {}) {
  if (!person || person.channel !== 'telegram') return;
  await sendText(person.tg_chat_id, 'What would you like to do next?', again ? [AGAIN_ROW, ...MENU_BUTTONS] : MENU_BUTTONS);
}

export async function ratingPrompt(person) {
  if (!person || person.channel !== 'telegram') return;
  await sendText(person.tg_chat_id, 'Did you feel heard?', [
    [button('Yes', 'fb:2'), button('A little', 'fb:1'), button('No', 'fb:0')],
    AGAIN_ROW,
  ]);
}

export async function missedOffer(person) {
  if (person.channel !== 'telegram') return;
  await sendText(
    person.tg_chat_id,
    'You missed a request, so you are marked as away. Tap below when you can listen again.',
    [[button("I'm available again", 'listen')]],
  );
}
