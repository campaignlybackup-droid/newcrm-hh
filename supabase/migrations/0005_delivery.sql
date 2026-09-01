-- =====================================================================
-- 0005_delivery.sql
-- Projects -> cycles -> deliverables -> tasks, plus dependencies,
-- checklists and revision rounds.
--
-- client_id is denormalised onto deliverables, tasks and everything
-- downstream. That is NOT a retyped copy: it is a read-only mirror
-- written by the inheritance triggers in 0015 and defended by
-- trg_*_guard_inherited. It exists so that RLS policies can filter on a
-- single indexed local column instead of walking three joins per row.
-- =====================================================================

create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  name         text not null,
  code         text,
  type         project_type not null default 'Retainer',
  start_date   date,
  end_date     date,
  manager_id   uuid references public.users(id),
  status       project_status not null default 'Planned',
  health       health_status not null default 'Green',   -- computed
  health_note  text,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  constraint projects_dates_chk check (end_date is null or start_date is null or end_date >= start_date)
);

-- ---------------------------------------------------------------------
-- Retainer cycles — auto-created monthly by pg_cron (0016)
-- ---------------------------------------------------------------------
create table if not exists public.retainer_cycles (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  cycle_month  date not null,          -- always the 1st of the month
  start_date   date not null,
  end_date     date not null,
  status       work_status not null default 'Not Started',
  generated_at timestamptz not null default now(),
  generated_by text not null default 'system',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  unique (project_id, cycle_month),
  constraint retainer_cycles_dates_chk check (end_date >= start_date)
);

-- ---------------------------------------------------------------------
-- Deliverables
-- ---------------------------------------------------------------------
create table if not exists public.deliverables (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete cascade,
  cycle_id         uuid references public.retainer_cycles(id) on delete set null,
  scope_id         uuid references public.client_service_scope(id) on delete set null,
  type             text not null,
  title            text not null,
  qty              int not null default 1 check (qty > 0),
  brief            text,
  due_date         date,
  sla_due_date     date,
  status           work_status not null default 'Not Started',
  approval_status  approval_state not null default 'Draft',
  current_version  int not null default 0 check (current_version >= 0),
  review_rounds_allowed int not null default 2,
  review_rounds_used    int not null default 0,
  owner_id         uuid references public.users(id),
  reviewer_id      uuid references public.users(id),
  priority         priority_level not null default 'Medium',
  delivered_at     timestamptz,
  platform         social_platform,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.users(id),
  deleted_at       timestamptz,
  deleted_by       uuid references public.users(id)
);

comment on column public.deliverables.client_id is
  'Read-only mirror of projects.client_id, maintained by trg_deliverables_inherit. Present so RLS can filter on one indexed column.';

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id               uuid primary key default gen_random_uuid(),
  deliverable_id   uuid references public.deliverables(id) on delete cascade,
  project_id       uuid references public.projects(id) on delete cascade,
  client_id        uuid references public.clients(id) on delete cascade,
  shoot_id         uuid,                -- FK added in 0006
  meeting_id       uuid,                -- FK added in 0009 (action item -> task)
  title            text not null,
  description      text,
  task_type        text not null default 'General',
  assignee_id      uuid references public.users(id),
  reviewer_id      uuid references public.users(id),
  start_date       date,
  due_date         date,
  completed_at     timestamptz,
  estimated_hours  numeric(6,2) check (estimated_hours is null or estimated_hours >= 0),
  actual_hours     numeric(6,2) check (actual_hours is null or actual_hours >= 0),
  priority         priority_level not null default 'Medium',
  status           work_status not null default 'Not Started',
  is_blocked       boolean not null default false,
  block_reason     text,
  sort_order       int not null default 0,
  sop_id           uuid,                -- FK added in 0011
  auto_assigned    boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.users(id),
  deleted_at       timestamptz,
  deleted_by       uuid references public.users(id),
  constraint tasks_dates_chk    check (due_date is null or start_date is null or due_date >= start_date),
  constraint tasks_blocked_chk  check (not is_blocked or block_reason is not null)
);

comment on table public.tasks is
  'estimated_hours/actual_hours are WORKLOAD, not billing. There is no billable flag, no rate and no timesheet-to-invoice path anywhere in this system.';

-- ---------------------------------------------------------------------
-- Dependencies — moving one date cascades the chain (engine in 0015)
-- ---------------------------------------------------------------------
create table if not exists public.task_dependencies (
  id             uuid primary key default gen_random_uuid(),
  predecessor_id uuid not null references public.tasks(id) on delete cascade,
  successor_id   uuid not null references public.tasks(id) on delete cascade,
  lag_days       int not null default 0,
  dependency_type text not null default 'FS' check (dependency_type in ('FS','SS','FF','SF')),
  created_at     timestamptz not null default now(),
  created_by     uuid references public.users(id),
  unique (predecessor_id, successor_id),
  constraint task_dependencies_no_self_chk check (predecessor_id <> successor_id)
);

-- Reject dependency cycles at write time with a recursive reachability probe.
create or replace function public.trg_task_dependencies_no_cycle()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cycle boolean;
begin
  with recursive reach(id) as (
    select new.successor_id
    union
    select d.successor_id
      from public.task_dependencies d
      join reach r on d.predecessor_id = r.id
  )
  select exists (select 1 from reach where id = new.predecessor_id) into v_cycle;

  if v_cycle then
    raise exception 'Dependency cycle rejected: task % already depends on task %',
      new.predecessor_id, new.successor_id using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_task_dependencies_no_cycle on public.task_dependencies;
