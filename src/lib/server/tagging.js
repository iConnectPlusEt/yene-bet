// Works out which specific experiences a piece of text is about. Word
// matching is instant and always available; the AI reads more carefully and
// is used to refine the result in the background, never to delay a match.
import Anthropic from '@anthropic-ai/sdk';
import { EXPERIENCES, cleanExperiences, detectExperiences, detectLanguage } from '../experiences.js';

export function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Instant tags from word matching. */
export function quickTags(text) {
  return { experiences: detectExperiences(text), language: detectLanguage(text) };
}

const SYSTEM_PROMPT = `You label short anonymous messages for a peer-support app so people can be matched with someone who has lived through the same thing.

Pick the experiences from the list below that the writer is clearly living through or has lived through. Choose only what the text supports, at most four, most central first. If nothing fits, return an empty list. Also give the language the text is written in as a two-letter code (for example "en" or "am").

Experiences (key: meaning):
${EXPERIENCES.map((e) => `${e.key}: ${e.label}`).join('\n')}

Reply with a single JSON object and nothing else, in this shape: {"experiences": ["key", ...], "language": "en"}`;

let client = null;
function anthropic() {
  if (!client) client = new Anthropic({ timeout: 12_000, maxRetries: 0 });
  return client;
}

/** Careful tags from the AI, or null when it is unavailable or unclear. */
export async function aiTags(text) {
  if (!aiConfigured()) return null;
  try {
    const response = await anthropic().beta.messages.create({
      model: process.env.AI_MODEL || 'claude-opus-5-5',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: String(text).slice(0, 2000) }],
    });
    if (response.stop_reason === 'refusal') return null;
    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return parseTags(raw);
  } catch (error) {
    if (error instanceof Anthropic.APIError) console.warn('[tagging] API error', error.status);
    else console.warn('[tagging] failed', error?.message || error);
    return null;
  }
}

/** Reads the model's JSON reply, keeping only known experience keys. */
export function parseTags(raw) {
  const start = String(raw).indexOf('{');
  const end = String(raw).lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(String(raw).slice(start, end + 1));
    const language = typeof data.language === 'string' && /^[a-z]{2}$/i.test(data.language) ? data.language.toLowerCase() : null;
    return { experiences: cleanExperiences(data.experiences, 4), language };
  } catch {
    return null;
  }
}

/** Word-matched and AI tags combined, AI first. */
export function mergeTags(quick, careful) {
  if (!careful) return quick;
  return {
    experiences: cleanExperiences([...careful.experiences, ...quick.experiences]),
    language: careful.language || quick.language,
  };
}
