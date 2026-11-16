// The Telegram side of YENE BET. It is a thin conversation wrapper around the
// same functions the website uses, so both share one pool of people.
import { db } from './db.js';
import { personFromTelegram, acceptRules } from './identity.js';
import { tg, sendText, button } from './telegramApi.js';
import { MENU_BUTTONS } from './delivery.js';
import {
  activeChatFor, candidates, startVent, sendMessage, goAvailable, stopListening,
  respondOffer, decideHandoff, endChat, report, sweepAndMatch, TELEGRAM_LISTENER_TTL,
} from './chat.js';
import { runAi } from './aiListener.js';
import { TOPICS, topicLabels, cleanTopics } from '../topics.js';
import { APP_NAME, RULES } from '../strings.js';

const ERRORS = {
  suspended: 'This account has been suspended after reports from other people.',
  rate_limited: 'You are going a little fast. Please wait a moment and try again.',
  too_long: 'That message is too long. Please send it in smaller parts.',
  empty: 'Please write something first.',
  in_chat: 'You are already in a conversation. Send /end to finish it first.',
  no_chat: 'You are not in a conversation right now.',
  no_offer: 'That request is no longer open.',
  gone: 'They have already left. You are still available to listen.',
};

const say = (person, text, buttons) => sendText(person.tg_chat_id, text, buttons);
const explain = (person, error) => say(person, ERRORS[error] || 'Something went wrong. Please try again.');

async function setState(person, state) {
  await db()`update people set tg_state = ${db().json(state)} where id = ${person.id}`;
  person.tg_state = state;
}

function showRules(person) {
  return say(
    person,
    `Welcome to ${APP_NAME}, a place to vent to someone who gets it. Everyone is anonymous.\n\nBefore you start:\n${RULES.map((r) => `• ${r}`).join('\n')}`,
    [[button('I am 18+ and I agree', 'rules:ok')]],
  );
}

const showMenu = (person, text = 'What would you like to do?') => say(person, text, MENU_BUTTONS);

function topicKeyboard(selected) {
  const rows = [];
  const keys = TOPICS.filter((t) => t.key !== 'other');
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((t) => button(`${selected.includes(t.key) ? '✓ ' : ''}${t.label}`, `lt:${t.key}`)));
  }
  rows.push([button('Start listening', 'lt:go')]);
  return rows;
}

async function beginVent(person, text, pick) {
  await setState(person, {});
  const started = await startVent(person, { text, topics: [], pick });
  if (!started.ok) return explain(person, started.error);
  await say(person, 'Send /end to finish at any time, or /report if someone is abusive.');
  if (started.needsAi) await runAi(started.chatId);
}

async function relay(person, text, confirm = false) {
  const sent = await sendMessage(person, text, { confirm });
  if (sent.warn === 'contact') {
    await setState(person, { pending: text });
    return say(
      person,
      'That looks like it contains contact details. Sharing them ends your anonymity. Send it anyway?',
      [[button('Send anyway', 'confirm:send'), button('Do not send', 'confirm:drop')]],
    );
  }
  if (!sent.ok) return explain(person, sent.error);
  if (sent.needsAi) await runAi(sent.chatId);
}

async function onCommand(person, command) {
  const inChat = await activeChatFor(person.id);
  switch (command) {
    case '/start':
    case '/help':
      return inChat ? say(person, 'You are in a conversation. Send /end to finish it.') : showMenu(person);
    case '/vent':
      if (inChat) return explain(person, 'in_chat');
      await setState(person, { step: 'vent_text' });
      return say(person, 'What is on your mind? Write a line or two and I will find someone who can relate.');
    case '/listen':
      if (inChat) return explain(person, 'in_chat');
      await setState(person, { step: 'listen', topics: [] });
      return say(person, 'Which of these can you relate to? Tap any that apply, then start.', topicKeyboard([]));
    case '/stop':
      await stopListening(person);
      return showMenu(person, 'You are no longer marked as available.');
    case '/end': {
      const ended = await endChat(person);
      return ended.ok ? null : explain(person, ended.error);
    }
    case '/report': {
      const done = await report(person, 'reported from Telegram');
      return done.ok
        ? say(person, 'Thank you. The conversation is closed and you will not be matched with that person again.')
        : explain(person, done.error);
    }
    default:
      return showMenu(person);
  }
}

