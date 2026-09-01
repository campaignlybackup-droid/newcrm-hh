-- =====================================================================
-- 0014_rls_policies.sql
-- DENY BY DEFAULT. Every table gets RLS enabled AND forced; no data is
-- reachable without an explicit policy below.
--
-- Reading a policy: each SELECT policy is the same union spelled out —
--   ALL          -> founder tier
--   OWN          -> I am the assignee / reviewer / owner / creator / participant
--   SUBTREE      -> the record belongs to someone beneath me in users.path
--   TEAM         -> the record's client is one I (or my subtree) am assigned to
--   CLIENT_PORTAL-> the record belongs to my own client, and is client-facing
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extra predicates the policies lean on
-- ---------------------------------------------------------------------

-- My manager, their manager, and so on. Lets a person see who they
-- report to without opening up sibling branches.
create or replace function public.is_my_ancestor(target_user uuid)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
           when target_user is null or public.my_path() is null then false
           else exists (
             select 1 from public.users u
             where u.id = target_user and public.my_path() <@ u.path
           )
         end;
$$;

-- Clients I can reach ONLY because a specific task or deliverable was
-- assigned to me. This is what lets an editor open the brand kit and
-- brief for their task while the client list itself stays invisible.
create or replace function public.my_task_client_ids()
returns table (id uuid)
language sql stable security definer set search_path = public as $$
  select distinct t.client_id
  from public.tasks t
  where t.client_id is not null
    and t.deleted_at is null
    and (t.assignee_id = public.auth_user_id() or t.reviewer_id = public.auth_user_id())
  union
  select distinct d.client_id
  from public.deliverables d
  where d.client_id is not null
    and d.deleted_at is null
    and (d.owner_id = public.auth_user_id() or d.reviewer_id = public.auth_user_id())
  union
  select distinct s.client_id
  from public.shoots s
  join public.shoot_crew sc on sc.shoot_id = s.id
  where s.deleted_at is null and sc.user_id = public.auth_user_id();
$$;

comment on function public.my_task_client_ids() is
  'Task-scoped client reach. Levels 0-5 use it to read the brand kit and brief behind their own work; level 6 (intern/freelancer) is excluded by can_see_brand_kit().';

-- Interns and freelancers get the task and its attachments — never the
-- client master record or its brand kit.
create or replace function public.can_see_brand_kit(p_client_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
           when p_client_id is null then false
           -- The portal shows deliverables, calendar, approvals and schedule.
           -- The brand kit is an internal working document and is not among them.
           when public.is_client_portal_user() then false
           when public.can_see_client(p_client_id, 'clients') then true
           when public.auth_role_level() >= 6 then false          -- intern / freelancer
           else p_client_id in (select id from public.my_task_client_ids())
         end;
$$;

-- A policy expression is permission-checked when the statement is PLANNED,
-- not when a branch is reached. So a policy that names a table the acting
-- role has no grant on fails outright — even for a role whose branch of
-- the OR never touches it. Every cross-table reach in a policy is
-- therefore a SECURITY DEFINER predicate, which reads with the definer's
-- rights and keeps the policy itself dependent only on its own table.
create or replace function public.i_have_a_task_on_deliverable(p_deliverable_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t
    where t.deliverable_id = p_deliverable_id
      and t.deleted_at is null
      and (t.assignee_id = public.auth_user_id() or t.reviewer_id = public.auth_user_id())
  );
$$;

-- Do this person and I sit on the same client pod?
create or replace function public.shares_client_pod_with(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.client_team_members mine
    join public.client_team_members theirs on theirs.client_id = mine.client_id
    where mine.user_id = public.auth_user_id() and theirs.user_id = p_user_id
  );
$$;

-- Am I a participant on this meeting?
create or replace function public.is_meeting_participant(p_meeting_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.meeting_attendees ma
    where ma.meeting_id = p_meeting_id and ma.user_id = public.auth_user_id()
  );
$$;

-- Am I crew on this shoot?
--
-- shoots and shoot_crew reference each other from their policies, which
-- is a recursion the planner refuses to resolve. Both directions are
-- therefore expressed as SECURITY DEFINER predicates: the function reads
-- the other table with the definer's rights, so the other table's policy
-- is never re-entered.
create or replace function public.is_shoot_crew(p_shoot_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shoot_crew sc
    where sc.shoot_id = p_shoot_id and sc.user_id = public.auth_user_id()
  );
$$;

create or replace function public.shoot_has_crew_in_my_subtree(p_shoot_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shoot_crew sc
    where sc.shoot_id = p_shoot_id
      and sc.user_id in (select id from public.my_visible_user_ids())
  );
$$;

-- The whole shoots visibility rule, callable from shoot_crew's policy.
create or replace function public.can_see_shoot(p_shoot_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shoots s
    where s.id = p_shoot_id
      and s.deleted_at is null
      and (
        (public.is_client_portal_user() and s.client_id = public.auth_client_id())
        or (public.auth_can('shoots','view') and (
          public.auth_scope('shoots') = 'ALL'
          or s.director_id = public.auth_user_id()
          or s.producer_id = public.auth_user_id()
          or s.created_by  = public.auth_user_id()
          or public.is_shoot_crew(s.id)
          or (public.auth_scope('shoots') = 'SUBTREE' and (
                s.director_id in (select id from public.my_visible_user_ids())
                or public.shoot_has_crew_in_my_subtree(s.id)))
          or (public.auth_scope('shoots') in ('SUBTREE','TEAM')
              and s.client_id in (select id from public.my_client_ids()))
        ))
      )
  );
$$;

-- Can I reach the parent task of a checklist item / attachment?
create or replace function public.can_see_task(p_task_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and t.deleted_at is null
      and public.auth_can('tasks', 'view')
      and (
        public.auth_scope('tasks') = 'ALL'
        or t.assignee_id = public.auth_user_id()
        or t.reviewer_id = public.auth_user_id()
        or t.created_by  = public.auth_user_id()
        or (public.auth_scope('tasks') = 'SUBTREE' and t.assignee_id in (select id from public.my_visible_user_ids()))
        or (public.auth_scope('tasks') in ('SUBTREE','TEAM') and t.client_id in (select id from public.my_client_ids()))
      )
  );
$$;

create or replace function public.can_see_deliverable(p_deliverable_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.deliverables d
    where d.id = p_deliverable_id
      and d.deleted_at is null
      and (
        (public.is_client_portal_user() and d.client_id = public.auth_client_id())
        or (
          public.auth_can('deliverables', 'view') and (
            public.auth_scope('deliverables') = 'ALL'
            or d.owner_id = public.auth_user_id()
            or d.reviewer_id = public.auth_user_id()
            or d.created_by = public.auth_user_id()
            or (public.auth_scope('deliverables') = 'SUBTREE' and d.owner_id in (select id from public.my_visible_user_ids()))
            or (public.auth_scope('deliverables') in ('SUBTREE','TEAM') and d.client_id in (select id from public.my_client_ids()))
          )
        )
      )
  );
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.is_my_ancestor(uuid)', 'public.my_task_client_ids()', 'public.can_see_brand_kit(uuid)',
    'public.is_meeting_participant(uuid)', 'public.is_shoot_crew(uuid)',
    'public.shoot_has_crew_in_my_subtree(uuid)', 'public.can_see_shoot(uuid)',
    'public.i_have_a_task_on_deliverable(uuid)', 'public.shares_client_pod_with(uuid)',
    'public.can_see_task(uuid)', 'public.can_see_deliverable(uuid)'
  ] loop
    begin
      execute format('grant execute on function %s to authenticated, anon', fn);
    exception when undefined_object then null; end;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- A dedicated database role for the client portal.
