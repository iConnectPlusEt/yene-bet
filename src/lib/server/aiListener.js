// The AI listener that keeps someone company until a real person is free.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { deliverMessage, nudge } from './delivery.js';

const SYSTEM_PROMPT = `You are the AI listener in YENE BET, an app where people come to vent anonymously. No human listener is free right now, so you are keeping this person company until one is. They know you are an AI.

Your job is to listen. Reflect back what you hear so the person feels understood, and ask one gentle, open question when it helps them keep talking. Most people here want to be heard, not fixed, so do not give advice unless they ask for it, and do not diagnose or play therapist. Write the way a warm, attentive friend would text: short (usually two to four sentences), plain words, no lists or headings, no emoji unless they use them first. Reply in the language the person writes in.

Do not ask for or use identifying details such as names, phone numbers or accounts; the app is anonymous.

If the person says anything suggesting they may hurt themselves or someone else, or that they are in danger, take it seriously and stay with them. Say plainly that you are worried, encourage them to contact local emergency services or a crisis helpline (findahelpline.com lists free ones by country), and suggest reaching someone they trust who can be with them. Do not lecture and do not end the conversation.`;

// Used when no API key is configured (local development and tests), so the
// rest of the app still works end to end.
const STAND_INS = [
  'I am here, and I am listening. Take your time. What part of this is weighing on you most?',
  'That sounds like a lot to carry. What happened next?',
  'Thank you for telling me. How long has it felt like this?',
  'I hear you. What do you wish someone would understand about this?',
];

const UNAVAILABLE = 'I am still here with you, but I could not put a reply together just now. Please keep going if you would like to.';

let client = null;
function anthropic() {
  if (!client) client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  return client;
}

/** history: [{ role: 'user' | 'assistant', content: string }] ending with a user turn. */
export async function aiReply(history) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    const turns = history.filter((m) => m.role === 'user').length;
    return STAND_INS[(turns - 1 + STAND_INS.length) % STAND_INS.length];
  }
  try {
    const response = await anthropic().beta.messages.create({
      model: process.env.AI_MODEL || 'claude-opus-5-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low' },
      // If the model declines a message on policy grounds, another model is
      // tried within the same request instead of leaving the person unanswered.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: history,
    });
    if (response.stop_reason === 'refusal') return UNAVAILABLE;
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    return text || UNAVAILABLE;
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) console.warn('[ai] rate limited');
    else if (error instanceof Anthropic.APIError) console.error('[ai] API error', error.status, error.message);
    else console.error('[ai] failed', error);
    return UNAVAILABLE;
  }
}

/**
 * Answer the venter's latest message in an AI-mode chat. If a newer message
 * arrives (or a real person joins) while the reply is being written, this
 * reply is dropped and the newer run answers with the full context.
 */
export async function runAi(chatId) {
  const sql = db();
  const rows = await sql`
    select id, sender, body from messages
    where chat_id = ${chatId} and sender in ('venter', 'ai') and to_role is null and kind = 'text'
    order by id`;
  const lastVenterId = rows.filter((r) => r.sender === 'venter').at(-1)?.id;
  if (!lastVenterId || rows.at(-1).sender !== 'venter') {
    await sql`update chats set ai_pending = false where id = ${chatId} and mode = 'ai'`;
    return null;
  }
  const history = rows.map((r) => ({ role: r.sender === 'venter' ? 'user' : 'assistant', content: r.body }));
  const text = await aiReply(history);

  const [chat] = await sql`select * from chats where id = ${chatId}`;
  const [{ newest }] = await sql`
    select max(id) as newest from messages where chat_id = ${chatId} and sender = 'venter' and to_role is null`;
  if (!chat || chat.status !== 'active' || chat.mode !== 'ai' || newest !== lastVenterId) return null;

  const [msg] = await sql`
    insert into messages (chat_id, sender, body) values (${chatId}, 'ai', ${text}) returning *`;
  await sql`update chats set ai_pending = false, last_message_at = now() where id = ${chatId}`;
  const [venter] = await sql`select * from people where id = ${chat.venter_id}`;
  await deliverMessage(msg, { venter, listener: null });
  await nudge(venter);
  return msg;
}
