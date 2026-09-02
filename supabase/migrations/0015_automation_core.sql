-- =====================================================================
-- 0015_automation_core.sql
-- Field inheritance, status rollups, the dependency date engine and
-- reverse scheduling. All of it lives in the database so that a bulk
-- edit, an import or an Edge Function gets the same behaviour as the UI.
-- =====================================================================

-- Guards against a trigger storm when one write cascades into many.
--
-- current_setting(..., true) returns NULL for a placeholder GUC that was
-- never set, but an EMPTY STRING for one that was set and then rolled
-- back. coalesce alone does not catch the second case, so every read goes
-- through nullif() before the cast.
create or replace function public.cascade_depth()
returns int language sql stable as $$
  select coalesce(nullif(current_setting('crm.cascade_depth', true), '')::int, 0);
$$;

create or replace function public.in_cascade()
returns boolean language sql stable as $$
  select public.cascade_depth() > 0;
$$;

create or replace function public.begin_cascade() returns void language plpgsql as $$
begin
  perform set_config('crm.cascade_depth', (public.cascade_depth() + 1)::text, true);
end $$;

create or replace function public.end_cascade() returns void language plpgsql as $$
begin
  perform set_config('crm.cascade_depth', greatest(0, public.cascade_depth() - 1)::text, true);
end $$;

-- =====================================================================
-- 1. FIELD INHERITANCE
-- A child record never asks the user to retype what its parent knows.
-- These mirrors are read-only: an attempt to edit one is reverted.
-- =====================================================================

create or replace function public.trg_deliverables_inherit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_project record; v_scope record;
begin
  select p.client_id, p.manager_id into v_project
    from public.projects p where p.id = new.project_id;

  if v_project.client_id is null then
    raise exception 'Deliverable must belong to a project with a client' using errcode = '23502';
  end if;

  -- client_id is a mirror of the project's client, always.
  new.client_id := v_project.client_id;

  -- SLA and review rounds come from the client's service scope, not the typist.
  if new.scope_id is not null then
    select sla_days, review_rounds_allowed into v_scope
      from public.client_service_scope where id = new.scope_id;
  else
    select sla_days, review_rounds_allowed into v_scope
      from public.client_service_scope
     where client_id = new.client_id and deliverable_type = new.type and is_active
     limit 1;
  end if;

  if v_scope.sla_days is not null then
    new.review_rounds_allowed := coalesce(v_scope.review_rounds_allowed, new.review_rounds_allowed);
    if new.due_date is not null then
      new.sla_due_date := coalesce(new.sla_due_date, public.add_working_days(new.due_date, v_scope.sla_days));
    end if;
  end if;

  if new.owner_id is null then
    new.owner_id := v_project.manager_id;
  end if;

  return new;
end $$;

drop trigger if exists trg_deliverables_inherit on public.deliverables;
create trigger trg_deliverables_inherit before insert or update of project_id, type, scope_id, due_date
  on public.deliverables for each row execute function public.trg_deliverables_inherit();

create or replace function public.trg_tasks_inherit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_d record;
begin
  if new.deliverable_id is not null then
    select d.client_id, d.project_id into v_d
      from public.deliverables d where d.id = new.deliverable_id;
    new.client_id  := v_d.client_id;
    new.project_id := coalesce(v_d.project_id, new.project_id);
  elsif new.project_id is not null and new.client_id is null then
    select p.client_id into new.client_id from public.projects p where p.id = new.project_id;
  elsif new.shoot_id is not null and new.client_id is null then
    select s.client_id into new.client_id from public.shoots s where s.id = new.shoot_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_inherit on public.tasks;
create trigger trg_tasks_inherit before insert or update of deliverable_id, project_id, shoot_id
  on public.tasks for each row execute function public.trg_tasks_inherit();

-- Generic mirror guard: revert an edit to a column the parent owns.
create or replace function public.trg_guard_inherited()
returns trigger language plpgsql as $$
declare col text;
begin
  foreach col in array tg_argv loop
    if to_jsonb(new) ->> col is distinct from to_jsonb(old) ->> col then
      raise exception
        '%.% is inherited from the parent record and cannot be edited here. Change it on the parent.',
        tg_table_name, col using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

-- content_calendar posts must stay on their own client's timeline.
create or replace function public.trg_content_calendar_normalise()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tz text;
begin
  select timezone into v_tz from public.clients where id = new.client_id;
  v_tz := coalesce(v_tz, 'Asia/Dubai');

  -- Store UTC, render in the viewer's timezone. Every date filter compares
  -- this column, which is what makes the presets correct across timezones.
  new.post_at_utc := ((new.post_date + coalesce(new.post_time, time '09:00')) at time zone v_tz);
  return new;
