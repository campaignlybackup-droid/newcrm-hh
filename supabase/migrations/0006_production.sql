-- =====================================================================
-- 0006_production.sql
-- Shoots, crew, shot lists, equipment and the call sheet.
-- Equipment double-booking is rejected by the DATABASE, not the UI.
-- =====================================================================

create table if not exists public.shot_lists (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients(id) on delete cascade,
  name        text not null,
  description text,
  is_template boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id)
);

create table if not exists public.shot_list_items (
  id            uuid primary key default gen_random_uuid(),
  shot_list_id  uuid not null references public.shot_lists(id) on delete cascade,
  sort_order    int not null default 0,
  shot_name     text not null,
  shot_type     text,          -- Wide | Mid | Close | Top | Detail | B-roll
  camera_move   text,
  duration_secs int check (duration_secs is null or duration_secs > 0),
  location_note text,
  talent_note   text,
  props         text[] not null default '{}',
  reference_url text,
  is_captured   boolean not null default false,
  captured_at   timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

create table if not exists public.shoots (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  deliverable_id uuid references public.deliverables(id) on delete set null,
  title          text not null,
  shoot_date     date not null,
  call_time      time,
  wrap_time      time,
  location_name  text,
  address        text,
  map_link       text,
  type           shoot_type not null default 'Reel',
  status         shoot_status not null default 'Tentative',
  brief          text,
  shot_list_id   uuid references public.shot_lists(id) on delete set null,
  weather_note   text,
  director_id    uuid references public.users(id),
  producer_id    uuid references public.users(id),
  call_sheet_url text,
  call_sheet_generated_at timestamptz,
  postponed_from date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.users(id),
  deleted_at     timestamptz,
  deleted_by     uuid references public.users(id),
  constraint shoots_times_chk check (wrap_time is null or call_time is null or wrap_time > call_time)
);

-- tasks.shoot_id FK, now that shoots exists
alter table public.tasks drop constraint if exists tasks_shoot_id_fkey;
alter table public.tasks
  add constraint tasks_shoot_id_fkey foreign key (shoot_id) references public.shoots(id) on delete set null;

create table if not exists public.shoot_crew (
  id                  uuid primary key default gen_random_uuid(),
  shoot_id            uuid not null references public.shoots(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  role_on_shoot       text not null,
  individual_call_time time,
  confirmed           boolean not null default false,
  confirmed_at        timestamptz,
  travel_note         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (shoot_id, user_id)
);

comment on table public.shoot_crew is
  'Crew assignment. There is no day rate, no per-diem and no payment status: a crew member is scheduled or not, confirmed or not.';

-- ---------------------------------------------------------------------
-- Equipment
-- ---------------------------------------------------------------------
create table if not exists public.equipment (
  id            uuid primary key default gen_random_uuid(),
  item_name     text not null,
  category      text,               -- Camera | Lens | Lighting | Audio | Grip | Drone | Storage
  serial_number text,
  asset_tag     text unique,
  condition     text not null default 'Good',
  is_active     boolean not null default true,
  owned         boolean not null default true,      -- owned vs rented-in (status, not cost)
  custodian_id  uuid references public.users(id),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

comment on column public.equipment.owned is
  'Ownership as a boolean status flag. Purchase price, rental rate and depreciation are deliberately absent — this is not an asset-finance system.';

create table if not exists public.equipment_bookings (
  id           uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references public.equipment(id) on delete cascade,
  shoot_id     uuid references public.shoots(id) on delete cascade,
  booked_for   uuid references public.users(id),
  out_date     date not null,
  in_date      date not null,
  purpose      text,
  status       text not null default 'Booked' check (status in ('Booked','Checked Out','Returned','Cancelled')),
  checked_out_at timestamptz,
  returned_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  constraint equipment_bookings_dates_chk check (in_date >= out_date)
);

-- HARD CONFLICT GUARD. One item cannot be out on two overlapping date
-- ranges. This is an exclusion constraint, so it holds under concurrency
-- and cannot be bypassed by the API, a bulk import or the SQL editor.
-- Cancelled and soft-deleted rows are excluded from the guard.
alter table public.equipment_bookings drop constraint if exists equipment_bookings_no_overlap;
alter table public.equipment_bookings
  add constraint equipment_bookings_no_overlap
  exclude using gist (
    equipment_id extensions.gist_uuid_ops with =,
    daterange(out_date, in_date, '[]') with &&
  )
  where (deleted_at is null and status <> 'Cancelled');

comment on constraint equipment_bookings_no_overlap on public.equipment_bookings is
  'Acceptance test: overlapping equipment bookings are rejected at the database level.';

-- ---------------------------------------------------------------------
-- Call sheet source view — one query builds the whole PDF
-- ---------------------------------------------------------------------
create or replace view public.v_call_sheet as
select
  s.id                as shoot_id,
  s.title,
  s.shoot_date,
  s.call_time,
  s.wrap_time,
  s.type,
  s.status,
  s.location_name,
  s.address,
  s.map_link,
  s.weather_note,
  s.brief,
  c.id                as client_id,
  c.brand_name,
  c.legal_name,
  c.timezone          as client_timezone,
  bk.logo_files,
  bk.colour_hex_list,
  p.name              as project_name,
  poc.name            as client_poc_name,
  poc.phone           as client_poc_phone,
  am.full_name        as account_manager_name,
  dir.full_name       as director_name,
  (
    select jsonb_agg(jsonb_build_object(
             'user_id', u.id,
             'name', u.full_name,
             'phone', u.phone,
             'role_on_shoot', sc.role_on_shoot,
             'call_time', coalesce(sc.individual_call_time, s.call_time),
             'confirmed', sc.confirmed
           ) order by sc.individual_call_time nulls last, u.full_name)
    from public.shoot_crew sc join public.users u on u.id = sc.user_id
    where sc.shoot_id = s.id
  ) as crew,
  (
    select jsonb_agg(jsonb_build_object(
             'sort_order', sli.sort_order,
             'shot_name', sli.shot_name,
             'shot_type', sli.shot_type,
             'camera_move', sli.camera_move,
             'duration_secs', sli.duration_secs,
             'props', sli.props,
             'reference_url', sli.reference_url,
             'is_captured', sli.is_captured
           ) order by sli.sort_order)
    from public.shot_list_items sli
    where sli.shot_list_id = s.shot_list_id and sli.deleted_at is null
  ) as shot_list,
  (
    select jsonb_agg(jsonb_build_object(
             'item_name', e.item_name,
             'category', e.category,
             'asset_tag', e.asset_tag,
             'out_date', eb.out_date,
             'in_date', eb.in_date
           ) order by e.category, e.item_name)
    from public.equipment_bookings eb join public.equipment e on e.id = eb.equipment_id
    where eb.shoot_id = s.id and eb.deleted_at is null and eb.status <> 'Cancelled'
  ) as equipment
from public.shoots s
join public.clients c            on c.id = s.client_id
left join public.client_brand_kit bk on bk.client_id = c.id
left join public.projects p      on p.id = s.project_id
left join public.client_contacts poc
       on poc.client_id = c.id and poc.is_primary and poc.deleted_at is null
left join public.users am        on am.id = c.account_manager_id
left join public.users dir       on dir.id = s.director_id
where s.deleted_at is null;

comment on view public.v_call_sheet is
  'Single-query source for the auto-generated call sheet PDF: client, brand kit, location, crew with individual call times, shot list and booked equipment.';

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
create index if not exists shoots_client_idx    on public.shoots (client_id) where deleted_at is null;
create index if not exists shoots_project_idx   on public.shoots (project_id) where deleted_at is null;
create index if not exists shoots_date_idx      on public.shoots (shoot_date) where deleted_at is null;
create index if not exists shoots_status_idx    on public.shoots (status) where deleted_at is null;
create index if not exists shoots_created_by_idx on public.shoots (created_by);
create index if not exists shoots_director_idx  on public.shoots (director_id);
create index if not exists shoots_producer_idx  on public.shoots (producer_id);

create index if not exists shoot_crew_user_idx  on public.shoot_crew (user_id);
create index if not exists shoot_crew_shoot_idx on public.shoot_crew (shoot_id);

create index if not exists equipment_custodian_idx on public.equipment (custodian_id);
create index if not exists equipment_bookings_equipment_idx on public.equipment_bookings (equipment_id, out_date);
create index if not exists equipment_bookings_shoot_idx     on public.equipment_bookings (shoot_id);
create index if not exists equipment_bookings_dates_idx     on public.equipment_bookings (out_date, in_date);

create index if not exists shot_lists_client_idx     on public.shot_lists (client_id);
create index if not exists shot_list_items_list_idx  on public.shot_list_items (shot_list_id, sort_order);

do $$
declare t text;
begin
  foreach t in array array['shoots','shoot_crew','equipment','equipment_bookings','shot_lists','shot_list_items'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
