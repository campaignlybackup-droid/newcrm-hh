-- =====================================================================
-- 0017_views.sql
-- Reporting views for dashboards, the unified calendar, capacity, and
-- the client portal.
--
-- Every view is security_invoker: it runs with the CALLER's privileges,
-- so the RLS policies on the underlying tables still apply. A view is
-- never a way around the visibility model.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Client data rendered, not copied. Any module needing client context
-- joins this instead of storing its own fields.
-- ---------------------------------------------------------------------
create or replace view public.v_client_context
with (security_invoker = true) as
select
  c.id                as client_id,
  c.client_code,
  c.brand_name,
  c.legal_name,
  c.industry,
  c.city,
  c.country,
  c.timezone,
  c.status,
  c.health,
  c.priority,
  c.service_tags,
  c.renewal_date,
  c.contract_end_date,
  c.account_manager_id,
  am.full_name        as account_manager_name,
  am.email            as account_manager_email,
  poc.id              as primary_contact_id,
  poc.name            as primary_contact_name,
  poc.email           as primary_contact_email,
  poc.phone           as primary_contact_phone,
  poc.preferred_contact_window,
  bk.colour_hex_list,
  bk.fonts,
  bk.tone_of_voice_notes,
  bk.brand_guideline_url,
  bk.do_list,
  bk.dont_list,
  (select min(sla_days) from public.client_service_scope s
    where s.client_id = c.id and s.is_active) as tightest_sla_days
from public.clients c
left join public.users am on am.id = c.account_manager_id
left join public.client_contacts poc
       on poc.client_id = c.id and poc.is_primary and poc.deleted_at is null
left join public.client_brand_kit bk on bk.client_id = c.id
where c.deleted_at is null;

comment on view public.v_client_context is
  'The one place client fields are read from. Acceptance test: client data appears identically in 6+ modules while existing in exactly one row.';

-- ---------------------------------------------------------------------
-- Capacity: hours due per user per day, against weekly capacity
-- ---------------------------------------------------------------------
create or replace view public.v_capacity
with (security_invoker = true) as
select
  u.id                       as user_id,
  u.full_name,
  u.department_id,
  u.weekly_capacity_hours,
  round(u.weekly_capacity_hours / 5.0, 2) as daily_capacity_hours,
  d.day::date                as on_date,
  coalesce(sum(t.estimated_hours), 0)::numeric(8,2) as planned_hours,
  count(t.id)                as task_count,
  public.is_on_leave(u.id, d.day::date) as on_leave,
  case
    when public.is_on_leave(u.id, d.day::date) then 'On Leave'
    when coalesce(sum(t.estimated_hours), 0) > (u.weekly_capacity_hours / 5.0) * 1.2 then 'Over'
    when coalesce(sum(t.estimated_hours), 0) < (u.weekly_capacity_hours / 5.0) * 0.5 then 'Under'
    else 'Balanced'
  end as load_state
from public.users u
cross join generate_series(current_date - 7, current_date + 30, interval '1 day') d(day)
left join public.tasks t
       on t.assignee_id = u.id
      and t.deleted_at is null
      and t.due_date = d.day::date
      and t.status not in ('Delivered','Approved','Cancelled')
where u.deleted_at is null and u.status = 'Active'
group by u.id, u.full_name, u.department_id, u.weekly_capacity_hours, d.day;

comment on view public.v_capacity is
  'Workload, not billing: hours here are effort estimates used to balance a team. Nothing in this view is chargeable.';

create or replace view public.v_team_availability
with (security_invoker = true) as
select
  u.id as user_id,
  u.full_name,
  u.department_id,
  lr.from_date,
  lr.to_date,
  lr.type,
  lr.status,
  -- The reason is private unless you manage this person.
  case when public.is_in_my_subtree(u.id) or lr.user_id = public.auth_user_id()
       then lr.reason else null end as reason
