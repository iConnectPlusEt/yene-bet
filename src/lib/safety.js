// Checks run on every message before it is delivered.

export const MAX_MESSAGE_LENGTH = 2000;

// Wording that suggests someone may be in danger. Deliberately broad: a false
// alarm only shows a help card, a miss shows nothing.
const CRISIS_PATTERNS = [
  /\bkill(ing)?\s+my\s?self\b/i,
  /\bend(ing)?\s+(my|this)\s+life\b/i,
  /\b(take|taking)\s+my\s+(own\s+)?life\b/i,
  /\bsuicid(e|al)\b/i,
  /\b(want|wanna|wish|going|ready)\s+(to\s+)?(die|be dead|disappear forever)\b/i,
  /\bwish\s+i\s+(was|were)\s+dead\b/i,
  /\b(don'?t|do not|dont)\s+want\s+to\s+(live|be alive|exist|wake up)\b/i,
  /\b(no|not any)\s+reason\s+to\s+live\b/i,
  /\bbetter\s+off\s+(dead|without\s+me)\b/i,
  /\b(hurt|harm|cut|cutting)\s+my\s?self\b/i,
  /\bself[-\s]?harm\b/i,
  /\boverdos(e|ing)\b/i,
  /\b(he|she|they)\s+(is|are|was|were)\s+(going to|gonna)\s+(kill|hurt)\s+me\b/i,
];

export function looksLikeCrisis(text) {
  return CRISIS_PATTERNS.some((re) => re.test(text || ''));
}

const CONTACT_PATTERNS = [
  /(\+?\d[\s().-]?){9,}/,                         // phone number
  /(^|\s)@[a-z0-9_]{4,}/i,                         // @username
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,        // email
  /\b(https?:\/\/|www\.)\S+/i,                     // link
  /\b(t\.me|wa\.me|instagram\.com|facebook\.com|snapchat\.com|tiktok\.com)\b/i,
];

/** True when a message seems to contain a phone number, username, email or link. */
export function looksLikeContact(text) {
  return CONTACT_PATTERNS.some((re) => re.test(text || ''));
}

/** Trim and validate a message body. Returns { ok, body } or { ok: false, error }. */
export function checkBody(raw) {
  const body = typeof raw === 'string' ? raw.replace(/\u0000/g, '').trim() : '';
  if (!body) return { ok: false, error: 'empty' };
  if (body.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'too_long' };
  return { ok: true, body };
}
