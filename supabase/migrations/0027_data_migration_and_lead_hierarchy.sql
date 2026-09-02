-- =====================================================================
-- 0027_data_migration_and_lead_hierarchy.sql
-- Migration: Update RPCs, Views, Seed Hostinger Users & Clients,
-- establish Team Hierarchy rules & role scopes according to handwritten org chart.
-- Grant full leads visibility & assignment privileges to Manav (PRODUCTION_HEAD).
-- Seed auth.users with encrypted passwords ('Password123!') for all 12 accounts.
-- =====================================================================

-- 1. Update convert_lead_to_client function to use 'Closed' stage
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
  v_lead       public.leads%rowtype;
  v_client_id  uuid;
  v_actor      uuid := public.auth_user_id();
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

  if v_lead.contact_name is not null then
    insert into public.client_contacts (
      client_id, name, designation, email, phone, is_primary, is_decision_maker, created_by
    ) values (
      v_client_id, v_lead.contact_name, v_lead.designation,
      v_lead.contact_email, v_lead.contact_phone, true, true, v_actor
    );
  end if;

  insert into public.client_brand_kit (client_id, created_by)
  values (v_client_id, v_actor)
  on conflict (client_id) do nothing;

  if coalesce(p_account_manager_id, v_lead.owner_id) is not null then
    insert into public.client_team_members (client_id, user_id, role_on_account, is_lead, added_by)
    values (v_client_id, coalesce(p_account_manager_id, v_lead.owner_id), 'Account Manager', true, v_actor)
    on conflict (client_id, user_id) do nothing;
  end if;

  update public.leads
     set stage = 'Closed',
         converted_client_id = v_client_id,
         converted_at = now()
   where id = p_lead_id;

  return v_client_id;
end $$;

-- 2. Update v_lead_pipeline view
create or replace view public.v_lead_pipeline
with (security_invoker = true) as
select
  l.stage,
  l.owner_id,
  u.full_name as owner_name,
  count(*)                                                        as lead_count,
  count(*) filter (where l.next_action_date < current_date)        as overdue_actions,
  count(*) filter (where l.next_action_date = current_date)        as actions_today,
  min(l.expected_start_date)                                       as earliest_expected_start
from public.leads l
left join public.users u on u.id = l.owner_id
where l.deleted_at is null and l.stage not in ('Closed','Dead')
group by l.stage, l.owner_id, u.full_name;

-- 3. Seed/Update Team Members & Hierarchy according to exact handwritten chart
insert into public.users (id, auth_id, full_name, email, phone, role_id, department_id, manager_id,
                          employment_type, joined_on, status, timezone, weekly_capacity_hours)
select v.id::uuid, v.auth_id::uuid, v.full_name, v.email, v.phone,
       (select id from public.roles where code = v.role_code),
       (select id from public.departments where code = v.dept_code),
       nullif(v.manager_id, '')::uuid,
       'Full-time'::employment_type, date '2026-08-01', 'Active'::user_status,
       'Asia/Dubai', 40
from (values
  ('00000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000101','Nimit',       'nimit@hekayahaus.com',   '','FOUNDER',         null,        ''),
  ('00000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000102','Manav',       'manav@hekayahaus.com',   '+971 52 188 9604','PRODUCTION_HEAD','PRODUCTION','00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000103','Zainab',      'zainab@hekayahaus.com',  '7778080709','SOCIAL_HEAD',     'SOCIAL',    '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000104','10000000-0000-4000-8000-000000000104','Ansh',        'ansh@hekayahaus.com',    '9306260247','SOCIAL_EXECUTIVE','SOCIAL',    '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000105','10000000-0000-4000-8000-000000000105','Areej',       'areej@hekayahaus.com',   '','SALES_EXECUTIVE', 'SALES',     '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000106','10000000-0000-4000-8000-000000000106','Jannat',      'jannat@hekayahaus.com',  '','SALES_EXECUTIVE', 'SALES',     '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000107','10000000-0000-4000-8000-000000000107','Aradhey',     'aradhey@hekayahaus.com', '','SALES_EXECUTIVE', 'SALES',     '00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000000108','10000000-0000-4000-8000-000000000108','Seegan',      'seegan@hekayahaus.com',  '','SALES_EXECUTIVE', 'SALES',     '00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000000109','10000000-0000-4000-8000-000000000109','Neeraj',      'neeraj@hekayahaus.com',  '','SALES_EXECUTIVE', 'SALES',     '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000110','10000000-0000-4000-8000-000000000110','Parth',       'parth@hekayahaus.com',   '','VIDEO_EDITOR',    'PRODUCTION','00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000111','10000000-0000-4000-8000-000000000111','Dieablo',     'dieablo@hekayahaus.com', '','VIDEO_EDITOR',    'PRODUCTION','00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000112','10000000-0000-4000-8000-000000000112','Hani',        'hani@hekayahaus.com',    '','DOP',             'PRODUCTION','00000000-0000-4000-8000-000000000102')
) as v(id, auth_id, full_name, email, phone, role_code, dept_code, manager_id)
on conflict (id) do update set
  full_name = excluded.full_name,
  email = excluded.email,
  phone = excluded.phone,
  role_id = excluded.role_id,
  department_id = excluded.department_id,
  manager_id = excluded.manager_id;

