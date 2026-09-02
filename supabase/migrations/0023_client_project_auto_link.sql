-- =====================================================================
-- 0023_client_project_auto_link.sql
-- Automatically provision a primary Retainer Project whenever a Client
-- is created or converted from a lead, unifying Clients & Projects.
-- =====================================================================

create or replace function public.trg_clients_auto_create_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
begin
  -- Check if client already has a project
  select id into v_project_id
    from public.projects
   where client_id = new.id
     and deleted_at is null
   limit 1;

  if v_project_id is null then
    insert into public.projects (
      client_id,
      name,
      code,
      status,
      type,
      start_date,
      manager_id,
      description
    ) values (
      new.id,
      new.brand_name || ' — Primary Retainer Project',
      'PRJ-' || substring(replace(gen_random_uuid()::text, '-', ''), 1, 6),
      'Active',
      'Retainer',
      coalesce(new.contract_start_date, current_date),
      new.account_manager_id,
      'Auto-created primary project container for client ' || new.brand_name
    );
  end if;

  return new;
end $$;

drop trigger if exists trg_clients_auto_project on public.clients;

create trigger trg_clients_auto_project
  after insert or update of status on public.clients
  for each row
  when (new.status = 'Active' and new.deleted_at is null)
  execute function public.trg_clients_auto_create_project();
