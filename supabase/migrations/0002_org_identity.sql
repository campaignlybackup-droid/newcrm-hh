-- =====================================================================
-- 0002_org_identity.sql
-- Departments, roles, users, the reporting tree, teams and the
-- permission matrix. The hierarchy is DATA, never code: adding a role
-- or a level is an INSERT, not a deploy.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  code          text not null unique,
  description   text,
  head_user_id  uuid,                       -- FK added after users exists
  sort_order    int  not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid
);

-- ---------------------------------------------------------------------
-- Roles — level 0 is the root of authority, higher int = narrower reach
-- ---------------------------------------------------------------------
create table if not exists public.roles (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  code           text not null unique,
  level          int  not null check (level between 0 and 99),
  is_manager     boolean not null default false,
  is_external    boolean not null default false,   -- true only for client-portal roles
  default_scope  access_scope not null default 'OWN',
  department_id  uuid references public.departments(id),
  description    text,
  sort_order     int not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid
);

comment on column public.roles.level is
  '0 Founder, 1 Co-Founder, 2 Department Head, 3 Manager, 4 Team Lead, 5 Executor, 6 Intern/Freelancer, 99 external client user.';

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id                     uuid primary key default gen_random_uuid(),
  auth_id                uuid unique,          -- auth.users.id; null until invite accepted
  full_name              text not null,
  email                  text not null,
  phone                  text,
  role_id                uuid not null references public.roles(id),
  department_id          uuid references public.departments(id),
  manager_id             uuid references public.users(id),
  path                   ltree,                -- maintained by trigger, never written by app
  client_id              uuid,                 -- set ONLY for external client-portal users
  employment_type        employment_type not null default 'Full-time',
  joined_on              date,
  exited_on              date,
  status                 user_status not null default 'Invited',
  avatar_url             text,
  timezone               text not null default 'Asia/Dubai',
  skills                 text[] not null default '{}',
  weekly_capacity_hours  numeric(5,2) not null default 40 check (weekly_capacity_hours >= 0),
  google_calendar_id     text,
  google_sync_token      text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid,
  deleted_at             timestamptz,
  deleted_by             uuid
);

create unique index if not exists users_email_lower_uidx on public.users (lower(email)) where deleted_at is null;

comment on column public.users.path is
  'Materialized ltree path from the founder down to this user. Maintained exclusively by trg_users_maintain_path — application writes are overwritten.';
comment on column public.users.client_id is
  'Non-null only for external CLIENT_PORTAL users. Internal staff must leave this null (enforced by users_external_shape_chk).';

-- An external user must be tied to exactly one client; an internal user must not be.
alter table public.users drop constraint if exists users_external_shape_chk;
alter table public.users add constraint users_external_shape_chk check (
  (client_id is null) or (client_id is not null)
) not valid;   -- refined into a real check in 0004 once clients exists

-- departments.head_user_id FK, now that users exists
alter table public.departments drop constraint if exists departments_head_user_id_fkey;
alter table public.departments
  add constraint departments_head_user_id_fkey
  foreign key (head_user_id) references public.users(id) on delete set null;

-- ---------------------------------------------------------------------
-- ltree path maintenance + cycle detection
-- ---------------------------------------------------------------------
-- ltree labels accept [A-Za-z0-9_] only, so a uuid is stored with '-' -> '_'.
create or replace function public.uuid_to_ltree_label(p_id uuid)
returns text language sql immutable parallel safe as $$
  select 'u' || replace(p_id::text, '-', '_');
$$;

create or replace function public.compute_user_path(p_user_id uuid, p_manager_id uuid)
returns ltree language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_manager_path ltree;
begin
  if p_manager_id is null then
    return public.uuid_to_ltree_label(p_user_id)::ltree;
  end if;

  select path into v_manager_path from public.users where id = p_manager_id;

  if v_manager_path is null then
    -- Manager exists but has no path yet (bulk seed ordering). Fall back to
    -- a one-level path; the recursive rebuild below repairs descendants.
    return public.uuid_to_ltree_label(p_user_id)::ltree;
  end if;

  return v_manager_path || public.uuid_to_ltree_label(p_user_id)::ltree;
end $$;

