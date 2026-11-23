// The Telegram side of YENE BET. It is a thin conversation wrapper around the
// same functions the website uses, so both share one pool of people.
import { db } from './db.js';
import { personFromTelegram, acceptRules } from './identity.js';
import { tg, sendText, button } from './telegramApi.js';
import { MENU_BUTTONS } from './delivery.js';
import {
  activeChatFor, candidates, startVent, sendMessage, goAvailable, stopListening,
  respondOffer, decideHandoff, endChat, report, sweepAndMatch, refineChatTags, answerPing,
  TELEGRAM_LISTENER_TTL, presence,
} from './chat.js';
import { setPings, snoozePings } from './pings.js';
import { createPost, refinePostTags } from './wall.js';
import { inviteRelater, respondInvite, wantAgain, listConnections, inviteConnection } from './invites.js';
import { getProfile, saveProfile, refineProfile } from './profiles.js';
import { giveFeedback } from './feedback.js';
import { experienceLabels } from '../experiences.js';
import { runAi } from './aiListener.js';
import { TOPICS, topicLabels, cleanTopics } from '../topics.js';
import { APP_NAME, RULES, TELEGRAM_RULES_NOTE, TELEGRAM_NOTICE } from '../strings.js';

const ERRORS = {
  suspended: 'This account has been suspended after reports from other people.',
  rate_limited: 'You are going a little fast. Please wait a moment and try again.',
  too_long: 'That message is too long. Please send it in smaller parts.',
  empty: 'Please write something first.',
  in_chat: 'You are already in a conversation. Send /end to finish it first.',
  no_chat: 'You are not in a conversation right now.',
  no_offer: 'That request is no longer open.',
  not_found: 'That is no longer available.',
  busy: 'One of you is in a conversation right now. The invitation stays open, so try again in a little while.',
  contact: 'Please leave out names, numbers and links, and send it again.',
  crisis: 'It sounds like you may be in danger. Please do not wait for replies to a post: tap "I need to vent" to talk to someone now, or contact local emergency services.',
  gone: 'They have already left. You are still available to listen.',
};

const say = (person, text, buttons) => sendText(person.tg_chat_id, text, buttons);
const explain = (person, error) => say(person, ERRORS[error] || 'Something went wrong. Please try again.');

async function setState(person, state) {
  await db()`update people set tg_state = ${db().json(state)} where id = ${person.id}`;
  person.tg_state = state;
}

// People who joined before the bot could ask them to listen are told once, on their next visit.
async function noticeOnce(person) {
  if (person.notice_shown_at || !person.notify_requests) return;
  person.notice_shown_at = new Date();
  await db()`update people set notice_shown_at = now() where id = ${person.id}`;
  await say(person, TELEGRAM_NOTICE, [[button('Stop these', 'ping:stop')]]);
}

/** Become available for 24 hours using the saved story and topics: one tap. */
async function listenNow(person) {
  await setState(person, {});
  const result = await goAvailable(person);
  if (!result.ok) return explain(person, result.error);
  if (await activeChatFor(person.id)) return null;          // someone was waiting and they are already connected
  const profile = await getProfile(person.id);
  const hours = Math.round(TELEGRAM_LISTENER_TTL / 3600);
  const first = profile?.experiences?.length ? ` You will be asked first about ${experienceLabels(profile.experiences)}.` : '';
  return say(
    person,
    `You are available to listen for the next ${hours} hours.${first} When someone needs you, I will offer the conversation with one tap. Send /stop any time.`,
    [[button('Change what I have been through', 'listen:edit')]],
  );
}

function showRules(person) {
  return say(
    person,
    `Welcome to ${APP_NAME}, a place to vent to someone who gets it. Everyone is anonymous.\n\nBefore you start:\n${RULES.map((r) => `• ${r}`).join('\n')}\n\n${TELEGRAM_RULES_NOTE}`,
    [[button('I am 18+ and I agree', 'rules:ok')]],
  );
}

async function showMenu(person, text = 'What would you like to do?') {
  const p = await presence();
  const listeners = p.listenersFree + p.listenersBusy;
  const here = listeners
    ? `${listeners} ${listeners === 1 ? 'person is' : 'people are'} here to listen${p.waiting ? `, ${p.waiting} waiting to be heard` : ''}.`
    : p.waiting ? `No listeners right now, and ${p.waiting} waiting to be heard.` : 'No listeners right now. Be the first.';
  return say(person, `${text}\n\n${here}`, MENU_BUTTONS);
}

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
  if (started.needsTagging) await refineChatTags(started.chatId);
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

