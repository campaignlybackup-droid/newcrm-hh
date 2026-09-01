-- =====================================================================
-- 0007_social.sql
-- Content calendar and campaigns.
-- campaigns has NO budget, spend, bid, CPM, CPC, ROAS or currency
-- column. A campaign is a date range, an objective and a status.
-- =====================================================================

create table if not exists public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete set null,
  name         text not null,
  platform     social_platform not null,
  objective    campaign_objective not null default 'Awareness',
  start_date   date not null,
  end_date     date,
  status       work_status not null default 'Not Started',
  owner_id     uuid references public.users(id),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  constraint campaigns_dates_chk check (end_date is null or end_date >= start_date)
);

comment on table public.campaigns is
  'Campaign planning without money. Budget, spend, bid strategy and any performance metric expressed in currency are out of scope by design.';

create table if not exists public.content_calendar (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  campaign_id    uuid references public.campaigns(id) on delete set null,
  deliverable_id uuid references public.deliverables(id) on delete set null,
  pillar_id      uuid references public.content_pillars(id) on delete set null,
  platform       social_platform not null,
  post_date      date not null,
  post_time      time,
  post_at_utc    timestamptz,        -- computed from post_date/time + client timezone (0015)
  content_type   content_type not null default 'Reel',
  title          text,
  hook           text,
  caption        text,
  hashtags       text[] not null default '{}',
  cta            text,
  asset_id       uuid,               -- FK added in 0008
  owner_id       uuid references public.users(id),
  reviewer_id    uuid references public.users(id),
  status         work_status not null default 'Not Started',
  approval_status approval_state not null default 'Draft',
  published_url  text,
  posted_at      timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.users(id),
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id)
);

comment on table public.content_calendar is
  'One row per scheduled post. post_at_utc is the canonical instant (UTC); post_date/post_time are the client-local intent. Every calendar filter compares post_at_utc so date presets are correct across timezones.';

create index if not exists campaigns_client_idx  on public.campaigns (client_id) where deleted_at is null;
create index if not exists campaigns_owner_idx   on public.campaigns (owner_id) where deleted_at is null;
create index if not exists campaigns_created_by_idx on public.campaigns (created_by);
create index if not exists campaigns_dates_idx   on public.campaigns (start_date, end_date);
create index if not exists campaigns_status_idx  on public.campaigns (status) where deleted_at is null;

create index if not exists content_calendar_client_idx    on public.content_calendar (client_id) where deleted_at is null;
create index if not exists content_calendar_owner_idx     on public.content_calendar (owner_id) where deleted_at is null;
create index if not exists content_calendar_reviewer_idx  on public.content_calendar (reviewer_id) where deleted_at is null;
create index if not exists content_calendar_created_by_idx on public.content_calendar (created_by);
create index if not exists content_calendar_project_idx   on public.content_calendar (project_id);
create index if not exists content_calendar_campaign_idx  on public.content_calendar (campaign_id);
create index if not exists content_calendar_post_date_idx on public.content_calendar (post_date) where deleted_at is null;
create index if not exists content_calendar_post_utc_idx  on public.content_calendar (post_at_utc) where deleted_at is null;
create index if not exists content_calendar_status_idx    on public.content_calendar (status) where deleted_at is null;
create index if not exists content_calendar_approval_idx  on public.content_calendar (approval_status) where deleted_at is null;
create index if not exists content_calendar_client_date_cover_idx
  on public.content_calendar (client_id, post_at_utc)
  include (platform, content_type, status, approval_status, title)
  where deleted_at is null;

do $$
declare t text;
begin
  foreach t in array array['campaigns','content_calendar'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
