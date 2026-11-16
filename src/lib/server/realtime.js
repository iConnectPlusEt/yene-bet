// Optional instant delivery for the website. When Supabase is configured the
// server sends a content-free "poke" to the recipient's channel and their
// browser fetches the new state at once. Without it the browser's regular
// polling still delivers everything, a second or so later.
export async function poke(pokeKeys) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  // A poke carries no content, so the public key is enough to send one.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const keys = (pokeKeys || []).filter(Boolean);
  if (!url || !key || !keys.length) return;
  try {
    await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: keys.map((k) => ({ topic: `p:${k}`, event: 'poke', payload: {} })) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Polling covers a missed poke.
  }
}