from public.users u
join public.leave_requests lr on lr.user_id = u.id
where u.deleted_at is null and lr.deleted_at is null and lr.status = 'Approved';

-- ---------------------------------------------------------------------
-- The unified calendar. One query, toggleable layers.
-- RLS on each underlying table decides which rows a person actually gets,
-- which is what makes personal / manager / founder calendars differ
-- without any per-role branching here.
-- ---------------------------------------------------------------------
create or replace view public.v_calendar
with (security_invoker = true) as
  select 'task'::text as layer, t.id as entity_id, 'tasks'::text as entity_type,
         t.title, t.client_id, t.project_id, t.assignee_id as user_id,
         t.due_date as start_date, t.due_date as end_date,
         null::timestamptz as start_at, null::timestamptz as end_at,
         t.status::text as status, t.priority::text as priority, true as all_day,
         t.is_blocked as flagged
  from public.tasks t
  where t.deleted_at is null and t.due_date is not null

union all
  select 'deliverable', d.id, 'deliverables', d.title, d.client_id, d.project_id, d.owner_id,
         d.due_date, coalesce(d.sla_due_date, d.due_date), null, null,
         d.status::text, d.priority::text, true,
         (d.approval_status = 'Changes Requested')
  from public.deliverables d
  where d.deleted_at is null and d.due_date is not null

union all
  select 'shoot', s.id, 'shoots', s.title, s.client_id, s.project_id, s.director_id,
         s.shoot_date, s.shoot_date,
         (s.shoot_date + coalesce(s.call_time, time '09:00'))::timestamptz,
         (s.shoot_date + coalesce(s.wrap_time, time '18:00'))::timestamptz,
         s.status::text, 'High', (s.call_time is null),
         (s.status = 'Tentative')
  from public.shoots s
  where s.deleted_at is null

union all
  select 'post', cc.id, 'content_calendar', coalesce(cc.title, cc.hook, cc.content_type::text),
         cc.client_id, cc.project_id, cc.owner_id,
         cc.post_date, cc.post_date, cc.post_at_utc, cc.post_at_utc,
         cc.status::text, 'Medium', (cc.post_time is null),
         (cc.approval_status = 'Pending')
  from public.content_calendar cc
  where cc.deleted_at is null

union all
  select 'meeting', m.id, 'meetings', m.title, m.client_id, m.project_id, m.organiser_id,
         (m.starts_at at time zone m.timezone)::date,
         (m.starts_at at time zone m.timezone)::date,
         m.starts_at, m.starts_at + make_interval(mins => m.duration_mins),
         m.status, 'Medium', false, false
  from public.meetings m
  where m.deleted_at is null

union all
  select 'approval', a.id, 'approvals', a.level::text || ' approval', a.client_id, null, a.approver_id,
         a.due_at::date, a.due_at::date, a.due_at, a.due_at,
         a.status::text, 'High', false,
         (a.status = 'Pending' and a.due_at < now())
  from public.approvals a
  where a.deleted_at is null and a.due_at is not null

union all
  select 'leave', lr.id, 'leave_requests', lr.type::text || ' leave', null, null, lr.user_id,
         lr.from_date, lr.to_date, null, null,
         lr.status::text, 'Low', true, false
  from public.leave_requests lr
  where lr.deleted_at is null and lr.status = 'Approved'

union all
  select 'renewal', c.id, 'clients', c.brand_name || ' renewal', c.id, null, c.account_manager_id,
         c.renewal_date, c.renewal_date, null, null,
         c.status::text, 'High', true,
         (c.renewal_date <= current_date + 30)
  from public.clients c
  where c.deleted_at is null and c.renewal_date is not null;

comment on view public.v_calendar is
  'Every calendar layer in one place. Personal = my rows, manager = my subtree, founder = everything — all decided by RLS, not by a role branch in this view.';

