-- =====================================================================
-- 0008_assets_approvals.sql
-- Assets with immutable version history, and the multi-stage approval
-- chain Editor -> Lead -> Manager -> Client.
-- =====================================================================

create table if not exists public.assets (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  deliverable_id uuid references public.deliverables(id) on delete cascade,
  task_id        uuid references public.tasks(id) on delete set null,
  shoot_id       uuid references public.shoots(id) on delete set null,
  name           text not null,
  type           asset_type not null default 'Edit',
  file_url       text,
  external_link  text,
  mime_type      text,
  size_bytes     bigint check (size_bytes is null or size_bytes >= 0),
  duration_secs  numeric(9,2),
  current_version_no int not null default 1 check (current_version_no >= 1),
  uploaded_by    uuid references public.users(id),
  uploaded_at    timestamptz not null default now(),
  is_client_visible boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.users(id),
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id),
  constraint assets_location_chk check (file_url is not null or external_link is not null)
);

-- content_calendar.asset_id FK, now that assets exists
alter table public.content_calendar drop constraint if exists content_calendar_asset_id_fkey;
alter table public.content_calendar
  add constraint content_calendar_asset_id_fkey foreign key (asset_id) references public.assets(id) on delete set null;

-- Full history. Rows here are append-only: nothing is ever overwritten.
create table if not exists public.asset_versions (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references public.assets(id) on delete cascade,
  version_no   int not null check (version_no >= 1),
  file_url     text,
  external_link text,
  mime_type    text,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  change_note  text,
  uploaded_by  uuid references public.users(id),
  uploaded_at  timestamptz not null default now(),
  unique (asset_id, version_no)
);

-- Every asset write forks a new version instead of replacing the last one.
create or replace function public.trg_assets_version()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_next int;
begin
  if tg_op = 'INSERT' then
    insert into public.asset_versions (asset_id, version_no, file_url, external_link, mime_type, size_bytes, change_note, uploaded_by)
    values (new.id, 1, new.file_url, new.external_link, new.mime_type, new.size_bytes, 'Initial upload', new.uploaded_by);
    return null;
  end if;

  if new.file_url is distinct from old.file_url
     or new.external_link is distinct from old.external_link then
    select coalesce(max(version_no), 0) + 1 into v_next
      from public.asset_versions where asset_id = new.id;

    insert into public.asset_versions (asset_id, version_no, file_url, external_link, mime_type, size_bytes, change_note, uploaded_by)
    values (new.id, v_next, new.file_url, new.external_link, new.mime_type, new.size_bytes,
            'Replaced file', coalesce(public.auth_user_id(), new.uploaded_by));

    update public.assets set current_version_no = v_next where id = new.id;

    if new.deliverable_id is not null then
      update public.deliverables set current_version = v_next where id = new.deliverable_id;
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_assets_version on public.assets;
create trigger trg_assets_version after insert or update on public.assets
  for each row execute function public.trg_assets_version();

-- asset_versions is append-only, enforced in the database.
create or replace function public.trg_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: rows cannot be % once written', tg_table_name, lower(tg_op)
    using errcode = '42501';
end $$;

drop trigger if exists trg_asset_versions_append_only on public.asset_versions;
create trigger trg_asset_versions_append_only before update or delete on public.asset_versions
  for each row execute function public.trg_append_only();

-- ---------------------------------------------------------------------
-- Approvals — multi-stage chain
-- ---------------------------------------------------------------------
create table if not exists public.approval_chains (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references public.clients(id) on delete cascade,
  entity_type      text not null,           -- deliverable | content_calendar | asset
  deliverable_type text,                     -- null = applies to all types
  step_no          int not null check (step_no > 0),
  level            approval_level not null,
  approver_role_id uuid references public.roles(id),
  approver_user_id uuid references public.users(id),
  sla_days         int not null default 2 check (sla_days >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (client_id, entity_type, deliverable_type, step_no)
);

comment on table public.approval_chains is
  'Declarative approval routing. fn_request_approval() reads the next step here rather than any hardcoded Editor->Lead->Manager->Client sequence.';

create table if not exists public.approvals (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  client_id    uuid references public.clients(id) on delete cascade,
  level        approval_level not null,
  step_no      int not null default 1,
  round_no     int not null default 1,
  requested_by uuid references public.users(id),
  approver_id  uuid references public.users(id),
  status       approval_state not null default 'Pending',
  requested_at timestamptz not null default now(),
  due_at       timestamptz,
  decided_at   timestamptz,
  feedback     text,
  escalated_at timestamptz,
  escalated_to uuid references public.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id)
);

comment on table public.approvals is
  'One row per approval request per stage per round. Approving is a distinct permission (role_permissions.can_approve) from editing.';

-- Feedback is immutable once posted: an edit must be visible as a revision.
create table if not exists public.approval_feedback_revisions (
  id           uuid primary key default gen_random_uuid(),
  approval_id  uuid not null references public.approvals(id) on delete cascade,
  previous_feedback text,
  edited_by    uuid references public.users(id),
  edited_at    timestamptz not null default now()
);

create or replace function public.trg_approval_feedback_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.feedback is not null and new.feedback is distinct from old.feedback then
    insert into public.approval_feedback_revisions (approval_id, previous_feedback, edited_by)
    values (old.id, old.feedback, public.auth_user_id());
  end if;
  return new;
end $$;

drop trigger if exists trg_approval_feedback_immutable on public.approvals;
create trigger trg_approval_feedback_immutable before update of feedback on public.approvals
  for each row execute function public.trg_approval_feedback_immutable();

create index if not exists assets_client_idx      on public.assets (client_id) where deleted_at is null;
create index if not exists assets_deliverable_idx on public.assets (deliverable_id) where deleted_at is null;
create index if not exists assets_project_idx     on public.assets (project_id);
create index if not exists assets_task_idx        on public.assets (task_id);
create index if not exists assets_shoot_idx       on public.assets (shoot_id);
create index if not exists assets_uploaded_by_idx on public.assets (uploaded_by);
create index if not exists assets_created_by_idx  on public.assets (created_by);
create index if not exists asset_versions_asset_idx on public.asset_versions (asset_id, version_no desc);

create index if not exists approvals_entity_idx    on public.approvals (entity_type, entity_id);
create index if not exists approvals_approver_idx  on public.approvals (approver_id, status) where deleted_at is null;
create index if not exists approvals_client_idx    on public.approvals (client_id) where deleted_at is null;
create index if not exists approvals_requested_by_idx on public.approvals (requested_by);
create index if not exists approvals_due_idx       on public.approvals (due_at) where status = 'Pending' and deleted_at is null;
create index if not exists approval_chains_lookup_idx on public.approval_chains (entity_type, client_id, step_no);

do $$
declare t text;
begin
  foreach t in array array['assets','approvals','approval_chains'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
