// Applies the files in supabase/migrations, in name order, to DATABASE_URL.
// Each file runs once; what has run is recorded in the schema_migrations table.
//
// For a database that was set up before this record existed, mark the files
// it already has without running them:
//   BASELINE=0004_feedback.sql DATABASE_URL=... node scripts/migrate.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
await sql`alter table schema_migrations enable row level security`;

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const baseline = process.env.BASELINE;
if (baseline) {
  for (const file of files.filter((f) => f <= baseline)) {
    await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
  }
}

const done = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
for (const file of files) {
  if (done.has(file)) continue;
  await sql.begin(async (tx) => {
    await tx.unsafe(fs.readFileSync(path.join(dir, file), 'utf8'));
    await tx`insert into schema_migrations (name) values (${file})`;
  });
  console.log('applied', file);
}
await sql.end();
