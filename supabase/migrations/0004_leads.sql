-- =====================================================================
-- 0004_leads.sql
-- Pre-client pipeline. Stages and dates only — no deal value, no
-- forecast amount, no quota. A lead's weight is its stage and its
-- next_action_date, nothing else.
-- =====================================================================

create table if not exists public.leads (
  id                   uuid primary key default gen_random_uuid(),
  company              text not null,
  brand_name           text,
  contact_name         text,
  contact_email        text,
  contact_phone        text,
  designation          text,
  industry             text,
  city                 text,
  country              text default 'India',
  timezone             text not null default 'Asia/Kolkata',
  website              text,
  source               text,
  stage                lead_stage not null default 'New',
  priority             priority_level not null default 'Medium',
  owner_id             uuid references public.users(id),
  next_action_date     date,
  next_action_note     text,
  expected_start_date  date,
  first_contacted_on   date,
  last_activity_on     date,
  lost_reason          text,
  converted_client_id  uuid references public.clients(id) on delete set null,
  converted_at         timestamptz,
  service_interest     text[] not null default '{}',
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references public.users(id),
  deleted_at           timestamptz,
  deleted_by           uuid references public.users(id)
);

comment on table public.leads is
  'Sales pipeline without money. Deliberately has no value/amount/probability-weighted-revenue column; pipeline health is measured in stage movement and overdue next actions.';

create table if not exists public.lead_activities (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  activity_type text not null,       -- Call | Meeting | Email | WhatsApp | Note | Proposal
  occurred_at   timestamptz not null default now(),
  duration_mins int check (duration_mins is null or duration_mins >= 0),
  summary       text not null,
  outcome       text,
  next_action_date date,
  logged_by     uuid references public.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

-- Keep the lead's rollup dates honest from its activity log.
create or replace function public.trg_lead_activity_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.leads l
     set last_activity_on = greatest(coalesce(l.last_activity_on, '-infinity'::date), new.occurred_at::date),
         next_action_date = coalesce(new.next_action_date, l.next_action_date),
         first_contacted_on = coalesce(l.first_contacted_on, new.occurred_at::date)
   where l.id = new.lead_id;
  return null;
end $$;

drop trigger if exists trg_lead_activity_rollup on public.lead_activities;
create trigger trg_lead_activity_rollup after insert on public.lead_activities
  for each row execute function public.trg_lead_activity_rollup();

-- ---------------------------------------------------------------------
-- convert_lead_to_client — one click, nothing retyped.
-- Every matching field crosses over, the activity history stays linked
-- via clients.converted_from_lead, and the lead is closed as Won.
-- ---------------------------------------------------------------------
create or replace function public.convert_lead_to_client(
  p_lead_id             uuid,
  p_account_manager_id  uuid default null,
  p_contract_start_date date default null,
  p_contract_end_date   date default null,
  p_notice_period_days  int  default 30
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead    public.leads%rowtype;
  v_client_id uuid;
  v_actor   uuid := public.auth_user_id();
begin
  select * into v_lead from public.leads where id = p_lead_id and deleted_at is null;
  if not found then
    raise exception 'Lead % not found', p_lead_id using errcode = 'P0002';
  end if;

  if v_lead.converted_client_id is not null then
    raise exception 'Lead % was already converted to client %', p_lead_id, v_lead.converted_client_id
      using errcode = '23505';
  end if;

  insert into public.clients (
    legal_name, brand_name, industry, city, country, timezone, website,
    status, source, priority, onboarding_date,
    contract_start_date, contract_end_date, notice_period_days,
    account_manager_id, service_tags, notes, converted_from_lead, created_by
  ) values (
    v_lead.company,
    coalesce(v_lead.brand_name, v_lead.company),
    v_lead.industry, v_lead.city, v_lead.country, v_lead.timezone, v_lead.website,
    'Onboarding',
    v_lead.source,
    v_lead.priority,
    current_date,
    coalesce(p_contract_start_date, v_lead.expected_start_date, current_date),
    p_contract_end_date,
    p_notice_period_days,
    coalesce(p_account_manager_id, v_lead.owner_id),
    v_lead.service_interest,
    v_lead.notes,
    v_lead.id,
    v_actor
  ) returning id into v_client_id;

  -- The lead's contact becomes the client's primary POC — not retyped.
  if v_lead.contact_name is not null then
    insert into public.client_contacts (
      client_id, name, designation, email, phone, is_primary, is_decision_maker, created_by
    ) values (
      v_client_id, v_lead.contact_name, v_lead.designation,
      v_lead.contact_email, v_lead.contact_phone, true, true, v_actor
    );
  end if;

  -- Empty brand kit shell so the client detail page has one row to edit.
  insert into public.client_brand_kit (client_id, created_by)
  values (v_client_id, v_actor)
  on conflict (client_id) do nothing;

  -- Owner keeps the account.
  if coalesce(p_account_manager_id, v_lead.owner_id) is not null then
    insert into public.client_team_members (client_id, user_id, role_on_account, is_lead, added_by)
    values (v_client_id, coalesce(p_account_manager_id, v_lead.owner_id), 'Account Manager', true, v_actor)
    on conflict (client_id, user_id) do nothing;
  end if;

  update public.leads
     set stage = 'Won',
         converted_client_id = v_client_id,
         converted_at = now()
   where id = p_lead_id;

  return v_client_id;
end $$;

comment on function public.convert_lead_to_client is
  'Carries every matching field from lead to client, creates the primary contact and brand-kit shell, links history and closes the lead as Won. Nothing is retyped.';

create index if not exists leads_owner_idx            on public.leads (owner_id) where deleted_at is null;
create index if not exists leads_stage_idx            on public.leads (stage) where deleted_at is null;
create index if not exists leads_next_action_idx      on public.leads (next_action_date) where deleted_at is null;
create index if not exists leads_expected_start_idx   on public.leads (expected_start_date) where deleted_at is null;
create index if not exists leads_converted_client_idx on public.leads (converted_client_id);
create index if not exists leads_company_trgm_idx     on public.leads using gin (company extensions.gin_trgm_ops);
create index if not exists lead_activities_lead_idx   on public.lead_activities (lead_id, occurred_at desc);
create index if not exists lead_activities_logged_by_idx on public.lead_activities (logged_by);

do $$
declare t text;
begin
  foreach t in array array['leads','lead_activities'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
