-- =====================================================================
-- 0003_clients.sql
-- The client master record — the single source of truth.
--
-- GOVERNING RULE: a client's information is typed once, here. Every other
-- module stores client_id and RENDERS this data. No module keeps a copy a
-- user has to retype. Migration 0015 installs inheritance triggers that
-- populate child records from this row and reject edits to the mirrors.
-- =====================================================================

create sequence if not exists public.client_code_seq start 1001;

create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  client_code         text not null unique default ('CL-' || nextval('public.client_code_seq')::text),
  legal_name          text not null,
  brand_name          text not null,
  industry            text,
  city                text,
  country             text default 'India',
  timezone            text not null default 'Asia/Kolkata',
  website             text,
  logo_url            text,
  status              client_status not null default 'Lead',
  health              health_status not null default 'Green',   -- computed by rollup, never set by hand
  source              text,
  priority            priority_level not null default 'Medium',
  onboarding_date     date,
  contract_start_date date,
  contract_end_date   date,
  renewal_date        date,
  notice_period_days  int check (notice_period_days is null or notice_period_days >= 0),
  account_manager_id  uuid references public.users(id),
  service_tags        text[] not null default '{}',
  notes               text,
  converted_from_lead uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.users(id),
  deleted_at          timestamptz,
  deleted_by          uuid references public.users(id),
  constraint clients_contract_dates_chk
    check (contract_end_date is null or contract_start_date is null or contract_end_date >= contract_start_date)
);

comment on table public.clients is
  'Client master. NO commercial terms are stored: contract value, retainer amount, rate and currency are deliberately absent. Commercial lifecycle is expressed purely as dates and status.';
comment on column public.clients.health is
  'Rolled up from project health by fn_rollup_client_health(). Direct writes are reverted by trg_clients_guard_health.';

-- Now that clients exists, make the internal/external user shape a real rule.
-- Written drop-then-add so replaying this migration on an existing
-- database is a no-op rather than a duplicate-object error.
alter table public.users drop constraint if exists users_client_id_fkey;
alter table public.users
  add constraint users_client_id_fkey foreign key (client_id) references public.clients(id) on delete cascade;

alter table public.users drop constraint if exists users_external_shape_chk;

-- ---------------------------------------------------------------------
-- Contacts (POCs)
-- ---------------------------------------------------------------------
create table if not exists public.client_contacts (
  id                       uuid primary key default gen_random_uuid(),
  client_id                uuid not null references public.clients(id) on delete cascade,
  name                     text not null,
  designation              text,
  email                    text,
  phone                    text,
  whatsapp                 text,
  is_primary               boolean not null default false,
  is_decision_maker        boolean not null default false,
  preferred_contact_window text,
  birthday                 date,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references public.users(id),
  deleted_at               timestamptz,
  deleted_by               uuid references public.users(id)
);

-- Exactly one primary POC per client.
create unique index if not exists client_contacts_one_primary_uidx
  on public.client_contacts (client_id) where is_primary and deleted_at is null;

create index if not exists client_contacts_email_lower_idx
  on public.client_contacts (lower(email)) where email is not null and deleted_at is null;

-- ---------------------------------------------------------------------
-- Brand kit — inherited by every deliverable, post and shoot brief
-- ---------------------------------------------------------------------
create table if not exists public.client_brand_kit (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null unique references public.clients(id) on delete cascade,
  logo_files            jsonb not null default '[]',   -- [{name,url,variant}]
  colour_hex_list       text[] not null default '{}',
  fonts                 jsonb not null default '[]',   -- [{name,usage,url}]
  tone_of_voice_notes   text,
  do_list               text[] not null default '{}',
  dont_list             text[] not null default '{}',
  brand_guideline_url   text,
  reference_links       jsonb not null default '[]',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references public.users(id),
  deleted_at            timestamptz,
  deleted_by            uuid references public.users(id)
);