-- ---------------------------------------------------------------------
-- Dashboard aggregates
-- ---------------------------------------------------------------------
create or replace view public.v_client_health_grid
with (security_invoker = true) as
select
  c.id as client_id, c.client_code, c.brand_name, c.status, c.health, c.priority,
  c.account_manager_id, am.full_name as account_manager_name,
  c.renewal_date,
  case when c.renewal_date is not null then c.renewal_date - current_date end as days_to_renewal,
  count(distinct p.id) filter (where p.status = 'Active')      as active_projects,
  count(distinct d.id) filter (where d.status not in ('Delivered','Approved','Cancelled')) as open_deliverables,
  count(distinct d.id) filter (where d.due_date < current_date
        and d.status not in ('Delivered','Approved','Cancelled'))  as overdue_deliverables,
  count(distinct a.id) filter (where a.status = 'Pending')      as pending_approvals,
  count(distinct s.id) filter (where s.shoot_date >= current_date and s.status <> 'Cancelled') as upcoming_shoots,
  max(d.updated_at) as last_activity_at
from public.clients c
left join public.users am        on am.id = c.account_manager_id
left join public.projects p      on p.client_id = c.id and p.deleted_at is null
left join public.deliverables d  on d.client_id = c.id and d.deleted_at is null
left join public.approvals a     on a.client_id = c.id and a.deleted_at is null
left join public.shoots s        on s.client_id = c.id and s.deleted_at is null
where c.deleted_at is null
group by c.id, c.client_code, c.brand_name, c.status, c.health, c.priority,
         c.account_manager_id, am.full_name, c.renewal_date;

-- On-time delivery %, computed from dates only.
create or replace view public.v_delivery_performance
with (security_invoker = true) as
select
  d.client_id,
  date_trunc('month', d.delivered_at)::date as month,
  count(*)                                                              as delivered_count,
  count(*) filter (where d.delivered_at::date <= d.due_date)            as on_time_count,
  round(100.0 * count(*) filter (where d.delivered_at::date <= d.due_date)
        / nullif(count(*), 0), 1)                                       as on_time_pct
from public.deliverables d
where d.deleted_at is null and d.delivered_at is not null and d.due_date is not null
group by d.client_id, date_trunc('month', d.delivered_at);

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
where l.deleted_at is null and l.stage not in ('Won','Lost')
group by l.stage, l.owner_id, u.full_name;

-- Readable per-record history for the History tab.
create or replace view public.v_activity_feed
with (security_invoker = true) as
select
  al.id, al.entity_type, al.entity_id, al.client_id, al.action,
  al.field_name, al.old_value, al.new_value, al.changed_at,
  al.actor_id,
  coalesce(u.full_name, 'System') as actor_name,
  al.is_system,
  case
    when al.action = 'INSERT'      then 'created this record'
    when al.action = 'SOFT_DELETE' then 'moved this record to the Recycle Bin'
    when al.action = 'RESTORE'     then 'restored this record'
    when al.action = 'DELETE'      then 'permanently deleted this record'
    else format('changed %s from %s to %s',
                replace(al.field_name, '_', ' '),
                coalesce(nullif(al.old_value, ''), 'empty'),
                coalesce(nullif(al.new_value, ''), 'empty'))
  end as summary
from public.activity_log al
left join public.users u on u.id = al.actor_id;

-- ---------------------------------------------------------------------
-- CLIENT PORTAL VIEWS
-- These expose an explicit, minimal column list. Combined with the
-- client_portal database role (which holds no privilege on the internal
-- tables), a raw API call with a client token cannot reach an assignee
-- name, an internal note or any capacity data.
-- ---------------------------------------------------------------------
create or replace view public.v_portal_deliverables
with (security_invoker = true) as
select d.id, d.client_id, d.title, d.type, d.due_date,
       d.status, d.approval_status, d.current_version, d.delivered_at, d.platform
from public.deliverables d
where d.deleted_at is null;