--
-- Internal staff and client users are both "authenticated" in stock
-- Supabase, which makes column-level grants useless. The access-token
-- hook stamps role='client_portal' for external users so PostgREST
-- switches into this role, which simply has no privilege on internal
-- tables. That is what makes "a raw API request with their token returns
-- no internal fields" true at the wire level, not just in the UI.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'client_portal') then
    create role client_portal nologin noinherit;
  end if;
exception when insufficient_privilege then
  raise notice 'skipping client_portal role creation (insufficient privilege)';
end $$;

do $$
begin
  execute 'grant usage on schema public to client_portal';
  -- Let PostgREST switch into it.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant client_portal to authenticator';
  end if;
exception when others then
  raise notice 'client_portal grants skipped: %', sqlerrm;
end $$;

-- Teach the token hook to emit the role.
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
    v_meta := v_meta || jsonb_build_object(
      'app_user_id', v_row.id, 'role_level', v_row.level, 'role_code', v_row.code,
      'is_external', v_row.is_external, 'client_id', v_row.client_id, 'status', v_row.status);
    v_claims := jsonb_set(v_claims, '{app_metadata}', v_meta);

    if v_row.is_external then
      v_claims := jsonb_set(v_claims, '{role}', '"client_portal"'::jsonb);
    end if;
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end $$;

-- ---------------------------------------------------------------------
-- Enable + FORCE RLS everywhere, and revoke the blanket grants Supabase
-- hands out. Nothing is readable until a policy says so.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('alter table public.%I force row level security', r.relname);
  end loop;
end $$;

-- =====================================================================
-- POLICIES
-- =====================================================================

-- ---------------------------------------------------------------------
-- Reference data everyone needs to render the UI
-- ---------------------------------------------------------------------
drop policy if exists modules_select on public.modules;
create policy modules_select on public.modules for select
  using (public.auth_user_id() is not null);

drop policy if exists modules_write on public.modules;
create policy modules_write on public.modules for all
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments for select
  using ((deleted_at is null or (select public.is_founder())) and (select public.auth_user_id()) is not null and not (select public.is_client_portal_user()));

drop policy if exists departments_write on public.departments;
create policy departments_write on public.departments for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select
  using ((deleted_at is null or (select public.is_founder())) and (select public.auth_user_id()) is not null and not (select public.is_client_portal_user()));

drop policy if exists roles_write on public.roles;
create policy roles_write on public.roles for all
  using (public.is_founder()) with check (public.is_founder());

-- The permission matrix is a Founder-only editable grid.
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select
  using (public.auth_user_id() is not null and not (select public.is_client_portal_user()));

drop policy if exists role_permissions_write on public.role_permissions;
create policy role_permissions_write on public.role_permissions for all
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists user_permission_overrides_select on public.user_permission_overrides;
create policy user_permission_overrides_select on public.user_permission_overrides for select
  using (user_id = (select public.auth_user_id()) or public.is_in_my_subtree(user_id));

drop policy if exists user_permission_overrides_write on public.user_permission_overrides;
create policy user_permission_overrides_write on public.user_permission_overrides for all
  using (public.is_founder()) with check (public.is_founder());

drop policy if exists audited_tables_select on public.audited_tables;
create policy audited_tables_select on public.audited_tables for select
  using (public.auth_user_id() is not null);

drop policy if exists holidays_select on public.holidays;
create policy holidays_select on public.holidays for select
  using (public.auth_user_id() is not null);

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