-- Rewrites the subtree rooted at p_user_id. Called after any manager change.
create or replace function public.rebuild_user_subtree_paths(p_user_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  r record;
begin
  for r in
    select id, manager_id from public.users where manager_id = p_user_id
  loop
    update public.users
       set path = public.compute_user_path(r.id, r.manager_id)
     where id = r.id;
    perform public.rebuild_user_subtree_paths(r.id);
  end loop;
end $$;

create or replace function public.trg_users_maintain_path()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_manager_path ltree;
  v_self_label   text;
begin
  v_self_label := public.uuid_to_ltree_label(new.id);

  -- A user may never manage themselves.
  if new.manager_id is not null and new.manager_id = new.id then
    raise exception 'Reporting cycle: % cannot report to themselves', new.full_name
      using errcode = '23514';
  end if;

  -- Cycle detection: the prospective manager must not sit inside this
  -- user's own subtree. Checking the manager's path for our label is an
  -- O(1) ltree containment test at any depth.
  if new.manager_id is not null then
    select path into v_manager_path from public.users where id = new.manager_id;
    if v_manager_path is not null and v_manager_path ~ (('*.' || v_self_label || '.*')::lquery) then
      raise exception 'Reporting cycle rejected: % is already beneath % in the reporting tree',
        new.manager_id, new.full_name using errcode = '23514';
    end if;
  end if;

  new.path := public.compute_user_path(new.id, new.manager_id);
  return new;
end $$;

drop trigger if exists trg_users_maintain_path on public.users;
create trigger trg_users_maintain_path
  before insert or update of manager_id, id on public.users
  for each row execute function public.trg_users_maintain_path();

-- After a manager change lands, re-point every descendant.
create or replace function public.trg_users_rebuild_descendants()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'UPDATE' and new.manager_id is distinct from old.manager_id then
    perform public.rebuild_user_subtree_paths(new.id);
  end if;
  return null;
end $$;

drop trigger if exists trg_users_rebuild_descendants on public.users;
create trigger trg_users_rebuild_descendants
  after update of manager_id on public.users
  for each row execute function public.trg_users_rebuild_descendants();

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Teams — cross-functional pods, the horizontal axis of visibility
-- ---------------------------------------------------------------------
create table if not exists public.teams (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  lead_user_id  uuid references public.users(id) on delete set null,
  department_id uuid references public.departments(id),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid
);

create table if not exists public.team_members (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references public.teams(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  role_on_team text,
  added_at     timestamptz not null default now(),
  unique (team_id, user_id)
);

-- ---------------------------------------------------------------------
-- Permission matrix — the Founder-editable grid
-- ---------------------------------------------------------------------
create table if not exists public.modules (
  key         text primary key,
  label       text not null,
  sort_order  int not null default 0
);

insert into public.modules (key, label, sort_order) values
  ('clients',          'Clients',            10),
  ('leads',            'Leads',              20),
  ('projects',         'Projects',           30),
  ('deliverables',     'Deliverables',       40),
  ('tasks',            'Tasks',              50),
  ('shoots',           'Shoots',             60),
  ('content_calendar', 'Content Calendar',   70),
  ('campaigns',        'Campaigns',          80),
  ('assets',           'Assets',             90),
  ('approvals',        'Approvals',         100),
  ('meetings',         'Meetings',          110),
  ('reports',          'Reports',           120),
  ('people',           'People',            130),
  ('leaves',           'Leaves',            140),
  ('equipment',        'Equipment',         150),
  ('templates',        'Templates',         160),
  ('settings',         'Settings',          170),
  ('audit_log',        'Audit Log',         180)
on conflict (key) do nothing;

create table if not exists public.role_permissions (
  id          uuid primary key default gen_random_uuid(),
  role_id     uuid not null references public.roles(id) on delete cascade,
  module      text not null references public.modules(key) on delete cascade,
  can_view    boolean not null default false,
  can_create  boolean not null default false,
  can_edit    boolean not null default false,
  can_delete  boolean not null default false,
  can_assign  boolean not null default false,
  can_approve boolean not null default false,
  can_export  boolean not null default false,
  scope       access_scope not null default 'OWN',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (role_id, module)
);

-- Per-person exceptions. NULL means "inherit the role's answer".
create table if not exists public.user_permission_overrides (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  module      text not null references public.modules(key) on delete cascade,
  can_view    boolean,
  can_create  boolean,
  can_edit    boolean,
  can_delete  boolean,
  can_assign  boolean,
  can_approve boolean,
  can_export  boolean,
  scope       access_scope,
  reason      text,
  granted_by  uuid references public.users(id),
  expires_on  date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, module)
);

drop trigger if exists trg_role_permissions_updated_at on public.role_permissions;
create trigger trg_role_permissions_updated_at before update on public.role_permissions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_user_permission_overrides_updated_at on public.user_permission_overrides;
create trigger trg_user_permission_overrides_updated_at before update on public.user_permission_overrides
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Indexes — every column consulted by an RLS policy is indexed
-- ---------------------------------------------------------------------
create index if not exists users_manager_id_idx    on public.users (manager_id);
create index if not exists users_role_id_idx       on public.users (role_id);
create index if not exists users_department_id_idx on public.users (department_id);
create index if not exists users_client_id_idx     on public.users (client_id) where client_id is not null;
create index if not exists users_auth_id_idx       on public.users (auth_id);
create index if not exists users_path_gist_idx     on public.users using gist (path);
create index if not exists users_path_btree_idx    on public.users using btree (path);
create index if not exists users_status_idx        on public.users (status) where deleted_at is null;

create index if not exists team_members_user_id_idx on public.team_members (user_id);
create index if not exists team_members_team_id_idx on public.team_members (team_id);
create index if not exists role_permissions_role_module_idx on public.role_permissions (role_id, module);
create index if not exists user_permission_overrides_user_module_idx on public.user_permission_overrides (user_id, module);
