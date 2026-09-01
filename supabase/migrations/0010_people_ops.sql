-- =====================================================================
-- 0010_people_ops.sql
-- People operations expressed entirely in dates, availability and
-- workload. NO compensation of any kind: no salary, CTC, hourly rate,
-- bonus, increment or reimbursement column exists here.
-- =====================================================================

create table if not exists public.holidays (
  id         uuid primary key default gen_random_uuid(),
  holiday_on date not null,
  name       text not null,
  country    text not null default 'India',
  is_optional boolean not null default false,
  created_at timestamptz not null default now(),
  unique (holiday_on, country)
);

comment on table public.holidays is
  'Consulted by the dependency date engine so a cascaded date never lands on a non-working day.';

create table if not exists public.leave_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  from_date    date not null,
  to_date      date not null,
  type         leave_type not null default 'Casual',
  is_half_day  boolean not null default false,
  reason       text,
  status       leave_status not null default 'Requested',
  approver_id  uuid references public.users(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  constraint leave_requests_dates_chk check (to_date >= from_date)
);

comment on table public.leave_requests is
  'Approved leave blocks auto-assignment, greys the person on every calendar and triggers a reassignment suggestion. Leave balance is a count of days, never an amount.';

-- A person cannot hold two approved leaves over the same days.
alter table public.leave_requests drop constraint if exists leave_requests_no_overlap;
alter table public.leave_requests
  add constraint leave_requests_no_overlap
  exclude using gist (
    user_id extensions.gist_uuid_ops with =,
    daterange(from_date, to_date, '[]') with &&
  )
  where (deleted_at is null and status = 'Approved');

create table if not exists public.availability (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  weekday      int not null check (weekday between 0 and 6),   -- 0 = Sunday
  is_working   boolean not null default true,
  start_time   time,
  end_time     time,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, weekday),
  constraint availability_times_chk check (end_time is null or start_time is null or end_time > start_time)
);

create table if not exists public.onboarding_checklists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  label       text not null,
  category    text,
  is_done     boolean not null default false,
  done_at     timestamptz,
  due_date    date,
  owner_id    uuid references public.users(id),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references public.users(id)
);

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  reviewer_id  uuid references public.users(id),
  period       text not null,                 -- e.g. 'FY26-Q1'
  period_start date,
  period_end   date,
  review_date  date not null default current_date,
  rating       numeric(3,1) check (rating is null or rating between 0 and 5),
  strengths    text,
  improvements text,
  notes        text,
  status       text not null default 'Draft' check (status in ('Draft','Shared','Acknowledged')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  unique (user_id, period)
);

comment on table public.reviews is
  'Performance reviews carry a rating and written feedback only. Salary, increment, bonus and band columns are deliberately absent — the hard rule applies to people ops too.';

-- ---------------------------------------------------------------------
-- Working-day helpers used by the dependency date engine
-- ---------------------------------------------------------------------
create or replace function public.is_working_day(p_date date, p_country text default 'India')
returns boolean language sql stable parallel safe as $$
  select extract(isodow from p_date) < 6
     and not exists (
       select 1 from public.holidays h
       where h.holiday_on = p_date and h.country = p_country and not h.is_optional
     );
$$;

-- Adds p_days working days, skipping weekends and non-optional holidays.
create or replace function public.add_working_days(p_date date, p_days int, p_country text default 'India')
returns date language plpgsql stable parallel safe as $$
declare
  v_date date := p_date;
  v_step int  := case when p_days < 0 then -1 else 1 end;
  v_left int  := abs(p_days);
begin
  if p_date is null then return null; end if;

  -- A zero-day shift still normalises onto the next working day.
  if v_left = 0 then
    while not public.is_working_day(v_date, p_country) loop
      v_date := v_date + 1;
    end loop;
    return v_date;
  end if;

  while v_left > 0 loop
    v_date := v_date + v_step;
    if public.is_working_day(v_date, p_country) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_date;
end $$;

-- Is this person on approved leave on this date?
create or replace function public.is_on_leave(p_user_id uuid, p_date date)
returns boolean language sql stable parallel safe security definer set search_path = public as $$
  select exists (
    select 1 from public.leave_requests lr
    where lr.user_id = p_user_id
      and lr.status = 'Approved'
      and lr.deleted_at is null
      and p_date between lr.from_date and lr.to_date
  );
$$;

create index if not exists leave_requests_user_idx     on public.leave_requests (user_id) where deleted_at is null;
create index if not exists leave_requests_approver_idx on public.leave_requests (approver_id) where deleted_at is null;
create index if not exists leave_requests_dates_idx    on public.leave_requests (from_date, to_date) where deleted_at is null;
create index if not exists leave_requests_status_idx   on public.leave_requests (status) where deleted_at is null;
create index if not exists availability_user_idx       on public.availability (user_id);
create index if not exists onboarding_checklists_user_idx on public.onboarding_checklists (user_id, sort_order);
create index if not exists reviews_user_idx            on public.reviews (user_id, review_date desc);
create index if not exists reviews_reviewer_idx        on public.reviews (reviewer_id);
create index if not exists holidays_date_idx           on public.holidays (holiday_on, country);

do $$
declare t text;
begin
  foreach t in array array['leave_requests','availability','onboarding_checklists','reviews'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
