-- =====================================================================
-- 0024_founder_availability.sql
-- Founder Availability & Office Hours table. Read by all active users,
-- updated only by Founders (level <= 1) with full audit log history.
-- =====================================================================

create table if not exists public.founder_availability (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'Available' check (status in ('Available', 'In Meeting', 'Busy', 'Out of Office', 'On Leave')),
  status_note  text,
  location     text default 'Dubai HQ',
  timezone     text not null default 'Asia/Dubai',
  weekly_slots jsonb not null default '[
    {"day": "Monday", "working": true, "start": "10:00", "end": "19:00", "open_hours": "14:00 - 16:00 (Team Sync)"},
    {"day": "Tuesday", "working": true, "start": "10:00", "end": "19:00", "open_hours": "15:00 - 17:00 (Client Reviews)"},
    {"day": "Wednesday", "working": true, "start": "10:00", "end": "19:00", "open_hours": "11:00 - 13:00 (Strategy)"},
    {"day": "Thursday", "working": true, "start": "10:00", "end": "19:00", "open_hours": "14:00 - 16:00 (Approvals)"},
    {"day": "Friday", "working": true, "start": "10:00", "end": "17:00", "open_hours": "11:00 - 14:00 (Open Door)"},
    {"day": "Saturday", "working": false, "start": null, "end": null, "open_hours": "Weekend"},
    {"day": "Sunday", "working": false, "start": null, "end": null, "open_hours": "Weekend"}
  ]'::jsonb,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.users(id)
);

comment on table public.founder_availability is
  'Founder real-time availability status and weekly office hours calendar readable by all team members.';

-- Enable RLS
alter table public.founder_availability enable row level security;

-- 1. Read Policy: All authenticated active team members can view Founder availability
drop policy if exists founder_availability_select on public.founder_availability;
create policy founder_availability_select on public.founder_availability
  for select
  using (public.auth_is_active());

-- 2. Write Policy: Founder (level <= 1) can update status & schedule
drop policy if exists founder_availability_update on public.founder_availability;
create policy founder_availability_update on public.founder_availability
  for update
  using (public.is_founder());

drop policy if exists founder_availability_insert on public.founder_availability;
create policy founder_availability_insert on public.founder_availability
  for insert
  with check (public.is_founder());

-- Seed initial row if table is empty
insert into public.founder_availability (status, status_note, location, timezone)
select 'Available', 'In Office — Open for approvals and strategy syncs', 'Dubai HQ', 'Asia/Dubai'
where not exists (select 1 from public.founder_availability);