async function onCommand(person, command, argument = '') {
  const inChat = await activeChatFor(person.id);
  switch (command) {
    case '/start':
    case '/help':
      return inChat ? say(person, 'You are in a conversation. Send /end to finish it.') : showMenu(person);
    case '/vent':
      if (inChat) return explain(person, 'in_chat');
      await setState(person, { step: 'vent_text' });
      return say(person, 'What is on your mind? Write a line or two and I will find someone who can relate.');
    case '/listen': {
      if (inChat) return explain(person, 'in_chat');
      const profile = await getProfile(person.id);
      // Already told us what they have been through: start straight away.
      if (profile && (profile.story || profile.topics.length || profile.experiences.length) && argument !== 'edit') return listenNow(person);
      const topics = profile?.topics || [];
      await setState(person, { step: 'listen', topics });
      return say(
        person,
        profile?.story
          ? `Your story: "${profile.story}"\n\nSend a new message to change it, adjust the topics, then start.`
          : 'People are matched with listeners who have been through the same thing. In a sentence or two, what have you been through? Send it as a message (optional), tap any topics that apply, then start.',
        topicKeyboard(topics),
      );
    }
    case '/share':
      if (inChat) return explain(person, 'in_chat');
      await setState(person, { step: 'share' });
      return say(person, 'Write what you want to share. It is posted anonymously on the wall, and people who have been through the same can reach out to you.');
    case '/people': {
      const people = await listConnections(person.id);
      if (!people.length) return say(person, 'Nobody yet. After a conversation, tap "I would talk to them again"; if they do too, they appear here.');
      return say(person, 'People you both agreed to talk with again:', people.map((c) => [button(`Invite ${c.alias}`, `con:${c.id}`)]));
    }
    case '/pings': {
      if (argument !== 'on' && argument !== 'off') {
        return say(
          person,
          person.notify_requests
            ? 'I may message you when someone is waiting and nobody is free, to ask if you can listen: at most 3 times a day.'
            : 'I will not message you when someone is waiting. You can still listen any time.',
          [[person.notify_requests ? button('Stop these', 'ping:stop') : button('Turn these on', 'pings:on')]],
        );
      }
      const on = argument === 'on';
      await setPings(person.id, on);
      person.notify_requests = on;
      return say(
        person,
        on
          ? 'Okay. I may message you when someone is waiting and nobody is free, at most 3 times a day. Send /pings off to stop.'
          : 'Okay, I will not message you when someone is waiting. You can still tap "I am here to listen" any time. Send /pings on to turn these back on.',
      );
    }
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
  await noticeOnce(person);

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (text.startsWith('/')) {
    const [command, argument = ''] = text.split(/\s+/);
    return onCommand(person, command.split('@')[0].toLowerCase(), argument.toLowerCase());
  }

  if (await activeChatFor(person.id)) {
    if (!text) return say(person, 'Only text messages can be sent for now.');
    return relay(person, text);
  }

  if (person.tg_state?.step === 'share') {
    await setState(person, {});
    const result = await createPost(person, text);
    if (!result.ok) return explain(person, result.error);
    if (result.needsTagging) await refinePostTags(result.post.id);
    return showMenu(person, 'Shared. I will message you when someone says they have been there too.');
  }

  if (person.tg_state?.step === 'again_text') {
    const connectionId = person.tg_state.connectionId;
    await setState(person, {});
    const result = await inviteConnection(person, connectionId, text);
    if (!result.ok) return explain(person, result.error);
    return say(person, 'Invitation sent. I will connect you as soon as they accept.');
  }

  if (person.tg_state?.step === 'note') {
    const heard = person.tg_state.heard ?? 2;
    await setState(person, {});
    if (!text) return showMenu(person);
    const result = await giveFeedback(person, { heard, note: text });
    if (result.error === 'contact_in_note') {
      await setState(person, { step: 'note', heard });
      return say(person, 'Please leave out names, numbers and links, and send the note again.', [[button('Skip', 'note:skip')]]);
    }
    return showMenu(person, result.ok ? 'Thank you, your note was passed on.' : 'What would you like to do next?');
  }

  if (person.tg_state?.step === 'listen') {
    if (!text) return say(person, 'Please send your story as a text message.');
    const saved = await saveProfile(person, { story: text });
    if (saved.needsTagging) await refineProfile(person.id);
    const profile = await getProfile(person.id);
    return say(
      person,
      profile.experiences.length
        ? `Saved. You will be matched first with people going through: ${experienceLabels(profile.experiences)}.`
        : 'Saved.',
      topicKeyboard(cleanTopics(person.tg_state?.topics || [])),
    );
  }

  if (person.tg_state?.step === 'vent_text') {
    if (!text) return say(person, 'Please describe it in a text message.');
    const found = await candidates(person, text, []);
    if (!found.candidates.length) return beginVent(person, text, null);
    await setState(person, { step: 'pick', text });
    return say(person, 'These people are available right now. Pick one, or connect to the best match straight away.', [
      [button('Connect me now', 'pick:auto')],
      ...found.candidates.map((c) => [
        button(
          `${c.alias}${c.sharedExperiences.length ? ` · been through ${experienceLabels(c.sharedExperiences)}` : c.topics.length ? ` · ${topicLabels(c.topics)}` : ''}`.slice(0, 60),
          `pick:${c.id}`,
        ),
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
    await db()`update people set notice_shown_at = now() where id = ${person.id}`;   // the rules screen told them
    return showMenu(person, 'Thank you. What would you like to do?');
  }
  if (!person.rules_accepted_at) return showRules(person);
  if (!data.startsWith('ping:') && data !== 'pings:on') await noticeOnce(person);

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
    await saveProfile(person, { topics: chosen });
    return listenNow(person);
  }
  if (data === 'listen:go') return listenNow(person);
  if (data === 'listen:edit') return onCommand(person, '/listen', 'edit');

  if (data.startsWith('pick:')) {
    const text = person.tg_state?.text;
    if (!text) return onCommand(person, '/vent');
    const pick = data.slice(5);
    return beginVent(person, text, pick === 'auto' ? null : pick);
  }

  if (data === 'again:yes') {
    const result = await wantAgain(person);
    if (!result.ok) return explain(person, result.error);
    return say(person, result.mutual
      ? 'They said the same. Send /people whenever you want to reach them.'
      : 'Noted. If they say the same, you will be able to reach each other again.');
  }
  if (data.startsWith('rel:')) {
    const result = await inviteRelater(person, Number(data.slice(4)));
    if (!result.ok) return explain(person, result.error);
    return say(person, 'Invitation sent. I will connect you as soon as they accept.');
  }
  if (data.startsWith('inv:')) {
    const [, id, answer] = data.split(':');
    const result = await respondInvite(person, Number(id), answer === 'y');
    if (!result.ok) return explain(person, result.error);
    return result.connected
      ? say(person, 'Send /end to finish at any time, or /report if someone is abusive.')
      : say(person, 'Okay, declined.');
  }
  if (data.startsWith('con:')) {
    await setState(person, { step: 'again_text', connectionId: Number(data.slice(4)) });
    return say(person, 'What is going on? Write a line or two and I will send the invitation.');
  }

  if (data === 'pings:on') return onCommand(person, '/pings', 'on');
  if (data === 'ping:no') {
    await snoozePings(person.id);
    return say(person, 'No problem. I will leave you alone for a couple of hours.');
  }
  if (data === 'ping:stop') {
    await setPings(person.id, false);
    return say(person, 'Okay, I will not message you when someone is waiting. You can still tap "I am here to listen" any time, and /pings on turns these back on.');
  }
  if (data.startsWith('ping:')) {
    const result = await answerPing(person, data.slice(5));
    if (result.error === 'gone') {
      return say(
        person,
        'Thank you for answering. They have already been connected with someone else. Would you like to be available for the next 24 hours, so you are the one who is asked next time?',
        [[button('Be available for 24 hours', 'listen:go')]],
      );
    }
    if (!result.ok) return explain(person, result.error);
    if (result.connected) return say(person, 'Send /end to finish at any time, or /report if someone is abusive.');
    return say(person, 'Thank you. They are talking with the AI listener right now and will be connected to you if they choose.');
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

  if (data.startsWith('fb:')) {
    const heard = Number(data.slice(3));
    if (heard === 0) {
      await giveFeedback(person, { heard: 0 });
      return showMenu(person, 'Thank you for telling us. That helps us match people better.');
    }
    // The answer is saved together with the note, or when they skip it.
    await setState(person, { step: 'note', heard });
    return say(person, 'Glad to hear it. Send a short thank-you note for them if you like.', [[button('Skip', 'note:skip')]]);
  }
  if (data === 'note:skip') {
    const heard = person.tg_state?.heard;
    await setState(person, {});
    if (heard !== undefined) await giveFeedback(person, { heard });
    return showMenu(person, 'Thank you.');
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
