-- =====================================================================
-- 0011_system.sql
-- Templates, SOPs, automation rules, saved views, tags, custom fields
-- and attachments.
-- =====================================================================

create table if not exists public.project_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  type         project_type not null default 'Retainer',
  description  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id)
);

create table if not exists public.deliverable_templates (
  id                  uuid primary key default gen_random_uuid(),
  project_template_id uuid references public.project_templates(id) on delete cascade,
  name                text not null,
  deliverable_type    text not null,
  default_qty         int not null default 1 check (default_qty > 0),
  default_sla_days    int not null default 7 check (default_sla_days >= 0),
  brief_template      text,
  platform            social_platform,
  sort_order          int not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id)
);

create table if not exists public.task_templates (
  id                      uuid primary key default gen_random_uuid(),
  deliverable_template_id uuid references public.deliverable_templates(id) on delete cascade,
  deliverable_type        text,        -- lets a chain attach by type without a parent template
  title                   text not null,
  task_type               text not null default 'General',
  sort_order              int not null default 0,
  -- Offsets are relative to the deliverable due date; negative = before.
  offset_days_from_due    int not null default -3,
  duration_days           int not null default 1 check (duration_days > 0),
  estimated_hours         numeric(6,2) check (estimated_hours is null or estimated_hours >= 0),
  default_role_id         uuid references public.roles(id),
  depends_on_sort_order   int,          -- builds task_dependencies within the chain
  lag_days                int not null default 0,
  checklist_template_id   uuid,
  sop_id                  uuid,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  deleted_by              uuid references public.users(id)
);

create table if not exists public.checklist_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  task_type  text,
  items      jsonb not null default '[]',   -- [{label, sort_order}]
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.users(id)
);

alter table public.task_templates drop constraint if exists task_templates_checklist_fkey;
alter table public.task_templates
  add constraint task_templates_checklist_fkey
  foreign key (checklist_template_id) references public.checklist_templates(id) on delete set null;

-- ---------------------------------------------------------------------
-- SOPs — shown inline when a task of the matching type opens
-- ---------------------------------------------------------------------
create table if not exists public.sops (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  task_type   text,
  department_id uuid references public.departments(id),
  body_md     text not null,
  version     int not null default 1,
  is_active   boolean not null default true,
  owner_id    uuid references public.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id)
);

alter table public.tasks drop constraint if exists tasks_sop_id_fkey;
alter table public.tasks
  add constraint tasks_sop_id_fkey foreign key (sop_id) references public.sops(id) on delete set null;

alter table public.task_templates drop constraint if exists task_templates_sop_fkey;
alter table public.task_templates
  add constraint task_templates_sop_fkey foreign key (sop_id) references public.sops(id) on delete set null;

alter table public.client_service_scope drop constraint if exists client_service_scope_task_template_fkey;
alter table public.client_service_scope
  add constraint client_service_scope_task_template_fkey
  foreign key (task_template_id) references public.deliverable_templates(id) on delete set null;

-- ---------------------------------------------------------------------
-- Automation rules — auto-assignment and routing, as data
-- ---------------------------------------------------------------------
create table if not exists public.automation_rules (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  client_id     uuid references public.clients(id) on delete cascade,   -- null = all clients
  task_type     text,                                                   -- null = all task types
  department_id uuid references public.departments(id),
  strategy      text not null default 'fixed_user'
                check (strategy in ('fixed_user','round_robin','least_loaded','by_skill')),
  target_user_id uuid references public.users(id),
  pool_user_ids uuid[] not null default '{}',
  required_skill text,
  skip_on_leave boolean not null default true,
  priority      int not null default 100,     -- lower wins
  is_active     boolean not null default true,
  last_assigned_user_id uuid references public.users(id),   -- round-robin cursor
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

comment on table public.automation_rules is
  'Maps (client, task_type) to a person or a pool. fn_pick_assignee() honours skip_on_leave and rolls to the next available person.';

-- ---------------------------------------------------------------------
-- Saved views — filters + columns + sort, per user per module
-- ---------------------------------------------------------------------
create table if not exists public.saved_views (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  module      text not null references public.modules(key) on delete cascade,
  name        text not null,
  view_mode   text not null default 'list' check (view_mode in ('list','kanban','calendar','timeline')),
  filters     jsonb not null default '{}',
  columns     jsonb not null default '[]',
  sort        jsonb not null default '[]',
  group_by    text,
  is_pinned   boolean not null default false,
  is_shared   boolean not null default false,
  is_default  boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, module, name)
);

create unique index if not exists saved_views_one_default_uidx
  on public.saved_views (user_id, module) where is_default;

-- ---------------------------------------------------------------------
-- Tags and custom fields
-- ---------------------------------------------------------------------
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  colour_hex text default '#64748b',
  module     text references public.modules(key) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  unique (name, module)
);

create table if not exists public.entity_tags (
  id          uuid primary key default gen_random_uuid(),
  tag_id      uuid not null references public.tags(id) on delete cascade,
  entity_type text not null,
  entity_id   uuid not null,
  client_id   uuid references public.clients(id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  unique (tag_id, entity_type, entity_id)
);

create table if not exists public.custom_fields (
  id           uuid primary key default gen_random_uuid(),
  module       text not null references public.modules(key) on delete cascade,
  key          text not null,
  label        text not null,
  field_type   text not null check (field_type in ('text','number','date','select','multiselect','boolean','user','url')),
  options      jsonb not null default '[]',
  is_required  boolean not null default false,
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (module, key)
);

create table if not exists public.custom_field_values (
  id              uuid primary key default gen_random_uuid(),
  custom_field_id uuid not null references public.custom_fields(id) on delete cascade,
  entity_type     text not null,
  entity_id       uuid not null,
  client_id       uuid references public.clients(id) on delete cascade,
  value           jsonb,
  updated_at      timestamptz not null default now(),
  unique (custom_field_id, entity_id)
);

-- ---------------------------------------------------------------------
-- Attachments — generic file links on any entity
-- ---------------------------------------------------------------------
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id   uuid not null,
  client_id   uuid references public.clients(id) on delete cascade,
  file_name   text not null,
  file_url    text not null,
  mime_type   text,
  size_bytes  bigint check (size_bytes is null or size_bytes >= 0),
  is_client_visible boolean not null default false,
  uploaded_by uuid references public.users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id)
);

create index if not exists deliverable_templates_project_idx on public.deliverable_templates (project_template_id, sort_order);
create index if not exists task_templates_deliverable_idx    on public.task_templates (deliverable_template_id, sort_order);
create index if not exists task_templates_type_idx           on public.task_templates (deliverable_type);
create index if not exists sops_task_type_idx                on public.sops (task_type) where is_active;
create index if not exists automation_rules_lookup_idx       on public.automation_rules (client_id, task_type, priority) where is_active and deleted_at is null;
create index if not exists saved_views_user_module_idx       on public.saved_views (user_id, module);
create index if not exists entity_tags_entity_idx            on public.entity_tags (entity_type, entity_id);
create index if not exists entity_tags_tag_idx               on public.entity_tags (tag_id);
create index if not exists custom_field_values_entity_idx    on public.custom_field_values (entity_type, entity_id);
create index if not exists attachments_entity_idx            on public.attachments (entity_type, entity_id) where deleted_at is null;
create index if not exists attachments_client_idx            on public.attachments (client_id);

do $$
declare t text;
begin
  foreach t in array array['project_templates','deliverable_templates','task_templates','checklist_templates',
                           'sops','automation_rules','saved_views','custom_fields'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
