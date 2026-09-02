-- =====================================================================
-- 0025_record_access_controls.sql
-- Per-item access and edit governance. Allows Founders (level <= 1) to
-- explicitly define who can view and who can edit any individual record
-- (Tasks, Deliverables, Projects, Clients, Shoots, Assets, Content Posts).
-- =====================================================================

create table if not exists public.record_access_controls (
  id                      uuid primary key default gen_random_uuid(),
  table_name              text not null,
  record_id               uuid not null,
  is_locked_to_founders   boolean not null default false,
  allowed_viewer_user_ids uuid[] not null default '{}',
  allowed_editor_user_ids uuid[] not null default '{}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid references public.users(id),
  unique (table_name, record_id)
);

comment on table public.record_access_controls is
  'Per-item view and edit overrides managed by Founders.';

-- Enable RLS
alter table public.record_access_controls enable row level security;

-- 1. Read Policy: All authenticated active team members can read item access controls
drop policy if exists record_access_controls_select on public.record_access_controls;
create policy record_access_controls_select on public.record_access_controls
  for select
  using (public.auth_is_active());

-- 2. Write Policy: Only Founders (level <= 1) can insert/update item access controls
drop policy if exists record_access_controls_write on public.record_access_controls;
create policy record_access_controls_write on public.record_access_controls
  for all
  using (public.is_founder())
  with check (public.is_founder());

-- Helper RPC: Save or update item access control
create or replace function public.save_record_access_control(
  p_table_name              text,
  p_record_id               uuid,
  p_is_locked_to_founders   boolean,
  p_allowed_viewer_user_ids uuid[],
  p_allowed_editor_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_founder() then
    raise exception 'Only Founders can manage item access controls.';
  end if;

  insert into public.record_access_controls (
    table_name,
    record_id,
    is_locked_to_founders,
    allowed_viewer_user_ids,
    allowed_editor_user_ids,
    updated_at,
    updated_by
  ) values (
    p_table_name,
    p_record_id,
    p_is_locked_to_founders,
    p_allowed_viewer_user_ids,
    p_allowed_editor_user_ids,
    now(),
    public.auth_user_id()
  )
  on conflict (table_name, record_id) do update set
    is_locked_to_founders   = excluded.is_locked_to_founders,
    allowed_viewer_user_ids = excluded.allowed_viewer_user_ids,
    allowed_editor_user_ids = excluded.allowed_editor_user_ids,
    updated_at              = now(),
    updated_by              = public.auth_user_id();
end $$;