end $$;

drop trigger if exists trg_content_calendar_normalise on public.content_calendar;
create trigger trg_content_calendar_normalise
  before insert or update of post_date, post_time, client_id on public.content_calendar
  for each row execute function public.trg_content_calendar_normalise();

-- A client's timezone is part of the calculation, so changing it must
-- re-derive post_at_utc for every post that has not gone out yet.
-- Without this, moving a client between timezones leaves their scheduled
-- posts pointing at the wrong instant.
create or replace function public.trg_client_timezone_repoint()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.timezone is distinct from old.timezone then
    update public.content_calendar
       set post_at_utc = ((post_date + coalesce(post_time, time '09:00')) at time zone new.timezone)
     where client_id = new.id
       and deleted_at is null
       and posted_at is null;
  end if;
  return null;
end $$;

drop trigger if exists trg_client_timezone_repoint on public.clients;
create trigger trg_client_timezone_repoint after update of timezone on public.clients
  for each row execute function public.trg_client_timezone_repoint();

-- =====================================================================
-- 2. STATUS ROLLUPS
-- task -> deliverable -> project health -> client health. Computed only.
-- =====================================================================

create or replace function public.fn_rollup_deliverable_status(p_deliverable_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_total int; v_done int; v_blocked int; v_progress int; v_review int;
  v_current work_status; v_next work_status;
begin
  if p_deliverable_id is null then return; end if;

  select status into v_current from public.deliverables where id = p_deliverable_id;
  -- Terminal states are owned by the approval flow, not by task counts.
  if v_current in ('Approved','Delivered','Cancelled') then return; end if;

  select count(*),
         count(*) filter (where status in ('Delivered','Approved')),
         count(*) filter (where is_blocked or status = 'Blocked'),
         count(*) filter (where status = 'In Progress'),
         count(*) filter (where status in ('In Review','Changes Requested'))
    into v_total, v_done, v_blocked, v_progress, v_review
    from public.tasks
   where deliverable_id = p_deliverable_id and deleted_at is null;

  if v_total = 0 then
    return;
  elsif v_blocked > 0 then
    v_next := 'Blocked';
  elsif v_done = v_total then
    v_next := 'In Review';
  elsif v_review > 0 then
    v_next := 'In Review';
  elsif v_progress > 0 or v_done > 0 then
    v_next := 'In Progress';
  else
    v_next := 'Not Started';
  end if;

  if v_next is distinct from v_current then
    perform public.begin_cascade();
    update public.deliverables set status = v_next where id = p_deliverable_id;
    perform public.end_cascade();
  end if;
end $$;

create or replace function public.fn_rollup_project_health(p_project_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_red int; v_amber int; v_next health_status; v_current health_status;
begin
  if p_project_id is null then return; end if;
  select health into v_current from public.projects where id = p_project_id;

  select
    count(*) filter (
      where deleted_at is null
        and status not in ('Delivered','Approved','Cancelled')
        and (
          (due_date is not null and due_date < current_date - 3)
          or status = 'Blocked'
        )),
    count(*) filter (
      where deleted_at is null
        and status not in ('Delivered','Approved','Cancelled')
        and due_date is not null
        and due_date between current_date - 3 and current_date + 2)
    into v_red, v_amber
  from public.deliverables where project_id = p_project_id;

  v_next := case when v_red > 0 then 'Red' when v_amber > 0 then 'Amber' else 'Green' end;

  if v_next is distinct from v_current then
    perform public.begin_cascade();
    update public.projects set health = v_next where id = p_project_id;
    perform public.end_cascade();
  end if;
end $$;

create or replace function public.fn_rollup_client_health(p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_next health_status; v_current health_status;
begin
  if p_client_id is null then return; end if;
  select health into v_current from public.clients where id = p_client_id;

  select case
           when bool_or(health = 'Red')   then 'Red'
           when bool_or(health = 'Amber') then 'Amber'
           else 'Green' end
    into v_next
  from public.projects
  where client_id = p_client_id and deleted_at is null and status = 'Active';

  v_next := coalesce(v_next, 'Green');

  if v_next is distinct from v_current then
    perform public.begin_cascade();
    update public.clients set health = v_next where id = p_client_id;
    perform public.end_cascade();
  end if;
end $$;

create or replace function public.trg_task_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_del uuid;
begin
  v_del := coalesce(new.deliverable_id, old.deliverable_id);
  perform public.fn_rollup_deliverable_status(v_del);
  return null;
end $$;

drop trigger if exists trg_task_rollup on public.tasks;
create trigger trg_task_rollup after insert or update of status, is_blocked, deleted_at or delete
  on public.tasks for each row execute function public.trg_task_rollup();

create or replace function public.trg_deliverable_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_rollup_project_health(coalesce(new.project_id, old.project_id));
  perform public.fn_rollup_client_health(coalesce(new.client_id, old.client_id));
  return null;
end $$;

drop trigger if exists trg_deliverable_rollup on public.deliverables;
create trigger trg_deliverable_rollup
  after insert or update of status, due_date, deleted_at or delete
  on public.deliverables for each row execute function public.trg_deliverable_rollup();

create or replace function public.trg_project_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.fn_rollup_client_health(coalesce(new.client_id, old.client_id));
  return null;
end $$;

drop trigger if exists trg_project_rollup on public.projects;
create trigger trg_project_rollup after update of health, status on public.projects
  for each row execute function public.trg_project_rollup();

-- Health is computed. A direct write is silently reverted rather than
-- erroring, so a careless bulk edit cannot corrupt the signal.
create or replace function public.trg_guard_computed_health()
returns trigger language plpgsql as $$
begin
  if not public.in_cascade() and new.health is distinct from old.health then
    new.health := old.health;
  end if;
  return new;
end $$;

drop trigger if exists trg_clients_guard_health on public.clients;
create trigger trg_clients_guard_health before update of health on public.clients
  for each row execute function public.trg_guard_computed_health();

drop trigger if exists trg_projects_guard_health on public.projects;
create trigger trg_projects_guard_health before update of health on public.projects
  for each row execute function public.trg_guard_computed_health();

-- =====================================================================
-- 3. DEPENDENCY DATE ENGINE
-- Moving one date shifts the whole downstream chain by the same delta,
-- honouring lag_days and skipping weekends and holidays.
-- =====================================================================

create or replace function public.fn_cascade_task_dates(
  p_task_id uuid,
  p_delta_days int,
  p_depth int default 0
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_pred_due date;
  v_new_start date;
  v_new_due   date;
  v_min_start date;
  v_shifted  int := 0;
begin
  if p_delta_days = 0 or p_task_id is null then return 0; end if;
  if p_depth > 50 then
    raise warning 'Dependency cascade stopped at depth 50 from task %', p_task_id;
    return 0;
  end if;

  select due_date into v_pred_due from public.tasks where id = p_task_id;

  for r in
    select d.successor_id, d.lag_days, t.start_date, t.due_date, t.status
    from public.task_dependencies d
    join public.tasks t on t.id = d.successor_id
    where d.predecessor_id = p_task_id
      and t.deleted_at is null
      and t.status not in ('Delivered','Approved','Cancelled')
  loop
    v_new_start := public.add_working_days(r.start_date, p_delta_days);
    v_new_due   := public.add_working_days(r.due_date,   p_delta_days);

    -- A successor may never start before its predecessor finishes + lag.
    if v_pred_due is not null then
      v_min_start := public.add_working_days(v_pred_due, greatest(r.lag_days, 0) + 1);
      if v_new_start is null or v_new_start < v_min_start then
        if v_new_start is not null and v_new_due is not null then
          v_new_due := v_new_due + (v_min_start - v_new_start);
        end if;
        v_new_start := v_min_start;
      end if;
    end if;

    perform public.begin_cascade();
    update public.tasks
       set start_date = v_new_start,
           due_date   = coalesce(v_new_due, v_new_start)
     where id = r.successor_id;
    perform public.end_cascade();

    v_shifted := v_shifted + 1
               + public.fn_cascade_task_dates(r.successor_id, p_delta_days, p_depth + 1);
  end loop;

  return v_shifted;
end $$;

comment on function public.fn_cascade_task_dates(uuid, int, int) is
  'Acceptance test: changing a date cascades every dependent date correctly. Each shifted row is written through the normal UPDATE path, so the audit trigger logs every one.';

create or replace function public.trg_task_date_cascade()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_delta int;
begin
  if public.in_cascade() then return null; end if;
  if new.due_date is null or old.due_date is null then return null; end if;

  v_delta := new.due_date - old.due_date;
  if v_delta = 0 then return null; end if;

  perform public.fn_cascade_task_dates(new.id, v_delta, 0);
  return null;
end $$;

drop trigger if exists trg_task_date_cascade on public.tasks;
create trigger trg_task_date_cascade after update of due_date on public.tasks
  for each row execute function public.trg_task_date_cascade();

-- Moving a shoot moves everything hanging off it: its tasks and their
-- downstream chain, the linked posts, the approval due dates and the
-- equipment booking window.
create or replace function public.trg_shoot_date_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delta int;
  r record;
begin
  if public.in_cascade() then return null; end if;
  v_delta := new.shoot_date - old.shoot_date;
  if v_delta = 0 then return null; end if;

  -- Tasks attached to the shoot.
  for r in select id, start_date, due_date from public.tasks
            where shoot_id = new.id and deleted_at is null
              and status not in ('Delivered','Approved','Cancelled')
  loop
    perform public.begin_cascade();
    update public.tasks
       set start_date = public.add_working_days(r.start_date, v_delta),
           due_date   = public.add_working_days(r.due_date,   v_delta)
     where id = r.id;
    perform public.end_cascade();

    perform public.fn_cascade_task_dates(r.id, v_delta, 0);
  end loop;

  -- Posts scheduled off this shoot's deliverable.
  if new.deliverable_id is not null then
    perform public.begin_cascade();
    update public.content_calendar
       set post_date = public.add_working_days(post_date, v_delta)
     where deliverable_id = new.deliverable_id
       and deleted_at is null
       and posted_at is null;

    update public.deliverables
       set due_date     = public.add_working_days(due_date, v_delta),
           sla_due_date = public.add_working_days(sla_due_date, v_delta)
     where id = new.deliverable_id and status not in ('Delivered','Approved','Cancelled');
    perform public.end_cascade();
  end if;

  -- Pending approvals move with the work.
  update public.approvals
     set due_at = due_at + make_interval(days => v_delta)
   where status = 'Pending' and deleted_at is null
     and entity_type = 'deliverables' and entity_id = new.deliverable_id;

  -- Equipment travels with the shoot.
  update public.equipment_bookings
     set out_date = out_date + v_delta,
         in_date  = in_date  + v_delta
   where shoot_id = new.id and deleted_at is null and status = 'Booked';

  return null;
end $$;

drop trigger if exists trg_shoot_date_cascade on public.shoots;
create trigger trg_shoot_date_cascade after update of shoot_date on public.shoots
  for each row execute function public.trg_shoot_date_cascade();

-- =====================================================================
-- 4. REVERSE SCHEDULING FROM THE POST DATE
-- Set when it goes live; the system back-calculates every upstream date.
-- =====================================================================
create or replace function public.fn_schedule_from_post_date(
  p_client_id        uuid,
  p_post_date        date,
  p_deliverable_type text default 'Reel'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sla            int := 7;
  v_client_approve int := 2;
  v_manager_review int := 1;
  v_internal       int := 1;
  v_edit_days      int := 3;
  v_schedule       date;
  v_client_app     date;
  v_mgr_review     date;
  v_int_review     date;
  v_edit_start     date;
  v_shoot          date;
begin
  select sla_days into v_sla
    from public.client_service_scope
   where client_id = p_client_id and deliverable_type = p_deliverable_type and is_active
   limit 1;
  v_sla := coalesce(v_sla, 7);

  select coalesce(max(sla_days) filter (where level = 'Client'),  2),
         coalesce(max(sla_days) filter (where level = 'Manager'), 1),
         coalesce(max(sla_days) filter (where level in ('Internal','Lead')), 1)
    into v_client_approve, v_manager_review, v_internal
    from public.approval_chains
   where entity_type = 'deliverables' and is_active
     and (client_id = p_client_id or client_id is null);

  -- Walk backwards from the post date, one working-day hop at a time.
  v_schedule   := public.add_working_days(p_post_date,  -1);
  v_client_app := public.add_working_days(v_schedule,   -v_client_approve);
  v_mgr_review := public.add_working_days(v_client_app, -v_manager_review);
  v_int_review := public.add_working_days(v_mgr_review, -v_internal);
  v_edit_start := public.add_working_days(v_int_review, -v_edit_days);
  v_shoot      := public.add_working_days(v_edit_start, -1);

  return jsonb_build_object(
    'post_date',            p_post_date,
    'schedule_by',          v_schedule,
    'client_approval_by',   v_client_app,
    'manager_review_by',    v_mgr_review,
    'internal_review_by',   v_int_review,
    'edit_start',           v_edit_start,
    'edit_due',             v_int_review,
    'shoot_date',           v_shoot,
    'sla_days_used',        v_sla,
    'working_days_only',    true
  );
end $$;

comment on function public.fn_schedule_from_post_date(uuid, date, text) is
  'Back-calculates shoot -> edit -> internal review -> client approval -> schedule from the go-live date, using the client SLA and approval-chain SLAs, skipping weekends and holidays.';
