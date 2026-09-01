-- =====================================================================
-- 0012_authz_helpers.sql
-- THE VISIBILITY MODEL.
--
-- Access is two-dimensional: vertical (the reporting tree) + horizontal
-- (assignment). A user's visible set is the union of OWN, SUBTREE, TEAM
-- and ALL. Everything below exists so that an RLS policy can express
-- that union without a correlated subquery per row.
--
-- Why SECURITY DEFINER: these functions read users / roles /
-- role_permissions, which are themselves RLS-protected. A policy that
-- queried them directly would recurse. Running as the definer breaks
-- the loop.
--
-- Why the transaction-local cache: PostgreSQL constant-folds only
-- IMMUTABLE functions, so a STABLE auth_scope() in a WHERE clause is
-- re-evaluated per row. auth_ctx() therefore resolves the whole
-- permission picture once and memoises it in a transaction-local GUC,
-- reducing every later call to a GUC read. The set-returning helpers are
-- consumed as `x in (select ... from f())`, which the planner hoists
-- into a single hashed InitPlan — one evaluation per query, not per row.
-- =====================================================================

-- ---------------------------------------------------------------------
-- JWT access that also works on a bare Postgres (no auth schema)
-- ---------------------------------------------------------------------
create or replace function public.jwt_claims()
returns jsonb language sql stable parallel safe as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;

create or replace function public.jwt_sub()
returns uuid language plpgsql stable parallel safe as $$
declare v text;
begin
  v := public.jwt_claims() ->> 'sub';
  if v is null or v = '' then return null; end if;
  return v::uuid;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------
-- auth_ctx() — the one lookup per transaction
-- ---------------------------------------------------------------------
create or replace function public.auth_ctx()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_cached text;
  v_sub    uuid;
  v_ctx    jsonb;
  v_user   record;
begin
  v_cached := current_setting('crm.auth_ctx', true);
  if v_cached is not null and v_cached <> '' then
    return v_cached::jsonb;
  end if;

  -- The ONLY source of identity is the verified JWT. There is deliberately
  -- no impersonation GUC here: a custom setting can be written by any
  -- session, so honouring one would hand every authenticated user a way
  -- to become the Founder. Tests authenticate the same way PostgREST
  -- does, by setting request.jwt.claims on a non-superuser connection.
  v_sub := public.jwt_sub();

  select u.id, u.auth_id, u.path, u.client_id, u.status,
         r.level, r.is_external, r.default_scope, r.code as role_code
    into v_user
    from public.users u
    join public.roles r on r.id = u.role_id
   where (v_sub is not null and u.auth_id = v_sub)
     and u.deleted_at is null
   limit 1;

  if not found then
    v_ctx := jsonb_build_object(
      'user_id', null, 'role_level', null, 'is_external', false,
      'client_id', null, 'path', null, 'active', false,
      'scopes', '{}'::jsonb, 'perms', '{}'::jsonb
    );
    perform set_config('crm.auth_ctx', v_ctx::text, true);
    return v_ctx;
  end if;

  -- Effective permissions = role matrix, overlaid with per-person
  -- overrides where the override column is non-null and unexpired.
  with eff as (
    select m.key as module,
           coalesce(o.scope,       rp.scope,       v_user.default_scope) as scope,
           coalesce(o.can_view,    rp.can_view,    false) as can_view,
           coalesce(o.can_create,  rp.can_create,  false) as can_create,
           coalesce(o.can_edit,    rp.can_edit,    false) as can_edit,
           coalesce(o.can_delete,  rp.can_delete,  false) as can_delete,
           coalesce(o.can_assign,  rp.can_assign,  false) as can_assign,
           coalesce(o.can_approve, rp.can_approve, false) as can_approve,
           coalesce(o.can_export,  rp.can_export,  false) as can_export
      from public.modules m
      left join public.role_permissions rp
             on rp.module = m.key
            and rp.role_id = (select role_id from public.users where id = v_user.id)
      left join public.user_permission_overrides o
             on o.module = m.key
            and o.user_id = v_user.id
            and (o.expires_on is null or o.expires_on >= current_date)
  )
  select jsonb_build_object(
           'user_id',     v_user.id,
           'role_level',  v_user.level,
           'role_code',   v_user.role_code,
           'is_external', v_user.is_external,
           'client_id',   v_user.client_id,
           'path',        v_user.path::text,
           'active',      (v_user.status in ('Active','On Leave')),
           'scopes',      (select jsonb_object_agg(module, scope) from eff),
           'perms',       (select jsonb_object_agg(module, jsonb_build_object(
                                    'view', can_view, 'create', can_create, 'edit', can_edit,
                                    'delete', can_delete, 'assign', can_assign,
                                    'approve', can_approve, 'export', can_export)) from eff)
         )
    into v_ctx;

  perform set_config('crm.auth_ctx', v_ctx::text, true);
  return v_ctx;