-- ---------------------------------------------------------------------
-- users (module: people)
-- Self + subtree + my management chain + people I share a client pod
-- with. A sibling manager's branch is invisible. Portal users see no
-- internal staff at all.
-- ---------------------------------------------------------------------
drop policy if exists users_select on public.users;
create policy users_select on public.users for select using (
  (deleted_at is null or (select public.is_founder()))
  and case
        when (select public.is_client_portal_user()) then id = (select public.auth_user_id())
        else (
          (select public.auth_scope('people')) = 'ALL'
          or id = (select public.auth_user_id())
          or public.is_in_my_subtree(id)
          or public.is_my_ancestor(id)
          or public.shares_client_pod_with(id)
        )
      end
);

drop policy if exists users_insert on public.users;
create policy users_insert on public.users for insert with check (
  (select public.auth_can('people','create'))
  and (public.auth_scope('people') = 'ALL' or manager_id in (select id from public.my_visible_user_ids()))
);

drop policy if exists users_update on public.users;
create policy users_update on public.users for update using (
  (select public.auth_can('people','edit'))
  and (public.auth_scope('people') = 'ALL' or id = (select public.auth_user_id()) or public.is_in_my_subtree(id))
) with check (
  (select public.auth_can('people','edit'))
  and (public.auth_scope('people') = 'ALL' or id = (select public.auth_user_id()) or public.is_in_my_subtree(id))
);

drop policy if exists users_delete on public.users;
create policy users_delete on public.users for delete using (public.is_founder());

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select using (
  (deleted_at is null or (select public.is_founder())) and not (select public.is_client_portal_user()) and (
    (select public.auth_scope('people')) = 'ALL'
    or lead_user_id = (select public.auth_user_id())
    or id in (select id from public.my_team_ids())
  )
);
drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams for all
  using (public.auth_can('people','edit')) with check (public.auth_can('people','edit'));

drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members for select using (
  not (select public.is_client_portal_user()) and (
    (select public.auth_scope('people')) = 'ALL'
    or user_id = (select public.auth_user_id())
    or team_id in (select id from public.my_team_ids())
    or public.is_in_my_subtree(user_id)
  )
);
drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members for all
  using (public.auth_can('people','assign')) with check (public.auth_can('people','assign'));

-- ---------------------------------------------------------------------
-- clients + the records typed once and rendered everywhere
-- ---------------------------------------------------------------------
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select using (
  (deleted_at is null or (select public.is_founder()))
  and (
    (public.is_client_portal_user() and id = (select public.auth_client_id()))
    or public.can_see_client(id, 'clients')
    or account_manager_id = (select public.auth_user_id())
    or created_by = (select public.auth_user_id())
  )
);

drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert
  with check (public.auth_can('clients','create'));

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update
  using (public.auth_can('clients','edit') and public.can_see_client(id, 'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(id, 'clients'));

drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete using (public.is_founder());

-- Brand kit: reachable by anyone with a task on that client (except
-- interns/freelancers), and by the client's own portal users.
drop policy if exists client_brand_kit_select on public.client_brand_kit;
create policy client_brand_kit_select on public.client_brand_kit for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_brand_kit(client_id));

drop policy if exists client_brand_kit_write on public.client_brand_kit;
create policy client_brand_kit_write on public.client_brand_kit for all
  using (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'));

drop policy if exists client_contacts_select on public.client_contacts;
create policy client_contacts_select on public.client_contacts for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_client(client_id, 'clients'));
drop policy if exists client_contacts_write on public.client_contacts;
create policy client_contacts_write on public.client_contacts for all
  using (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'));

drop policy if exists client_social_accounts_select on public.client_social_accounts;
create policy client_social_accounts_select on public.client_social_accounts for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_client(client_id, 'clients'));
drop policy if exists client_social_accounts_write on public.client_social_accounts;
create policy client_social_accounts_write on public.client_social_accounts for all
  using (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'));

drop policy if exists client_service_scope_select on public.client_service_scope;
create policy client_service_scope_select on public.client_service_scope for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_client(client_id, 'clients'));
drop policy if exists client_service_scope_write on public.client_service_scope;
create policy client_service_scope_write on public.client_service_scope for all
  using (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'));

drop policy if exists client_documents_select on public.client_documents;
create policy client_documents_select on public.client_documents for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_client(client_id, 'clients')
         and not (select public.is_client_portal_user()));
drop policy if exists client_documents_write on public.client_documents;
create policy client_documents_write on public.client_documents for all
  using (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','edit') and public.can_see_client(client_id,'clients'));

drop policy if exists client_team_members_select on public.client_team_members;
create policy client_team_members_select on public.client_team_members for select
  using (not (select public.is_client_portal_user())
         and (user_id = (select public.auth_user_id()) or public.can_see_client(client_id, 'clients')));
drop policy if exists client_team_members_write on public.client_team_members;
create policy client_team_members_write on public.client_team_members for all
  using (public.auth_can('clients','assign') and public.can_see_client(client_id,'clients'))
  with check (public.auth_can('clients','assign') and public.can_see_client(client_id,'clients'));

drop policy if exists content_pillars_select on public.content_pillars;
create policy content_pillars_select on public.content_pillars for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_brand_kit(client_id));
drop policy if exists content_pillars_write on public.content_pillars;
create policy content_pillars_write on public.content_pillars for all
  using (public.auth_can('content_calendar','edit') and public.can_see_client(client_id,'content_calendar'))
  with check (public.auth_can('content_calendar','edit') and public.can_see_client(client_id,'content_calendar'));

-- ---------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select using (
  (deleted_at is null or (select public.is_founder())) and not (select public.is_client_portal_user()) and (select public.auth_can('leads','view')) and (
    (select public.auth_scope('leads')) = 'ALL'
    or owner_id = (select public.auth_user_id())
    or created_by = (select public.auth_user_id())
    or (public.auth_scope('leads') = 'SUBTREE' and owner_id in (select id from public.my_visible_user_ids()))
  )
);
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads for insert with check (public.auth_can('leads','create'));
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads for update
  using (public.auth_can('leads','edit') and (
    (select public.auth_scope('leads')) = 'ALL' or owner_id = (select public.auth_user_id())
    or owner_id in (select id from public.my_visible_user_ids())))
  with check (public.auth_can('leads','edit'));
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads for delete using (public.is_founder());

drop policy if exists lead_activities_select on public.lead_activities;
create policy lead_activities_select on public.lead_activities for select using (
  (deleted_at is null or (select public.is_founder())) and exists (
    select 1 from public.leads l where l.id = lead_id
      and (public.auth_scope('leads') = 'ALL'
           or l.owner_id = (select public.auth_user_id())
           or l.owner_id in (select id from public.my_visible_user_ids()))
  )
);
drop policy if exists lead_activities_write on public.lead_activities;
create policy lead_activities_write on public.lead_activities for all
  using (public.auth_can('leads','edit')) with check (public.auth_can('leads','edit'));

-- ---------------------------------------------------------------------
-- Delivery: projects / cycles / deliverables / tasks
-- ---------------------------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('projects','view') and (
      (select public.auth_scope('projects')) = 'ALL'
      or manager_id = (select public.auth_user_id())
      or created_by = (select public.auth_user_id())
      or (public.auth_scope('projects') = 'SUBTREE' and manager_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('projects') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert
  with check (public.auth_can('projects','create') and public.can_see_client(client_id,'clients'));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update
  using (public.auth_can('projects','edit') and (
    (select public.auth_scope('projects')) = 'ALL' or manager_id = (select public.auth_user_id())
    or manager_id in (select id from public.my_visible_user_ids())
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('projects','edit'));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete using (public.is_founder());

drop policy if exists retainer_cycles_select on public.retainer_cycles;
create policy retainer_cycles_select on public.retainer_cycles for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('projects','view') and (
      (select public.auth_scope('projects')) = 'ALL'
      or client_id in (select id from public.my_client_ids())
      or exists (select 1 from public.projects p where p.id = project_id
                   and (p.manager_id = (select public.auth_user_id())
                        or p.manager_id in (select id from public.my_visible_user_ids())))
    ))
  )
);
drop policy if exists retainer_cycles_write on public.retainer_cycles;
create policy retainer_cycles_write on public.retainer_cycles for all
  using (public.auth_can('projects','edit') and public.can_see_client(client_id,'projects'))
  with check (public.auth_can('projects','edit') and public.can_see_client(client_id,'projects'));

drop policy if exists deliverables_select on public.deliverables;
create policy deliverables_select on public.deliverables for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('deliverables','view') and (
      (select public.auth_scope('deliverables')) = 'ALL'
      or owner_id    = (select public.auth_user_id())
      or reviewer_id = (select public.auth_user_id())
      or created_by  = (select public.auth_user_id())
      -- An executor reaches the deliverable behind a task assigned to them.
      or public.i_have_a_task_on_deliverable(id)
      or (public.auth_scope('deliverables') = 'SUBTREE'
          and owner_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('deliverables') in ('SUBTREE','TEAM')
          and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists deliverables_insert on public.deliverables;
create policy deliverables_insert on public.deliverables for insert
  with check (public.auth_can('deliverables','create') and public.can_see_client(client_id,'deliverables'));
drop policy if exists deliverables_update on public.deliverables;
create policy deliverables_update on public.deliverables for update
  using (public.auth_can('deliverables','edit') and (
    (select public.auth_scope('deliverables')) = 'ALL'
    or owner_id = (select public.auth_user_id()) or reviewer_id = (select public.auth_user_id())
    or owner_id in (select id from public.my_visible_user_ids())
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('deliverables','edit'));
drop policy if exists deliverables_delete on public.deliverables;
create policy deliverables_delete on public.deliverables for delete using (public.is_founder());

-- The canonical policy from the spec, plus the portal exclusion.
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select using (
  (deleted_at is null or (select public.is_founder()))
  and not (select public.is_client_portal_user())
  and (select public.auth_can('tasks','view'))
  and (
    (select public.auth_scope('tasks')) = 'ALL'
    or assignee_id = (select public.auth_user_id())
    or reviewer_id = (select public.auth_user_id())
    or created_by  = (select public.auth_user_id())
    or (public.auth_scope('tasks') = 'SUBTREE' and assignee_id in (select id from public.my_visible_user_ids()))
    or (public.auth_scope('tasks') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
  )
);
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert with check (
  (select public.auth_can('tasks','create'))
  and (client_id is null or public.can_see_client(client_id,'tasks')
       or client_id in (select id from public.my_task_client_ids()))
);
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update using (
  (select public.auth_can('tasks','edit')) and (
    (select public.auth_scope('tasks')) = 'ALL'
    or assignee_id = (select public.auth_user_id())
    or reviewer_id = (select public.auth_user_id())
    or created_by  = (select public.auth_user_id())
    or (public.auth_scope('tasks') = 'SUBTREE' and assignee_id in (select id from public.my_visible_user_ids()))
    or (public.auth_scope('tasks') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
  )
) with check (public.auth_can('tasks','edit'));
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete using (public.is_founder());

drop policy if exists task_dependencies_select on public.task_dependencies;
create policy task_dependencies_select on public.task_dependencies for select
  using (public.can_see_task(predecessor_id) or public.can_see_task(successor_id));
drop policy if exists task_dependencies_write on public.task_dependencies;
create policy task_dependencies_write on public.task_dependencies for all
  using (public.auth_can('tasks','edit') and public.can_see_task(successor_id))
  with check (public.auth_can('tasks','edit') and public.can_see_task(successor_id));

drop policy if exists checklist_items_select on public.checklist_items;
create policy checklist_items_select on public.checklist_items for select
  using ((deleted_at is null or (select public.is_founder())) and public.can_see_task(task_id));
drop policy if exists checklist_items_write on public.checklist_items;
create policy checklist_items_write on public.checklist_items for all
  using (public.auth_can('tasks','edit') and public.can_see_task(task_id))
  with check (public.auth_can('tasks','edit') and public.can_see_task(task_id));

drop policy if exists revisions_select on public.revisions;
create policy revisions_select on public.revisions for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or public.can_see_deliverable(deliverable_id)
  )
);
drop policy if exists revisions_write on public.revisions;
create policy revisions_write on public.revisions for all
  using (public.auth_can('deliverables','edit') and public.can_see_deliverable(deliverable_id))
  with check (public.auth_can('deliverables','edit') and public.can_see_deliverable(deliverable_id));

-- ---------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------
drop policy if exists shoots_select on public.shoots;
create policy shoots_select on public.shoots for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('shoots','view') and (
      (select public.auth_scope('shoots')) = 'ALL'
      or director_id = (select public.auth_user_id())
      or producer_id = (select public.auth_user_id())
      or created_by  = (select public.auth_user_id())
      or public.is_shoot_crew(id)
      or (public.auth_scope('shoots') = 'SUBTREE' and (
            director_id in (select id from public.my_visible_user_ids())
            or public.shoot_has_crew_in_my_subtree(id)))
      or (public.auth_scope('shoots') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists shoots_insert on public.shoots;
create policy shoots_insert on public.shoots for insert
  with check (public.auth_can('shoots','create') and public.can_see_client(client_id,'shoots'));
drop policy if exists shoots_update on public.shoots;
create policy shoots_update on public.shoots for update
  using (public.auth_can('shoots','edit') and (
    (select public.auth_scope('shoots')) = 'ALL' or director_id = (select public.auth_user_id())
    or producer_id = (select public.auth_user_id())
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('shoots','edit'));
drop policy if exists shoots_delete on public.shoots;
create policy shoots_delete on public.shoots for delete using (public.is_founder());

drop policy if exists shoot_crew_select on public.shoot_crew;
create policy shoot_crew_select on public.shoot_crew for select
  using (not (select public.is_client_portal_user())
         and (user_id = (select public.auth_user_id())
              or public.is_in_my_subtree(user_id)
              or public.can_see_shoot(shoot_id)));
drop policy if exists shoot_crew_write on public.shoot_crew;
create policy shoot_crew_write on public.shoot_crew for all
  using (public.auth_can('shoots','assign')) with check (public.auth_can('shoots','assign'));

drop policy if exists shot_lists_select on public.shot_lists;
create policy shot_lists_select on public.shot_lists for select
  using ((deleted_at is null or (select public.is_founder()))
         and (client_id is null or public.can_see_brand_kit(client_id)));
drop policy if exists shot_lists_write on public.shot_lists;
create policy shot_lists_write on public.shot_lists for all
  using (public.auth_can('shoots','edit')) with check (public.auth_can('shoots','edit'));

drop policy if exists shot_list_items_select on public.shot_list_items;
create policy shot_list_items_select on public.shot_list_items for select
  using ((deleted_at is null or (select public.is_founder()))
         and exists (select 1 from public.shot_lists sl where sl.id = shot_list_id));
drop policy if exists shot_list_items_write on public.shot_list_items;
create policy shot_list_items_write on public.shot_list_items for all
  using (public.auth_can('shoots','edit')) with check (public.auth_can('shoots','edit'));

drop policy if exists equipment_select on public.equipment;
create policy equipment_select on public.equipment for select
  using ((deleted_at is null or (select public.is_founder())) and (select public.auth_can('equipment','view'))
         and not (select public.is_client_portal_user()));
drop policy if exists equipment_write on public.equipment;
create policy equipment_write on public.equipment for all
  using (public.auth_can('equipment','edit')) with check (public.auth_can('equipment','edit'));

drop policy if exists equipment_bookings_select on public.equipment_bookings;
create policy equipment_bookings_select on public.equipment_bookings for select
  using ((deleted_at is null or (select public.is_founder())) and (select public.auth_can('equipment','view'))
         and not (select public.is_client_portal_user()));
drop policy if exists equipment_bookings_write on public.equipment_bookings;
create policy equipment_bookings_write on public.equipment_bookings for all
  using (public.auth_can('equipment','edit')) with check (public.auth_can('equipment','edit'));

-- ---------------------------------------------------------------------
-- Social
-- ---------------------------------------------------------------------
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('campaigns','view') and (
      (select public.auth_scope('campaigns')) = 'ALL'
      or owner_id = (select public.auth_user_id())
      or created_by = (select public.auth_user_id())
      or (public.auth_scope('campaigns') = 'SUBTREE' and owner_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('campaigns') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns for all
  using (public.auth_can('campaigns','edit') and public.can_see_client(client_id,'campaigns'))
  with check (public.auth_can('campaigns','edit') and public.can_see_client(client_id,'campaigns'));

drop policy if exists content_calendar_select on public.content_calendar;
create policy content_calendar_select on public.content_calendar for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()))
    or (public.auth_can('content_calendar','view') and (
      (select public.auth_scope('content_calendar')) = 'ALL'
      or owner_id    = (select public.auth_user_id())
      or reviewer_id = (select public.auth_user_id())
      or created_by  = (select public.auth_user_id())
      or (public.auth_scope('content_calendar') = 'SUBTREE'
          and owner_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('content_calendar') in ('SUBTREE','TEAM')
          and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists content_calendar_insert on public.content_calendar;
create policy content_calendar_insert on public.content_calendar for insert
  with check (public.auth_can('content_calendar','create') and public.can_see_client(client_id,'content_calendar'));
drop policy if exists content_calendar_update on public.content_calendar;
create policy content_calendar_update on public.content_calendar for update
  using (public.auth_can('content_calendar','edit') and (
    (select public.auth_scope('content_calendar')) = 'ALL' or owner_id = (select public.auth_user_id())
    or reviewer_id = (select public.auth_user_id())
    or owner_id in (select id from public.my_visible_user_ids())
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('content_calendar','edit'));
drop policy if exists content_calendar_delete on public.content_calendar;
create policy content_calendar_delete on public.content_calendar for delete using (public.is_founder());

-- ---------------------------------------------------------------------
-- Assets & approvals
-- ---------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()) and is_client_visible)
    or (public.auth_can('assets','view') and (
      (select public.auth_scope('assets')) = 'ALL'
      or uploaded_by = (select public.auth_user_id())
      or created_by  = (select public.auth_user_id())
      or (task_id is not null and public.can_see_task(task_id))
      or (deliverable_id is not null and public.can_see_deliverable(deliverable_id))
      or (public.auth_scope('assets') in ('SUBTREE','TEAM') and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists assets_insert on public.assets;
create policy assets_insert on public.assets for insert with check (
  (select public.auth_can('assets','create'))
  and (public.can_see_client(client_id,'assets')
       or client_id in (select id from public.my_task_client_ids()))
);
drop policy if exists assets_update on public.assets;
create policy assets_update on public.assets for update
  using (public.auth_can('assets','edit') and (
    (select public.auth_scope('assets')) = 'ALL' or uploaded_by = (select public.auth_user_id())
    or (task_id is not null and public.can_see_task(task_id))
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('assets','edit'));
drop policy if exists assets_delete on public.assets;
create policy assets_delete on public.assets for delete using (public.is_founder());

drop policy if exists asset_versions_select on public.asset_versions;
create policy asset_versions_select on public.asset_versions for select
  using (exists (select 1 from public.assets a where a.id = asset_id));
drop policy if exists asset_versions_insert on public.asset_versions;
create policy asset_versions_insert on public.asset_versions for insert
  with check (public.auth_can('assets','create'));

drop policy if exists approval_chains_select on public.approval_chains;
create policy approval_chains_select on public.approval_chains for select
  using (not (select public.is_client_portal_user())
         and (client_id is null or public.can_see_client(client_id,'approvals')));
drop policy if exists approval_chains_write on public.approval_chains;
create policy approval_chains_write on public.approval_chains for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()) and level = 'Client')
    or (public.auth_can('approvals','view') and (
      (select public.auth_scope('approvals')) = 'ALL'
      or approver_id  = (select public.auth_user_id())
      or requested_by = (select public.auth_user_id())
      or (public.auth_scope('approvals') = 'SUBTREE'
          and approver_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('approvals') in ('SUBTREE','TEAM')
          and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists approvals_insert on public.approvals;
create policy approvals_insert on public.approvals for insert
  with check (public.auth_can('approvals','create') or requested_by = (select public.auth_user_id()));
-- Deciding an approval is gated on can_approve, which is a distinct
-- permission from can_edit. trg_approvals_require_approve_permission
-- enforces the decision itself; this policy scopes who may touch the row.
drop policy if exists approvals_update on public.approvals;
create policy approvals_update on public.approvals for update
  using (approver_id = (select public.auth_user_id())
         or requested_by = (select public.auth_user_id())
         or (select public.auth_scope('approvals')) = 'ALL'
         or (public.auth_scope('approvals') = 'SUBTREE'
             and approver_id in (select id from public.my_visible_user_ids())))
  with check (true);
drop policy if exists approvals_delete on public.approvals;
create policy approvals_delete on public.approvals for delete using (public.is_founder());

drop policy if exists approval_feedback_revisions_select on public.approval_feedback_revisions;
create policy approval_feedback_revisions_select on public.approval_feedback_revisions for select
  using (exists (select 1 from public.approvals a where a.id = approval_id));
drop policy if exists approval_feedback_revisions_insert on public.approval_feedback_revisions;
create policy approval_feedback_revisions_insert on public.approval_feedback_revisions for insert
  with check (true);

-- ---------------------------------------------------------------------
-- Meetings, action items, reports, comments, notifications
-- ---------------------------------------------------------------------
drop policy if exists meetings_select on public.meetings;
create policy meetings_select on public.meetings for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()) and type <> 'Internal')
    or (public.auth_can('meetings','view') and (
      (select public.auth_scope('meetings')) = 'ALL'
      or organiser_id = (select public.auth_user_id())
      or created_by   = (select public.auth_user_id())
      or public.is_meeting_participant(id)
      or (public.auth_scope('meetings') = 'SUBTREE'
          and organiser_id in (select id from public.my_visible_user_ids()))
      or (public.auth_scope('meetings') in ('SUBTREE','TEAM')
          and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists meetings_write on public.meetings;
create policy meetings_write on public.meetings for all
  using (public.auth_can('meetings','edit') and (
    (select public.auth_scope('meetings')) = 'ALL' or organiser_id = (select public.auth_user_id())
    or public.is_meeting_participant(id)
    or client_id in (select id from public.my_client_ids())))
  with check (public.auth_can('meetings','edit'));

drop policy if exists meeting_attendees_select on public.meeting_attendees;
create policy meeting_attendees_select on public.meeting_attendees for select
  using (exists (select 1 from public.meetings m where m.id = meeting_id));
drop policy if exists meeting_attendees_write on public.meeting_attendees;
create policy meeting_attendees_write on public.meeting_attendees for all
  using (public.auth_can('meetings','edit')) with check (public.auth_can('meetings','edit'));

drop policy if exists action_items_select on public.action_items;
create policy action_items_select on public.action_items for select using (
  (deleted_at is null or (select public.is_founder())) and (
    owner_id = (select public.auth_user_id())
    or exists (select 1 from public.meetings m where m.id = meeting_id)
  )
);
drop policy if exists action_items_write on public.action_items;
create policy action_items_write on public.action_items for all
  using (public.auth_can('meetings','edit')) with check (public.auth_can('meetings','edit'));

drop policy if exists client_reports_select on public.client_reports;
create policy client_reports_select on public.client_reports for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id())
     and approval_status = 'Approved' and shared_at is not null)
    or (public.auth_can('reports','view') and (
      (select public.auth_scope('reports')) = 'ALL'
      or owner_id = (select public.auth_user_id())
      or created_by = (select public.auth_user_id())
      or (public.auth_scope('reports') in ('SUBTREE','TEAM')
          and client_id in (select id from public.my_client_ids()))
    ))
  )
);
drop policy if exists client_reports_write on public.client_reports;
create policy client_reports_write on public.client_reports for all
  using (public.auth_can('reports','edit') and public.can_see_client(client_id,'reports'))
  with check (public.auth_can('reports','edit') and public.can_see_client(client_id,'reports'));

-- Internal comments never reach the portal.
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()) and not is_internal)
    or (not (select public.is_client_portal_user()) and (
      author_id = (select public.auth_user_id())
      or (select public.auth_user_id()) = any (mentions)
      or (select public.auth_scope('clients')) = 'ALL'
      or (client_id is not null and client_id in (select id from public.my_client_ids()))
      or (entity_type = 'tasks' and public.can_see_task(entity_id))
      or (entity_type = 'deliverables' and public.can_see_deliverable(entity_id))
    ))
  )
);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (author_id = (select public.auth_user_id())
              and (not (select public.is_client_portal_user()) or (client_id = (select public.auth_client_id()) and not is_internal)));
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update
  using (author_id = (select public.auth_user_id())) with check (author_id = (select public.auth_user_id()));
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete using (public.is_founder());

drop policy if exists comment_revisions_select on public.comment_revisions;
create policy comment_revisions_select on public.comment_revisions for select
  using (exists (select 1 from public.comments c where c.id = comment_id));
drop policy if exists comment_revisions_insert on public.comment_revisions;
create policy comment_revisions_insert on public.comment_revisions for insert with check (true);

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using (user_id = (select public.auth_user_id()));
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update
  using (user_id = (select public.auth_user_id())) with check (user_id = (select public.auth_user_id()));
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert with check (true);

-- ---------------------------------------------------------------------
-- People ops
-- ---------------------------------------------------------------------
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests for select using (
  (deleted_at is null or (select public.is_founder())) and not (select public.is_client_portal_user()) and (
    user_id = (select public.auth_user_id())
    or approver_id = (select public.auth_user_id())
    or (select public.auth_scope('leaves')) = 'ALL'
    or (public.auth_scope('leaves') = 'SUBTREE' and public.is_in_my_subtree(user_id))
    -- Everyone can see WHO is away (calendars grey them out) but the
    -- reason column is masked for non-managers by v_team_availability.
    or (public.auth_can('leaves','view') and status = 'Approved')
  )
);
drop policy if exists leave_requests_insert on public.leave_requests;
create policy leave_requests_insert on public.leave_requests for insert
  with check (user_id = (select public.auth_user_id()) or (select public.auth_can('leaves','create')));
drop policy if exists leave_requests_update on public.leave_requests;
create policy leave_requests_update on public.leave_requests for update
  using ((user_id = (select public.auth_user_id()) and status = 'Requested')
         or approver_id = (select public.auth_user_id())
         or public.is_in_my_subtree(user_id)
         or (select public.auth_scope('leaves')) = 'ALL')
  with check (true);
drop policy if exists leave_requests_delete on public.leave_requests;
create policy leave_requests_delete on public.leave_requests for delete using (public.is_founder());

drop policy if exists availability_select on public.availability;
create policy availability_select on public.availability for select
  using (not (select public.is_client_portal_user())
         and (user_id = (select public.auth_user_id()) or public.is_in_my_subtree(user_id)
              or (select public.auth_scope('people')) = 'ALL'));
drop policy if exists availability_write on public.availability;
create policy availability_write on public.availability for all
  using (user_id = (select public.auth_user_id()) or (select public.auth_can('people','edit')))
  with check (user_id = (select public.auth_user_id()) or (select public.auth_can('people','edit')));

drop policy if exists onboarding_checklists_select on public.onboarding_checklists;
create policy onboarding_checklists_select on public.onboarding_checklists for select
  using ((deleted_at is null or (select public.is_founder()))
         and (user_id = (select public.auth_user_id()) or owner_id = (select public.auth_user_id())
              or public.is_in_my_subtree(user_id) or (select public.auth_scope('people')) = 'ALL'));
drop policy if exists onboarding_checklists_write on public.onboarding_checklists;
create policy onboarding_checklists_write on public.onboarding_checklists for all
  using (user_id = (select public.auth_user_id()) or (select public.auth_can('people','edit')))
  with check (user_id = (select public.auth_user_id()) or (select public.auth_can('people','edit')));

-- Reviews are seen by the subject, the reviewer and the chain above.
drop policy if exists reviews_select on public.reviews;
create policy reviews_select on public.reviews for select
  using ((deleted_at is null or (select public.is_founder())) and not (select public.is_client_portal_user())
         and ((user_id = (select public.auth_user_id()) and status <> 'Draft')
              or reviewer_id = (select public.auth_user_id())
              or public.is_in_my_subtree(user_id)
              or (select public.auth_scope('people')) = 'ALL'));
drop policy if exists reviews_write on public.reviews;
create policy reviews_write on public.reviews for all
  using (reviewer_id = (select public.auth_user_id()) or public.is_in_my_subtree(user_id) or (select public.auth_scope('people')) = 'ALL')
  with check (public.auth_can('people','edit'));

-- ---------------------------------------------------------------------
-- System: templates, SOPs, automation, saved views, tags, attachments
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['project_templates','deliverable_templates','task_templates',
                           'checklist_templates','sops'] loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format($p$create policy %1$s_select on public.%1$I for select
                     using (public.auth_user_id() is not null and not (select public.is_client_portal_user()))$p$, t);
    execute format('drop policy if exists %1$s_write on public.%1$I', t);
    execute format($p$create policy %1$s_write on public.%1$I for all
                     using (public.auth_can('templates','edit'))
                     with check (public.auth_can('templates','edit'))$p$, t);
  end loop;
end $$;

drop policy if exists automation_rules_select on public.automation_rules;
create policy automation_rules_select on public.automation_rules for select
  using ((deleted_at is null or (select public.is_founder())) and (select public.auth_can('settings','view')));
drop policy if exists automation_rules_write on public.automation_rules;
create policy automation_rules_write on public.automation_rules for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

drop policy if exists saved_views_select on public.saved_views;
create policy saved_views_select on public.saved_views for select
  using (user_id = (select public.auth_user_id()) or (is_shared and not (select public.is_client_portal_user())));
drop policy if exists saved_views_write on public.saved_views;
create policy saved_views_write on public.saved_views for all
  using (user_id = (select public.auth_user_id())) with check (user_id = (select public.auth_user_id()));

drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags for select using (public.auth_user_id() is not null);
drop policy if exists tags_write on public.tags;
create policy tags_write on public.tags for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

drop policy if exists entity_tags_select on public.entity_tags;
create policy entity_tags_select on public.entity_tags for select
  using (client_id is null or public.can_see_client(client_id,'clients')
         or client_id in (select id from public.my_task_client_ids()));
drop policy if exists entity_tags_write on public.entity_tags;
create policy entity_tags_write on public.entity_tags for all
  using (public.auth_user_id() is not null and not (select public.is_client_portal_user()))
  with check (public.auth_user_id() is not null and not (select public.is_client_portal_user()));

drop policy if exists custom_fields_select on public.custom_fields;
create policy custom_fields_select on public.custom_fields for select using (public.auth_user_id() is not null);
drop policy if exists custom_fields_write on public.custom_fields;
create policy custom_fields_write on public.custom_fields for all
  using (public.auth_can('settings','edit')) with check (public.auth_can('settings','edit'));

drop policy if exists custom_field_values_select on public.custom_field_values;
create policy custom_field_values_select on public.custom_field_values for select
  using (client_id is null or public.can_see_client(client_id,'clients')
         or client_id in (select id from public.my_task_client_ids()));
drop policy if exists custom_field_values_write on public.custom_field_values;
create policy custom_field_values_write on public.custom_field_values for all
  using (not (select public.is_client_portal_user())) with check (not (select public.is_client_portal_user()));

-- Interns and freelancers reach attachments through their task and
-- nowhere else — this is the only route they have to any client file.
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select using (
  (deleted_at is null or (select public.is_founder())) and (
    (public.is_client_portal_user() and client_id = (select public.auth_client_id()) and is_client_visible)
    or uploaded_by = (select public.auth_user_id())
    or (entity_type = 'tasks' and public.can_see_task(entity_id))
    or (entity_type = 'deliverables' and public.can_see_deliverable(entity_id))
    or (entity_type not in ('tasks','deliverables')
        and client_id is not null and public.can_see_client(client_id,'assets'))
  )
);
drop policy if exists attachments_write on public.attachments;
create policy attachments_write on public.attachments for all
  using (uploaded_by = (select public.auth_user_id()) or (select public.auth_can('assets','edit')))
  with check (uploaded_by = (select public.auth_user_id()) or (select public.auth_can('assets','edit')));

-- ---------------------------------------------------------------------
-- Audit log — readable by whoever can see the underlying client, plus
-- the audit_log module permission. Never writable from the API.
-- ---------------------------------------------------------------------
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select using (
  not (select public.is_client_portal_user()) and (select public.auth_can('audit_log','view')) and (
    (select public.auth_scope('audit_log')) = 'ALL'
    or actor_id = (select public.auth_user_id())
    or (client_id is not null and client_id in (select id from public.my_client_ids()))
    or (public.auth_scope('audit_log') = 'SUBTREE' and actor_id in (select id from public.my_visible_user_ids()))
  )
);
-- No insert policy: rows arrive only through the SECURITY DEFINER audit
-- trigger, which runs as the owner and is not subject to policy.

-- ---------------------------------------------------------------------
-- Grants. anon gets nothing; authenticated is gated entirely by RLS.
-- ---------------------------------------------------------------------
do $$
begin
  execute 'revoke all on all tables in schema public from anon';
  execute 'grant select, insert, update, delete on all tables in schema public to authenticated';
  execute 'revoke insert, update, delete on public.activity_log from authenticated';
  execute 'revoke insert, update, delete on public.asset_versions from authenticated';
  execute 'grant usage, select on all sequences in schema public to authenticated';
exception when undefined_object then
  raise notice 'Supabase roles absent; skipping anon/authenticated grants';
end $$;
