-- The server connects as its own low-privilege role instead of the database
-- owner. It can use these tables and nothing else. Row-level security stays
-- on: the only policies are for this role, so the public Supabase API keys
-- still see nothing.
--
-- The role is created without a password. Set one once, outside version
-- control:   alter role yb_app with password '<long random string>';

do $$
begin
  if not exists (select from pg_roles where rolname = 'yb_app') then
    create role yb_app login;
  end if;
end $$;

grant usage on schema public to yb_app;
grant select, insert, update, delete on people, chats, listeners, messages, reports, blocks, rate_limits to yb_app;
grant usage, select on all sequences in schema public to yb_app;
grant execute on function listener_candidates(uuid, text[], uuid, int) to yb_app;
grant execute on function claim_listener(uuid, uuid, text[], uuid) to yb_app;

do $$
declare t text;
begin
  foreach t in array array['people', 'chats', 'listeners', 'messages', 'reports', 'blocks', 'rate_limits'] loop
    execute format('drop policy if exists app_all on %I', t);
    execute format('create policy app_all on %I for all to yb_app using (true) with check (true)', t);
  end loop;
end $$;

-- Functions are callable by everyone by default; only the app role needs them.
revoke execute on function listener_candidates(uuid, text[], uuid, int) from public;
revoke execute on function claim_listener(uuid, uuid, text[], uuid) from public;

-- Supabase gives its public API roles access to new objects by default.
-- Take it away (these roles do not exist on a plain Postgres, hence the check).
do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on people, chats, listeners, messages, reports, blocks, rate_limits from anon, authenticated;
    revoke execute on function listener_candidates(uuid, text[], uuid, int) from anon, authenticated;
    revoke execute on function claim_listener(uuid, uuid, text[], uuid) from anon, authenticated;
  end if;
end $$;

-- Pin the schema the functions resolve names in.
alter function listener_candidates(uuid, text[], uuid, int) set search_path = public, pg_temp;
alter function claim_listener(uuid, uuid, text[], uuid) set search_path = public, pg_temp;
