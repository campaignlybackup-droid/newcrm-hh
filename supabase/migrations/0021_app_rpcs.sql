-- =====================================================================
-- 0021_app_rpcs.sql
-- RPCs the application calls. Each one is SECURITY INVOKER unless it has
-- a stated reason not to be, so RLS still decides what comes back.
-- =====================================================================

-- What the signed-in user is allowed to see and do. The UI uses this to
-- decide which chrome to render; it is NOT the authorization boundary.
create or replace function public.my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_ctx jsonb; v_user record;
begin
  v_ctx := public.auth_ctx();
  if v_ctx ->> 'user_id' is null then
    return jsonb_build_object('authenticated', false);
  end if;

  select u.id, u.full_name, u.email, u.avatar_url, u.timezone, u.client_id,
         r.name as role_name, r.code as role_code, r.level, r.is_manager, r.is_external,
         d.name as department_name, d.id as department_id
    into v_user
    from public.users u
    join public.roles r on r.id = u.role_id
    left join public.departments d on d.id = u.department_id
   where u.id = (v_ctx ->> 'user_id')::uuid;

  return jsonb_build_object(
    'authenticated', true,
    'user', jsonb_build_object(
      'id', v_user.id, 'full_name', v_user.full_name, 'email', v_user.email,
      'avatar_url', v_user.avatar_url, 'timezone', v_user.timezone,
      'client_id', v_user.client_id),
    'role', jsonb_build_object(
      'name', v_user.role_name, 'code', v_user.role_code, 'level', v_user.level,
      'is_manager', v_user.is_manager, 'is_external', v_user.is_external),
    'department', jsonb_build_object('id', v_user.department_id, 'name', v_user.department_name),
    'perms',  v_ctx -> 'perms',
    'scopes', v_ctx -> 'scopes'
  );
end $$;

-- Bulk date shift for the list view's multi-select toolbar. Runs as the
-- caller, so the same policies that guard a single edit guard the batch,
-- and each write goes through the normal UPDATE path so the dependency
-- engine and the audit trigger both fire.
create or replace function public.shift_task_dates(p_task_ids uuid[], p_days int)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare v_n int;
begin
  update public.tasks
     set start_date = public.add_working_days(start_date, p_days),
         due_date   = public.add_working_days(due_date, p_days)
   where id = any(p_task_ids) and deleted_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Everything the record's History tab shows.
create or replace function public.record_history(p_entity_type text, p_entity_id uuid, p_limit int default 200)
returns table (
  id bigint, action audit_action, field_name text, old_value text, new_value text,
  changed_at timestamptz, actor_name text, is_system boolean, summary text
)
language sql
stable
security invoker
set search_path = public
as $$
  select f.id, f.action, f.field_name, f.old_value, f.new_value,
         f.changed_at, f.actor_name, f.is_system, f.summary
  from public.v_activity_feed f
  where f.entity_type = p_entity_type and f.entity_id = p_entity_id
  order by f.changed_at desc
  limit p_limit;
$$;

-- Founder / manager dashboard payload in one round trip.
create or replace function public.dashboard_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'deliverables_due_this_week', (
      select count(*) from public.deliverables
       where deleted_at is null and due_date between current_date and current_date + 7
         and status not in ('Delivered','Approved','Cancelled')),
    'overdue_tasks', (
      select count(*) from public.tasks
       where deleted_at is null and due_date < current_date
         and status not in ('Delivered','Approved','Cancelled')),
    'approvals_pending', (
      select count(*) from public.approvals where deleted_at is null and status = 'Pending'),
    'approvals_waiting_on_me', (
      select count(*) from public.approvals
       where deleted_at is null and status = 'Pending' and approver_id = public.auth_user_id()),
    'shoots_next_7', (
      select count(*) from public.shoots
       where deleted_at is null and shoot_date between current_date and current_date + 7
         and status <> 'Cancelled'),
    'posts_next_7', (
      select count(*) from public.content_calendar
       where deleted_at is null and post_date between current_date and current_date + 7),
    'renewals_in_60', (
      select count(*) from public.clients
       where deleted_at is null and renewal_date between current_date and current_date + 60),
    'clients_at_risk', (
      select count(*) from public.clients where deleted_at is null and health <> 'Green'),
    'my_tasks_today', (
      select count(*) from public.tasks
       where deleted_at is null and assignee_id = public.auth_user_id()
         and due_date = current_date and status not in ('Delivered','Approved','Cancelled')),
    'my_tasks_overdue', (
      select count(*) from public.tasks
       where deleted_at is null and assignee_id = public.auth_user_id()
         and due_date < current_date and status not in ('Delivered','Approved','Cancelled')),
    'on_time_delivery_pct', (
      select round(100.0 * count(*) filter (where delivered_at::date <= due_date)
             / nullif(count(*), 0), 1)
        from public.deliverables
       where deleted_at is null and delivered_at is not null and due_date is not null
         and delivered_at > now() - interval '90 days'),
    'overdue_by_department', (
      select coalesce(jsonb_agg(jsonb_build_object('department', dep, 'overdue', n) order by n desc), '[]'::jsonb)
        from (
          select coalesce(d.name, 'Unassigned') as dep, count(*) as n
            from public.tasks t
            left join public.users u on u.id = t.assignee_id
            left join public.departments d on d.id = u.department_id
           where t.deleted_at is null and t.due_date < current_date
             and t.status not in ('Delivered','Approved','Cancelled')
           group by 1) s),
    'lead_pipeline', (
      select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'count', lead_count,
                                                   'overdue_actions', overdue_actions)), '[]'::jsonb)
        from public.v_lead_pipeline)
  );
$$;

-- Team load heat map for the manager dashboard.
create or replace function public.team_load(p_days int default 14)
returns table (
  user_id uuid, full_name text, on_date date,
  planned_hours numeric, daily_capacity_hours numeric, task_count bigint,
  on_leave boolean, load_state text
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.user_id, v.full_name, v.on_date, v.planned_hours,
         v.daily_capacity_hours, v.task_count, v.on_leave, v.load_state
  from public.v_capacity v
  where v.on_date between current_date and current_date + p_days
  order by v.full_name, v.on_date;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.my_context()', 'public.shift_task_dates(uuid[], int)',
    'public.record_history(text, uuid, int)', 'public.dashboard_summary()',
    'public.team_load(int)'
  ] loop
    begin execute format('grant execute on function %s to authenticated', fn);
    exception when undefined_object then null; end;
  end loop;
  begin execute 'grant execute on function public.my_context() to client_portal';
  exception when undefined_object then null; end;
end $$;