async function onMessage(message) {
  if (message.chat?.type !== 'private') return;
  const person = await personFromTelegram(message.chat.id);
  if (!person.rules_accepted_at) return showRules(person);

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text.startsWith('/')) return onCommand(person, text.split(/[\s@]/)[0].toLowerCase());

  if (await activeChatFor(person.id)) {
    if (!text) return say(person, 'Only text messages can be sent for now.');
    return relay(person, text);
  }

  if (person.tg_state?.step === 'vent_text') {
    if (!text) return say(person, 'Please describe it in a text message.');
    const found = await candidates(person, text, []);
    if (!found.candidates.length) return beginVent(person, text, null);
    await setState(person, { step: 'pick', text });
    return say(person, 'These people are available right now. Pick one, or connect to the best match straight away.', [
      [button('Connect me now', 'pick:auto')],
      ...found.candidates.map((c) => [
        button(`${c.alias}${c.topics.length ? ` · ${topicLabels(c.topics)}` : ''}`.slice(0, 60), `pick:${c.id}`),
      ]),
    ]);
  }
  return showMenu(person);
}

async function onCallback(query) {
  await tg('answerCallbackQuery', { callback_query_id: query.id });
  const chatId = query.message?.chat?.id ?? query.from?.id;
  if (!chatId) return;
  const person = await personFromTelegram(chatId);
  const data = String(query.data || '');

  if (data === 'rules:ok') {
    await acceptRules(person.id);
    return showMenu(person, 'Thank you. What would you like to do?');
  }
  if (!person.rules_accepted_at) return showRules(person);

  if (data === 'vent') return onCommand(person, '/vent');
  if (data === 'listen') return onCommand(person, '/listen');

  if (data.startsWith('lt:')) {
    const key = data.slice(3);
    const chosen = cleanTopics(person.tg_state?.topics || []);
    if (key !== 'go') {
      const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : cleanTopics([...chosen, key]);
      await setState(person, { step: 'listen', topics: next });
      return tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: query.message?.message_id,
        reply_markup: { inline_keyboard: topicKeyboard(next) },
      });
    }
    await setState(person, {});
    const result = await goAvailable(person, chosen);
    if (!result.ok) return explain(person, result.error);
    if (await activeChatFor(person.id)) return null;
    return say(
      person,
      `You are available to listen for the next ${Math.round(TELEGRAM_LISTENER_TTL / 60)} minutes. I will message you when someone needs you. Send /stop to stop.`,
    );
  }

  if (data.startsWith('pick:')) {
    const text = person.tg_state?.text;
    if (!text) return onCommand(person, '/vent');
    const pick = data.slice(5);
    return beginVent(person, text, pick === 'auto' ? null : pick);
  }

  if (data.startsWith('offer:')) {
    const result = await respondOffer(person, data === 'offer:yes');
    if (!result.ok) return explain(person, result.error);
    if (data !== 'offer:yes') return say(person, 'No problem. You are still available.');
    if (result.connected) return say(person, 'Send /end to finish at any time, or /report if someone is abusive.');
    return say(person, 'Thank you. They are talking with the AI listener right now and will be connected to you if they choose.');
  }

  if (data.startsWith('handoff:')) {
    const result = await decideHandoff(person, data === 'handoff:yes');
    if (!result.ok) return explain(person, result.error);
    if (data === 'handoff:yes' && !result.connected) return say(person, 'They are no longer available. The AI listener is still here.');
    if (data === 'handoff:no') return say(person, 'Okay, staying with the AI listener.');
    return null;
  }

  if (data === 'confirm:send' || data === 'confirm:drop') {
    const pending = person.tg_state?.pending;
    await setState(person, {});
    if (data === 'confirm:send' && pending) return relay(person, pending, true);
    return say(person, 'Not sent.');
  }
  return null;
}

/** Entry point for one Telegram update. */
export async function handleUpdate(update) {
  await sweepAndMatch();
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message) return onMessage(update.message);
  return null;
}