-- CHECK constraints cannot contain subqueries, so the array test lives in an
-- IMMUTABLE helper.
create or replace function public.are_hex_colours(p_colours text[])
returns boolean language sql immutable parallel safe as $fn$
  select coalesce(bool_and(c ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$'), true)
  from unnest(coalesce(p_colours, '{}')) c;
$fn$;

alter table public.client_brand_kit drop constraint if exists client_brand_kit_colours_chk;
alter table public.client_brand_kit add constraint client_brand_kit_colours_chk
  check (public.are_hex_colours(colour_hex_list));

-- ---------------------------------------------------------------------
-- Social accounts — ACCESS STATUS ONLY. No password, token or secret
-- field exists here by design, and 0013 guards against one being added.
-- ---------------------------------------------------------------------
create table if not exists public.client_social_accounts (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  platform          social_platform not null,
  handle            text,
  url               text,
  follower_snapshot int check (follower_snapshot is null or follower_snapshot >= 0),
  snapshot_date     date,
  access_status     access_status not null default 'Pending',
  access_note       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.users(id),
  deleted_at        timestamptz,
  deleted_by        uuid references public.users(id),
  unique (client_id, platform, handle)
);

comment on table public.client_social_accounts is
  'Records WHETHER we have access, never HOW. Credentials, tokens and API keys are out of scope for this system and must live in the agency password manager.';

-- ---------------------------------------------------------------------
-- Service scope — the row that generates work every cycle
-- ---------------------------------------------------------------------
create table if not exists public.client_service_scope (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  deliverable_type      text not null,
  qty_per_cycle         int  not null default 1 check (qty_per_cycle > 0),
  cycle_length_days     int  not null default 30 check (cycle_length_days > 0),
  sla_days              int  not null default 7 check (sla_days >= 0),
  review_rounds_allowed int  not null default 2 check (review_rounds_allowed >= 0),
  default_owner_id      uuid references public.users(id),
  task_template_id      uuid,
  platform              social_platform,
  notes                 text,
  is_active             boolean not null default true,
  starts_on             date,
  ends_on               date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references public.users(id),
  deleted_at            timestamptz,
  deleted_by            uuid references public.users(id),
  unique (client_id, deliverable_type)
);

comment on table public.client_service_scope is
  'Scope is expressed as quantity + SLA + review rounds. There is no rate, price or retainer amount: what we owe is a count and a date, not a sum.';

-- ---------------------------------------------------------------------
-- Documents — contracts, briefs, NDAs (files and dates only)
-- ---------------------------------------------------------------------
create table if not exists public.client_documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  doc_type      text not null,          -- Contract | Brief | NDA | SOW | Other
  title         text not null,
  file_url      text,
  external_link text,
  signed_on     date,
  effective_on  date,
  expires_on    date,
  is_confidential boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

-- ---------------------------------------------------------------------
-- Client team assignment — the horizontal (TEAM) visibility axis
-- ---------------------------------------------------------------------
create table if not exists public.client_team_members (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  role_on_account text,
  is_lead     boolean not null default false,
  added_at    timestamptz not null default now(),
  added_by    uuid references public.users(id),
  unique (client_id, user_id)
);

comment on table public.client_team_members is
  'Assignment axis of the visibility model. Being listed here grants TEAM-scope sight of the client and its work, independently of the reporting tree.';

-- ---------------------------------------------------------------------
-- Content pillars (per client, drives the calendar)
-- ---------------------------------------------------------------------
create table if not exists public.content_pillars (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text not null,
  description text,
  target_mix_pct int check (target_mix_pct is null or target_mix_pct between 0 and 100),
  colour_hex  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id),
  unique (client_id, name)
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
create index if not exists clients_account_manager_idx on public.clients (account_manager_id) where deleted_at is null;
create index if not exists clients_status_idx          on public.clients (status) where deleted_at is null;
create index if not exists clients_renewal_date_idx    on public.clients (renewal_date) where deleted_at is null;
create index if not exists clients_contract_end_idx    on public.clients (contract_end_date) where deleted_at is null;
create index if not exists clients_brand_trgm_idx      on public.clients using gin (brand_name extensions.gin_trgm_ops);
create index if not exists clients_legal_trgm_idx      on public.clients using gin (legal_name extensions.gin_trgm_ops);
create index if not exists clients_deleted_at_idx      on public.clients (deleted_at);

create index if not exists client_contacts_client_idx        on public.client_contacts (client_id);
create index if not exists client_social_accounts_client_idx on public.client_social_accounts (client_id);
create index if not exists client_service_scope_client_idx   on public.client_service_scope (client_id);
create index if not exists client_documents_client_idx       on public.client_documents (client_id);
create index if not exists client_documents_expires_idx      on public.client_documents (expires_on) where deleted_at is null;
create index if not exists client_team_members_user_idx      on public.client_team_members (user_id);
create index if not exists client_team_members_client_idx    on public.client_team_members (client_id);
create index if not exists content_pillars_client_idx        on public.content_pillars (client_id);

do $$
declare t text;
begin
  foreach t in array array['clients','client_contacts','client_brand_kit','client_social_accounts',
                           'client_service_scope','client_documents','content_pillars']
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
