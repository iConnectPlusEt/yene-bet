// Applies every file in supabase/migrations, in name order, to DATABASE_URL.
// The migrations are written to be safe to run again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  await sql.unsafe(fs.readFileSync(path.join(dir, file), 'utf8'));
  console.log('applied', file);
}
await sql.end();