-- 4. Seed Clients from Hostinger Database Export (assigned to Manav)
insert into public.clients (id, legal_name, brand_name, industry, city, timezone, status,
                            source, priority, onboarding_date, account_manager_id, created_by)
select v.id::uuid, v.legal_name, v.brand_name, v.industry, 'Dubai', 'Asia/Dubai', v.status::client_status,
       'Referral', 'Medium'::priority_level, date '2026-08-10', '00000000-0000-4000-8000-000000000102'::uuid,
       '00000000-0000-4000-8000-000000000101'::uuid
from (values
  ('20000000-0000-4000-8000-000000000101','Luxxfam LLC',    'Luxxfam',   'Wellness','Active'),
  ('20000000-0000-4000-8000-000000000102','Bu faisal LLC', 'Bu faisal', 'F&B',     'Active'),
  ('20000000-0000-4000-8000-000000000103','Al towba LLC',  'Al towba',  'Perfumes','Active'),
  ('20000000-0000-4000-8000-000000000104','Mrg Trading',    'Mrg',       'Retail',  'Active'),
  ('20000000-0000-4000-8000-000000000105','Happy town Co',  'Happy town','Entertainment','Active'),
  ('20000000-0000-4000-8000-000000000107','Drifthome LLC',  'Drifthome', 'Interiors','Paused'),
  ('20000000-0000-4000-8000-000000000108','Yogeeta Studio', 'Yogeeta',   'Fashion', 'Active'),
  ('20000000-0000-4000-8000-000000000109','Qavalli Lounge', 'Qavalli',   'Hospitality','Active')
) as v(id, legal_name, brand_name, industry, status)
on conflict (id) do update set
  brand_name = excluded.brand_name,
  legal_name = excluded.legal_name,
  status = excluded.status;

-- 5. Give Production & Operations Head (Manav's role PRODUCTION_HEAD) full leads access & assignment rights
update public.role_permissions
   set can_view = true,
       can_create = true,
       can_edit = true,
       can_assign = true,
       can_export = true,
       scope = 'ALL'::access_scope
 where module = 'leads'
   and role_id in (select id from public.roles where code in ('PRODUCTION_HEAD', 'OPSHR_HEAD', 'SOCIAL_HEAD', 'SALES_HEAD'));

-- 6. Seed auth.users for all team members with password 'Password123!'
do $$
declare
  v_enc_pass text := extensions.crypt('Password123!', extensions.gen_salt('bf'));
begin
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key,
    aud varchar(255),
    role varchar(255),
    email varchar(255) unique,
    encrypted_password varchar(255),
    email_confirmed_at timestamptz,
    invited_at timestamptz,
    confirmation_token varchar(255),
    confirmation_sent_at timestamptz,
    recovery_token varchar(255),
    recovery_sent_at timestamptz,
    email_change_token_new varchar(255),
    email_change varchar(255),
    email_change_sent_at timestamptz,
    last_sign_in_at timestamptz,
    raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}',
    raw_user_meta_data jsonb default '{}',
    is_super_admin boolean,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    phone varchar(255) default null,
    phone_confirmed_at timestamptz default null,
    phone_change varchar(255) default '',
    phone_change_token varchar(255) default '',
    phone_change_sent_at timestamptz default null,
    confirmed_at timestamptz default now(),
    email_change_token_current varchar(255) default '',
    email_change_confirm_status smallint default 0,
    banned_until timestamptz default null,
    reauthentication_token varchar(255) default '',
    reauthentication_sent_at timestamptz default null,
    is_sso_user boolean default false,
    deleted_at timestamptz default null
  );

  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, confirmed_at)
  select u.auth_id, 'authenticated', 'authenticated', u.email, v_enc_pass, now(), now()
  from public.users u
  where u.auth_id is not null
  on conflict (id) do update set
    email = excluded.email,
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at;
end $$;