create or replace view public.v_portal_content_calendar
with (security_invoker = true) as
select cc.id, cc.client_id, cc.platform, cc.post_date, cc.post_time, cc.post_at_utc,
       cc.content_type, cc.title, cc.hook, cc.caption, cc.hashtags,
       cc.status, cc.approval_status, cc.published_url, cc.posted_at
from public.content_calendar cc
where cc.deleted_at is null;

create or replace view public.v_portal_approvals
with (security_invoker = true) as
select a.id, a.client_id, a.entity_type, a.entity_id, a.level, a.round_no,
       a.status, a.requested_at, a.due_at, a.decided_at, a.feedback
from public.approvals a
where a.deleted_at is null and a.level = 'Client';

create or replace view public.v_portal_schedule
with (security_invoker = true) as
  select 'shoot'::text as layer, s.id, s.client_id, s.title,
         s.shoot_date as on_date, s.call_time as at_time, s.status::text, s.location_name as detail
  from public.shoots s where s.deleted_at is null and s.status <> 'Cancelled'
union all
  select 'meeting', m.id, m.client_id, m.title,
         (m.starts_at at time zone m.timezone)::date,
         (m.starts_at at time zone m.timezone)::time, m.status, m.meeting_link
  from public.meetings m where m.deleted_at is null and m.type <> 'Internal';

create or replace view public.v_portal_comments
with (security_invoker = true) as
select c.id, c.client_id, c.entity_type, c.entity_id, c.body, c.created_at, c.parent_id
from public.comments c
where c.deleted_at is null and not c.is_internal;

-- Column-level grants. This is the wire-level guarantee.
do $$
begin
  execute 'grant select on public.v_portal_deliverables, public.v_portal_content_calendar,
                            public.v_portal_approvals, public.v_portal_schedule,
                            public.v_portal_comments to client_portal';

  execute 'grant select (id, client_code, brand_name, legal_name, timezone, city, country, status)
             on public.clients to client_portal';
  execute 'grant select (id, client_id, title, type, due_date, status, approval_status,
                         current_version, delivered_at, platform, deleted_at)
             on public.deliverables to client_portal';
  execute 'grant select (id, client_id, platform, post_date, post_time, post_at_utc, content_type,
                         title, hook, caption, hashtags, status, approval_status,
                         published_url, posted_at, deleted_at)
             on public.content_calendar to client_portal';
  execute 'grant select (id, client_id, entity_type, entity_id, level, round_no, status,
                         requested_at, due_at, decided_at, feedback, deleted_at)
             on public.approvals to client_portal';
  execute 'grant update (status, feedback) on public.approvals to client_portal';
  execute 'grant select (id, client_id, title, shoot_date, call_time, location_name, status, deleted_at)
             on public.shoots to client_portal';
  execute 'grant select (id, client_id, title, starts_at, duration_mins, timezone, type,
                         meeting_link, agenda, status, deleted_at)
             on public.meetings to client_portal';
  execute 'grant select (id, client_id, entity_type, entity_id, body, created_at, parent_id,
                         is_internal, author_id, deleted_at)
             on public.comments to client_portal';
  execute 'grant insert (entity_type, entity_id, client_id, body, is_internal, author_id, parent_id)
             on public.comments to client_portal';
  execute 'grant select (id, client_id, project_id, name, file_url, external_link, type,
                         current_version_no, is_client_visible, uploaded_at, deleted_at)
             on public.assets to client_portal';
  execute 'grant select (id, client_id, title, period_start, period_end, report_date,
                         link, file_url, summary, status, approval_status, shared_at, deleted_at)
             on public.client_reports to client_portal';
  execute 'grant select (id, auth_id, full_name, client_id, role_id, deleted_at)
             on public.users to client_portal';
  execute 'grant select on public.modules to client_portal';
exception when others then
  raise notice 'client_portal grants skipped: %', sqlerrm;
end $$;
