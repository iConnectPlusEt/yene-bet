// One Postgres connection pool for the server. On Supabase use the pooled
// ("transaction") connection string; `prepare: false` is required for it.
import postgres from 'postgres';

let client = null;

export function db() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  client = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return client;
}

/** Close the pool (tests and scripts). */
export async function closeDb() {
  if (client) await client.end({ timeout: 2 });
  client = null;
}
