// All wording shown to people, for the website and the Telegram bot alike.
// Keeping it in one file is what makes adding Amharic later a single change.

export const APP_NAME = 'My Home';

export const RULES = [
  'You are 18 or older.',
  'Everyone here is anonymous. Do not ask for or share names, phone numbers or accounts.',
  'Be kind. No harassment, hate, threats or sexual messages.',
  'Listeners are ordinary people, not professionals. This is not therapy or emergency help.',
  'If you are in danger, contact local emergency services.',
  'Your conversations are kept for you for 30 days, then deleted. You can remove them sooner.',
];

export const HELP = {
  title: 'You deserve real support right now',
  body:
    'If you might hurt yourself or you are in danger, please reach a person who is trained to help. ' +
    'Call your local emergency number, or find a free helpline in your country at findahelpline.com.',
  link: 'https://findahelpline.com',
  linkLabel: 'Find a helpline',
};

/** Optional verified local helpline, set by whoever runs the app. */
export function localHelpline() {
  return (process.env.HELPLINE_TEXT || '').trim();
}

export function helpText() {
  const local = localHelpline();
  return `${HELP.title}\n\n${HELP.body}${local ? `\n\n${local}` : ''}`;
}

export const SYS = {
  aiStart:
    'No one is free this second, so an AI listener is here with you. A real person will be offered as soon as one is available.',
  waitStart:
    'No one is free this second. We are looking, and you will be connected the moment someone is here. You can keep writing; whoever joins will read it.',
  aiDown:
    'The AI listener is not available right now. We are still looking for a person, and you will be connected the moment someone is here. You can keep writing.',
  connected: (alias) => `You are connected with ${alias}. They are a real person, here to listen.`,
  humanJoined: (alias) =>
    `${alias}, a real person, has joined. They can see your first message but not your conversation with the AI.`,
  listenerIntro: 'You are connected. Listen first; you do not need to fix anything.',
  ended: 'This conversation has ended.',
  endedByOther: 'The other person ended the conversation.',
  endedIdle: 'This conversation was closed after a long silence.',
  crisisToOther:
    'What they wrote suggests they may be in danger. You are not expected to handle this alone. Stay kind, and encourage them to contact emergency services or a helpline.',
};

export const AI_NAME = 'AI listener';

// Telegram only: the bot may ask people to listen when someone is waiting.
export const TELEGRAM_RULES_NOTE =
  'On Telegram I may also message you when someone is waiting and nobody is free, to ask if you can listen. It takes one tap to help, at most 3 times a day, and /pings off stops it.';
export const TELEGRAM_NOTICE =
  'One thing to know: when someone is waiting and nobody is free, I may message you to ask if you can listen. It takes one tap to help, at most 3 times a day. You can stop these any time.';