create trigger trg_task_dependencies_no_cycle
  before insert or update on public.task_dependencies
  for each row execute function public.trg_task_dependencies_no_cycle();

-- ---------------------------------------------------------------------
-- Checklists
-- ---------------------------------------------------------------------
create table if not exists public.checklist_items (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  label      text not null,
  is_done    boolean not null default false,
  done_by    uuid references public.users(id),
  done_at    timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.users(id)
);

-- Stamp done_by/done_at from the session rather than trusting the payload.
create or replace function public.trg_checklist_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_done and not coalesce(old.is_done, false) then
    new.done_at := now();
    new.done_by := coalesce(public.auth_user_id(), new.done_by);
  elsif not new.is_done then
    new.done_at := null;
    new.done_by := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_checklist_stamp on public.checklist_items;
create trigger trg_checklist_stamp before insert or update of is_done on public.checklist_items
  for each row execute function public.trg_checklist_stamp();

-- ---------------------------------------------------------------------
-- Revision rounds
-- ---------------------------------------------------------------------
create table if not exists public.revisions (
  id             uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references public.deliverables(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete cascade,
  round_no       int not null check (round_no > 0),
  requested_by   uuid references public.users(id),
  requested_at   timestamptz not null default now(),
  notes          text not null,
  due_date       date,
  closed_at      timestamptz,
  closed_by      uuid references public.users(id),
  is_out_of_scope boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id),
  unique (deliverable_id, round_no)
);

comment on column public.revisions.is_out_of_scope is
  'Flags a round beyond client_service_scope.review_rounds_allowed. It is a status flag for the account conversation, NOT a chargeable item — this system never prices anything.';

-- ---------------------------------------------------------------------
-- Indexes — every RLS-referenced and filter column
-- ---------------------------------------------------------------------
create index if not exists projects_client_idx      on public.projects (client_id) where deleted_at is null;
create index if not exists projects_manager_idx     on public.projects (manager_id) where deleted_at is null;
create index if not exists projects_status_idx      on public.projects (status) where deleted_at is null;
create index if not exists projects_dates_idx       on public.projects (start_date, end_date);
create index if not exists projects_created_by_idx  on public.projects (created_by);

create index if not exists retainer_cycles_project_idx on public.retainer_cycles (project_id, cycle_month desc);
create index if not exists retainer_cycles_client_idx  on public.retainer_cycles (client_id);
create index if not exists retainer_cycles_dates_idx   on public.retainer_cycles (start_date, end_date);

create index if not exists deliverables_client_idx   on public.deliverables (client_id) where deleted_at is null;
create index if not exists deliverables_project_idx  on public.deliverables (project_id) where deleted_at is null;
create index if not exists deliverables_cycle_idx    on public.deliverables (cycle_id);
create index if not exists deliverables_owner_idx    on public.deliverables (owner_id) where deleted_at is null;
create index if not exists deliverables_reviewer_idx on public.deliverables (reviewer_id) where deleted_at is null;
create index if not exists deliverables_created_by_idx on public.deliverables (created_by);
create index if not exists deliverables_due_idx      on public.deliverables (due_date) where deleted_at is null;
create index if not exists deliverables_status_idx   on public.deliverables (status) where deleted_at is null;
create index if not exists deliverables_approval_idx on public.deliverables (approval_status) where deleted_at is null;

create index if not exists tasks_assignee_idx    on public.tasks (assignee_id) where deleted_at is null;
create index if not exists tasks_reviewer_idx    on public.tasks (reviewer_id) where deleted_at is null;
create index if not exists tasks_created_by_idx  on public.tasks (created_by);
create index if not exists tasks_client_idx      on public.tasks (client_id) where deleted_at is null;
create index if not exists tasks_project_idx     on public.tasks (project_id) where deleted_at is null;
create index if not exists tasks_deliverable_idx on public.tasks (deliverable_id) where deleted_at is null;
create index if not exists tasks_due_idx         on public.tasks (due_date) where deleted_at is null;
create index if not exists tasks_status_idx      on public.tasks (status) where deleted_at is null;
create index if not exists tasks_shoot_idx       on public.tasks (shoot_id) where shoot_id is not null;
-- Covering index for the default "my queue" list view: no heap lookup, no N+1.
create index if not exists tasks_assignee_due_cover_idx
  on public.tasks (assignee_id, due_date)
  include (title, status, priority, client_id, project_id, deliverable_id)
  where deleted_at is null;

create index if not exists task_dependencies_pred_idx on public.task_dependencies (predecessor_id);
create index if not exists task_dependencies_succ_idx on public.task_dependencies (successor_id);
create index if not exists checklist_items_task_idx   on public.checklist_items (task_id, sort_order);
create index if not exists revisions_deliverable_idx  on public.revisions (deliverable_id, round_no);
create index if not exists revisions_client_idx       on public.revisions (client_id);

do $$
declare t text;
begin
  foreach t in array array['projects','retainer_cycles','deliverables','tasks','checklist_items','revisions'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
