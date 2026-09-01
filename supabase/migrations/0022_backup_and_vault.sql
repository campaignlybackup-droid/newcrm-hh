-- =====================================================================
-- 0022_backup_and_vault.sql
-- Support functions for the nightly backup and the Google Calendar sync.
-- =====================================================================

-- Tables in dependency order, so a restore can replay parents before
-- children without deferring constraints. Computed from the actual
-- foreign-key graph rather than a hand-maintained list that would rot.
create or replace function public.backup_table_order()
returns table (table_name text, depth int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive fk as (
    select src.relname::text as child, tgt.relname::text as parent
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_class tgt on tgt.oid = c.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    where c.contype = 'f' and n.nspname = 'public' and src.relname <> tgt.relname
  ),
  tables as (
    select c.relname::text as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  levels as (
    select t.name, 0 as depth
    from tables t
    where not exists (select 1 from fk where fk.child = t.name)
    union all
    select fk.child, l.depth + 1
    from fk join levels l on l.name = fk.parent
    where l.depth < 20
  )
  select name, max(depth)::int as depth
  from levels
  group by name
  order by 2, 1;
$$;

comment on function public.backup_table_order() is
  'Parent-before-child ordering derived from the live FK graph, so a restore from the nightly dump replays cleanly.';

-- ---------------------------------------------------------------------
-- Google OAuth refresh tokens live in Supabase Vault, never in a business
-- table. This wrapper is the ONLY read path, it is service-role only, and
-- it is the reason users has no token column.
--
-- Note the contrast with client_social_accounts, which stores an
-- access_status flag and no credential at all: the agency's own calendar
-- integration needs a token; a client's social account never does.
-- ---------------------------------------------------------------------
create or replace function public.vault_read_google_refresh_token(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare v_secret text;
begin
  -- Callable only by the service role, from an Edge Function.
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Vault access is service-role only' using errcode = '42501';
  end if;

  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets
     where name = 'google_refresh_token:' || p_user_id::text;
  exception when undefined_table or invalid_schema_name then
    -- Vault is a Supabase-managed schema; on a bare Postgres it is absent.
    raise notice 'Supabase Vault is not available in this environment';
    return null;
  end;

  return v_secret;
end $$;

revoke all on function public.vault_read_google_refresh_token(uuid) from public;

do $$
begin
  execute 'grant execute on function public.backup_table_order() to authenticated';
exception when undefined_object then null;
end $$;