end $$;

comment on function public.auth_ctx() is
  'Resolves the acting user, role level and full effective permission matrix once per transaction and memoises it in a transaction-local GUC.';

-- ---------------------------------------------------------------------
-- The helpers the policies actually call
-- ---------------------------------------------------------------------
create or replace function public.auth_user_id()
returns uuid language sql stable security definer set search_path = public as $$
  select nullif(public.auth_ctx() ->> 'user_id', '')::uuid;
$$;

create or replace function public.auth_role_level()
returns int language sql stable security definer set search_path = public as $$
  select coalesce(nullif(public.auth_ctx() ->> 'role_level', '')::int, 999);
$$;

create or replace function public.auth_is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((public.auth_ctx() ->> 'active')::boolean, false);
$$;

-- Founder / Co-Founder. Levels 0 and 1 see everything, always.
create or replace function public.is_founder()
returns boolean language sql stable security definer set search_path = public as $$
  select public.auth_role_level() <= 1 and public.auth_is_active();
$$;

create or replace function public.is_client_portal_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((public.auth_ctx() ->> 'is_external')::boolean, false);
$$;

-- The client a portal user belongs to (null for internal staff).
create or replace function public.auth_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select case when public.is_client_portal_user()
              then nullif(public.auth_ctx() ->> 'client_id', '')::uuid
              else null end;
$$;

create or replace function public.auth_scope(p_module text)
returns access_scope language sql stable security definer set search_path = public as $$
  select case
           when public.is_founder() then 'ALL'::access_scope
           else coalesce(
             nullif(public.auth_ctx() -> 'scopes' ->> p_module, '')::access_scope,
             'NONE'::access_scope)
         end;
$$;

comment on function public.auth_scope(text) is
  'ALL | SUBTREE | TEAM | OWN | CLIENT_PORTAL | NONE for the given module. Founders short-circuit to ALL so no matrix edit can lock them out.';

-- Edit rights are a subset of view rights, and approving is separate
-- from editing — both are enforced here rather than in the UI.
create or replace function public.auth_can(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           when public.is_founder() then true
           when not public.auth_is_active() then false
           when p_action = 'view' then coalesce((public.auth_ctx() -> 'perms' -> p_module ->> 'view')::boolean, false)
           else coalesce((public.auth_ctx() -> 'perms' -> p_module ->> 'view')::boolean, false)
                and coalesce((public.auth_ctx() -> 'perms' -> p_module ->> p_action)::boolean, false)
         end;
$$;

comment on function public.auth_can(text, text) is
  'Seeing is not editing: every non-view action additionally requires can_view, so an edit right can never exceed a view right.';

-- ---------------------------------------------------------------------
-- Vertical axis — the reporting tree
-- ---------------------------------------------------------------------
create or replace function public.my_path()
returns ltree language sql stable security definer set search_path = public, extensions as $$
  select nullif(public.auth_ctx() ->> 'path', '')::ltree;
$$;

-- O(1) ancestor test at unlimited depth via the ltree containment index.
create or replace function public.is_in_my_subtree(target_user uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case
           when target_user is null then false
           when public.is_founder() then true
           when target_user = public.auth_user_id() then true
           when public.my_path() is null then false
           else exists (
             select 1 from public.users u
             where u.id = target_user
               and u.path <@ public.my_path()
           )
         end;
$$;

-- Me + everyone beneath me, at any depth.
create or replace function public.my_visible_user_ids()
returns table (id uuid)
language sql stable security definer set search_path = public, extensions as $$
  select u.id
  from public.users u
  where u.deleted_at is null
    and (
      public.is_founder()
      or u.id = public.auth_user_id()
      or (public.my_path() is not null and u.path <@ public.my_path())
    );
$$;

comment on function public.my_visible_user_ids() is
  'The SUBTREE axis. Consumed as `x in (select id from my_visible_user_ids())` so the planner builds one hashed InitPlan per query.';

-- ---------------------------------------------------------------------
-- Horizontal axis — assignment
-- ---------------------------------------------------------------------
-- Clients assigned to me or to anyone in my subtree, by any of the three
-- assignment routes: account manager, client pod membership, or being
-- the manager of one of the client's projects.
create or replace function public.my_client_ids()
returns table (id uuid)
language sql stable security definer set search_path = public, extensions as $$
  with visible_users as (select id from public.my_visible_user_ids())
  select c.id
  from public.clients c
  where c.deleted_at is null
    and (
      public.is_founder()
      or (public.is_client_portal_user() and c.id = public.auth_client_id())
      or c.account_manager_id in (select id from visible_users)
      or exists (
        select 1 from public.client_team_members ctm
        where ctm.client_id = c.id and ctm.user_id in (select id from visible_users)
      )
      or exists (
        select 1 from public.projects p
        where p.client_id = c.id and p.deleted_at is null
          and p.manager_id in (select id from visible_users)
      )
    );
$$;

comment on function public.my_client_ids() is
  'The TEAM axis. A manager sees the clients assigned to them and to their reports, and nothing from a sibling manager''s branch.';

-- Teams I belong to (pod membership, independent of the tree).
create or replace function public.my_team_ids()
returns table (id uuid)
language sql stable security definer set search_path = public as $$
  select tm.team_id
  from public.team_members tm
  where tm.user_id in (select id from public.my_visible_user_ids());
$$;

-- ---------------------------------------------------------------------
-- Reusable row predicates. Every module policy is one of these plus its
-- own OWN-columns, which keeps the union identical across 20 tables.
-- ---------------------------------------------------------------------
create or replace function public.can_see_client(p_client_id uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           when not public.auth_can(p_module, 'view') then false
           when public.auth_scope(p_module) = 'ALL' then true
           when p_client_id is null then false
           when public.is_client_portal_user() then p_client_id = public.auth_client_id()
           when public.auth_scope(p_module) in ('SUBTREE','TEAM')
             then p_client_id in (select id from public.my_client_ids())
           else false
         end;
$$;

create or replace function public.can_see_user_work(p_user_id uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           when not public.auth_can(p_module, 'view') then false
           when public.auth_scope(p_module) = 'ALL' then true
           when p_user_id is null then false
           when p_user_id = public.auth_user_id() then true
           when public.auth_scope(p_module) = 'SUBTREE'
             then p_user_id in (select id from public.my_visible_user_ids())
           else false
         end;
$$;

-- Soft-deleted rows stay invisible to everyone except the Founder tier,
-- whose Recycle Bin is the only place they surface.
create or replace function public.row_is_visible(p_deleted_at timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select p_deleted_at is null or public.is_founder();
$$;

-- ---------------------------------------------------------------------
-- Supabase Auth hook: mirror level + scopes into the JWT so the client
-- can render the right chrome. The DATABASE never trusts these claims
-- for authorization — auth_ctx() always re-reads the tables.
-- ---------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_meta   jsonb := coalesce(v_claims -> 'app_metadata', '{}'::jsonb);
  v_row    record;
begin
  select u.id, r.level, r.code, r.is_external, u.client_id, u.status
    into v_row
    from public.users u join public.roles r on r.id = u.role_id
   where u.auth_id = (event ->> 'user_id')::uuid and u.deleted_at is null;

  if found then
    v_meta := v_meta
      || jsonb_build_object(
           'app_user_id', v_row.id,
           'role_level',  v_row.level,
           'role_code',   v_row.code,
           'is_external', v_row.is_external,
           'client_id',   v_row.client_id,
           'status',      v_row.status
         );
    v_claims := jsonb_set(v_claims, '{app_metadata}', v_meta);
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end $$;

comment on function public.custom_access_token_hook(jsonb) is
  'Convenience claims for the client UI only. Authorization decisions are always re-derived from the tables inside auth_ctx().';

-- ---------------------------------------------------------------------
-- Grants. The service_role key is never shipped to the browser; these
-- grants are what the anon/authenticated roles may call.
-- ---------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.jwt_claims()', 'public.jwt_sub()', 'public.auth_ctx()',
    'public.auth_user_id()', 'public.auth_role_level()', 'public.auth_is_active()',
    'public.is_founder()', 'public.is_client_portal_user()', 'public.auth_client_id()',
    'public.auth_scope(text)', 'public.auth_can(text, text)', 'public.my_path()',
    'public.is_in_my_subtree(uuid)', 'public.my_visible_user_ids()',
    'public.my_client_ids()', 'public.my_team_ids()',
    'public.can_see_client(uuid, text)', 'public.can_see_user_work(uuid, text)',
    'public.row_is_visible(timestamptz)'
  ]
  loop
    begin
      execute format('grant execute on function %s to authenticated, anon', fn);
    exception when undefined_object then
      null;  -- bare Postgres without Supabase roles
    end;
  end loop;
end $$;
