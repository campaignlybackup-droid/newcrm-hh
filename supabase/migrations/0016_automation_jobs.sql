-- =====================================================================
-- 0016_automation_jobs.sql
-- The cascades and scheduled jobs: onboarding, recurring cycles,
-- auto-assignment, approval routing, escalation, digests, alerts and
-- the duplicate guard.
-- =====================================================================

-- =====================================================================
-- 1. AUTO-ASSIGNMENT
-- automation_rules maps (client, task_type) to a person or a pool.
-- Anyone on approved leave is skipped and the next person takes it.
-- =====================================================================
create or replace function public.fn_pick_assignee(
  p_client_id uuid,
  p_task_type text,
  p_due_date  date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule    public.automation_rules%rowtype;
  v_pool    uuid[];
  v_pick    uuid;
  v_check   date := coalesce(p_due_date, current_date);
begin
  select * into v_rule
    from public.automation_rules
   where is_active and deleted_at is null
     and (client_id = p_client_id or client_id is null)
     and (task_type = p_task_type or task_type is null)
   order by (client_id is not null) desc, (task_type is not null) desc, priority asc
   limit 1;

  if not found then return null; end if;

  if v_rule.strategy = 'fixed_user' then
    if v_rule.target_user_id is not null
       and (not v_rule.skip_on_leave or not public.is_on_leave(v_rule.target_user_id, v_check)) then
      return v_rule.target_user_id;
    end if;
    -- Fixed person is away: fall through to the pool so work still lands.
    v_pool := v_rule.pool_user_ids;
  else
    v_pool := v_rule.pool_user_ids;
  end if;

  if v_pool is null or array_length(v_pool, 1) is null then
    return null;
  end if;

  if v_rule.strategy = 'least_loaded' then
    select u.id into v_pick
      from unnest(v_pool) as p(id)
      join public.users u on u.id = p.id
     where u.deleted_at is null and u.status = 'Active'
       and (not v_rule.skip_on_leave or not public.is_on_leave(u.id, v_check))
       and (v_rule.required_skill is null or v_rule.required_skill = any (u.skills))
     order by (
       select coalesce(sum(t.estimated_hours), 0)
         from public.tasks t
        where t.assignee_id = u.id and t.deleted_at is null
          and t.status not in ('Delivered','Approved','Cancelled')
          and t.due_date between current_date and current_date + 14
     ) asc, u.full_name asc
     limit 1;

  elsif v_rule.strategy = 'by_skill' then
    select u.id into v_pick
      from unnest(v_pool) as p(id)
      join public.users u on u.id = p.id
     where u.deleted_at is null and u.status = 'Active'
       and (v_rule.required_skill is null or v_rule.required_skill = any (u.skills))
       and (not v_rule.skip_on_leave or not public.is_on_leave(u.id, v_check))
     order by u.full_name
     limit 1;

  else  -- round_robin: continue from the cursor, wrapping around
    with ordered as (
      select p.id, row_number() over () as rn
        from unnest(v_pool) as p(id)
    ),
    cursor_pos as (
      select coalesce((select rn from ordered where id = v_rule.last_assigned_user_id), 0) as rn
    )
    -- The cross join must come AFTER the inner join: with `from a, b join c
    -- on c.x = a.x` the ON clause binds to b only, and `a` is out of scope.
    select o.id into v_pick
      from ordered o
      join public.users u on u.id = o.id
      cross join cursor_pos c
     where u.deleted_at is null and u.status = 'Active'
       and (not v_rule.skip_on_leave or not public.is_on_leave(o.id, v_check))
     order by case when o.rn > c.rn then 0 else 1 end, o.rn
     limit 1;
  end if;

  if v_pick is not null then
    update public.automation_rules set last_assigned_user_id = v_pick where id = v_rule.id;
  end if;

  return v_pick;
end $$;

comment on function public.fn_pick_assignee(uuid, text, date) is
  'Auto-assignment honouring approved leave. If the nominated person is away the rule rolls on to the next available member of the pool.';

-- Applied on insert when nobody was named.
create or replace function public.trg_tasks_auto_assign()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pick uuid;
begin
  if new.assignee_id is null and new.client_id is not null then
    v_pick := public.fn_pick_assignee(new.client_id, new.task_type, new.due_date);
    if v_pick is not null then
      new.assignee_id  := v_pick;
      new.auto_assigned := true;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_auto_assign on public.tasks;
create trigger trg_tasks_auto_assign before insert on public.tasks
  for each row execute function public.trg_tasks_auto_assign();

-- =====================================================================
-- 2. LEAVE CONFLICT WARNING
-- Assigning to someone on approved leave is a warning plus a concrete
-- reassignment suggestion — never a silent success and never a hard block.
-- =====================================================================
create or replace function public.fn_assignment_conflict(
  p_user_id uuid, p_start date, p_due date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_leave record;
  v_alt   jsonb;
begin
  select lr.from_date, lr.to_date, lr.type into v_leave
    from public.leave_requests lr
   where lr.user_id = p_user_id and lr.status = 'Approved' and lr.deleted_at is null
     and daterange(lr.from_date, lr.to_date, '[]')
         && daterange(coalesce(p_start, p_due), coalesce(p_due, p_start), '[]')
   limit 1;

  if not found then
    return jsonb_build_object('conflict', false);
  end if;

  -- Suggest the least-loaded colleague in the same department who is free.
  select jsonb_agg(x) into v_alt from (
    select jsonb_build_object('user_id', u.id, 'full_name', u.full_name,
                              'open_hours', coalesce(load.h, 0)) as x
      from public.users u
      left join lateral (
        select sum(t.estimated_hours) as h
          from public.tasks t
         where t.assignee_id = u.id and t.deleted_at is null
           and t.status not in ('Delivered','Approved','Cancelled')
      ) load on true
     where u.deleted_at is null and u.status = 'Active'
       and u.department_id = (select department_id from public.users where id = p_user_id)
       and u.id <> p_user_id
       and not public.is_on_leave(u.id, coalesce(p_due, p_start))
     order by coalesce(load.h, 0) asc
     limit 3
  ) s;

  return jsonb_build_object(
    'conflict', true,
    'leave_from', v_leave.from_date,
    'leave_to',   v_leave.to_date,
    'leave_type', v_leave.type,
    'suggestions', coalesce(v_alt, '[]'::jsonb)
  );
end $$;

create or replace function public.trg_tasks_leave_warning()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_conflict jsonb;
begin
  if new.assignee_id is null then return null; end if;
  if tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id
     and new.due_date is not distinct from old.due_date then
    return null;
  end if;

  v_conflict := public.fn_assignment_conflict(new.assignee_id, new.start_date, new.due_date);
  if (v_conflict ->> 'conflict')::boolean then
    raise warning 'Assignee is on approved leave % to %',
      v_conflict ->> 'leave_from', v_conflict ->> 'leave_to';

    -- The warning goes to whoever made the assignment; if that is a
    -- background job with no acting user, it falls back to the assignee.
    insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
    select coalesce(public.auth_user_id(), new.created_by, new.assignee_id),
           'leave_conflict', 'tasks', new.id, new.client_id,
           'Assignee is on leave',
           format('%s is on approved leave from %s to %s for "%s". Suggested alternatives: %s',
                  u.full_name, v_conflict ->> 'leave_from', v_conflict ->> 'leave_to', new.title,
                  coalesce((select string_agg(s ->> 'full_name', ', ')
                              from jsonb_array_elements(v_conflict -> 'suggestions') s), 'none available')),
           '/tasks/' || new.id::text,
           'High'
      from public.users u
     where u.id = new.assignee_id
       and coalesce(public.auth_user_id(), new.created_by, new.assignee_id) is not null;
  end if;
  return null;
end $$;

drop trigger if exists trg_tasks_leave_warning on public.tasks;
create trigger trg_tasks_leave_warning after insert or update of assignee_id, due_date on public.tasks
  for each row execute function public.trg_tasks_leave_warning();

-- =====================================================================
-- 3. APPROVAL ROUTING
-- Submitting work opens the next approval in the chain with a due date.
-- =====================================================================
create or replace function public.fn_request_approval(
  p_entity_type text,
  p_entity_id   uuid,
  p_round_no    int default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client   uuid;
  v_type     text;
  v_last     int;
  v_round    int;
  v_step     record;
  v_approver uuid;
  v_id       uuid;
begin
  if p_entity_type = 'deliverables' then
    select client_id, type into v_client, v_type from public.deliverables where id = p_entity_id;
  elsif p_entity_type = 'content_calendar' then
    select client_id, content_type::text into v_client, v_type from public.content_calendar where id = p_entity_id;
  else
    select client_id into v_client from public.assets where id = p_entity_id;
  end if;

  select coalesce(max(step_no), 0), coalesce(max(round_no), 1)
    into v_last, v_round
    from public.approvals
   where entity_type = p_entity_type and entity_id = p_entity_id
     and status in ('Approved') and deleted_at is null;

  v_round := coalesce(p_round_no, v_round);

  select * into v_step
    from public.approval_chains
   where entity_type = p_entity_type and is_active
     and (client_id = v_client or client_id is null)
     and (deliverable_type = v_type or deliverable_type is null)
     and step_no > v_last
   order by (client_id is not null) desc, step_no asc
   limit 1;

  if not found then
    -- Chain exhausted: the work is fully approved.
    if p_entity_type = 'deliverables' then
      update public.deliverables
         set approval_status = 'Approved', status = 'Approved', delivered_at = now()
       where id = p_entity_id;
    elsif p_entity_type = 'content_calendar' then
      update public.content_calendar
         set approval_status = 'Approved', status = 'Scheduled'
       where id = p_entity_id;
    end if;
    return null;
  end if;

  v_approver := v_step.approver_user_id;
  if v_approver is null and v_step.approver_role_id is not null then
    -- Nearest holder of that role on this client's pod, else anyone with the role.
    select u.id into v_approver
      from public.users u
      left join public.client_team_members ctm on ctm.user_id = u.id and ctm.client_id = v_client
     where u.role_id = v_step.approver_role_id and u.deleted_at is null and u.status = 'Active'
       and not public.is_on_leave(u.id, current_date)
     order by (ctm.user_id is not null) desc, u.full_name
     limit 1;
  end if;

  insert into public.approvals (
    entity_type, entity_id, client_id, level, step_no, round_no,
    requested_by, approver_id, status, requested_at, due_at
  ) values (
    p_entity_type, p_entity_id, v_client, v_step.level, v_step.step_no, v_round,
    public.auth_user_id(), v_approver, 'Pending', now(),
    public.add_working_days(current_date, v_step.sla_days)::timestamptz
  ) returning id into v_id;

  if p_entity_type = 'deliverables' then
    update public.deliverables set approval_status = 'Pending', status = 'In Review' where id = p_entity_id;
  elsif p_entity_type = 'content_calendar' then
    update public.content_calendar set approval_status = 'Pending', status = 'In Review' where id = p_entity_id;
  end if;

  if v_approver is not null then
    insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
    values (v_approver, 'approval_requested', p_entity_type, p_entity_id, v_client,
            'Approval requested',
            format('A %s approval is waiting on you.', v_step.level),
            '/' || p_entity_type || '/' || p_entity_id::text, 'High');
  end if;

  return v_id;
end $$;

-- Deciding an approval requires can_approve, which is separate from can_edit.
create or replace function public.trg_approvals_require_approve_permission()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status
     and new.status in ('Approved','Rejected','Changes Requested') then

    if not (public.auth_can('approvals','approve')
            or new.approver_id = public.auth_user_id()
            or public.is_client_portal_user()) then
      raise exception 'Approving requires the approve permission, which is separate from edit'
        using errcode = '42501';
    end if;

    new.decided_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_approvals_require_approve_permission on public.approvals;
create trigger trg_approvals_require_approve_permission before update of status on public.approvals
  for each row execute function public.trg_approvals_require_approve_permission();

-- An approved step immediately opens the next one; a rejection opens a
-- revision round instead.
create or replace function public.trg_approvals_advance()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_next int;
begin
  if new.status = 'Approved' and old.status is distinct from 'Approved' then
    perform public.fn_request_approval(new.entity_type, new.entity_id, new.round_no);

  elsif new.status in ('Changes Requested','Rejected') and old.status is distinct from new.status then
    if new.entity_type = 'deliverables' then
      update public.deliverables
         set approval_status = 'Changes Requested', status = 'Changes Requested'
       where id = new.entity_id;

      select coalesce(max(round_no), 0) + 1 into v_next
        from public.revisions where deliverable_id = new.entity_id;

      insert into public.revisions (
        deliverable_id, client_id, round_no, requested_by, notes, due_date, is_out_of_scope)
      select new.entity_id, new.client_id, v_next, new.approver_id,
             coalesce(new.feedback, 'Changes requested'),
             public.add_working_days(current_date, 2),
             v_next > d.review_rounds_allowed
        from public.deliverables d where d.id = new.entity_id;

      update public.deliverables set review_rounds_used = v_next where id = new.entity_id;
    elsif new.entity_type = 'content_calendar' then
      update public.content_calendar
         set approval_status = 'Changes Requested', status = 'Changes Requested'
       where id = new.entity_id;
    end if;
  end if;
  return null;
end $$;

drop trigger if exists trg_approvals_advance on public.approvals;
create trigger trg_approvals_advance after update of status on public.approvals
  for each row execute function public.trg_approvals_advance();

-- =====================================================================
-- 4. MEETING MINUTES -> TASKS
-- =====================================================================
create or replace function public.trg_action_item_to_task()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_task uuid; v_meeting record;
begin
  if new.task_id is not null then return null; end if;

  select m.client_id, m.project_id, m.title, m.starts_at into v_meeting
    from public.meetings m where m.id = new.meeting_id;

  insert into public.tasks (
    meeting_id, project_id, client_id, title, description, task_type,
    assignee_id, start_date, due_date, priority, status, created_by
  ) values (
    new.meeting_id, v_meeting.project_id, v_meeting.client_id,
    new.description,
    format('Action item from "%s" on %s', v_meeting.title, v_meeting.starts_at::date),
    'Action Item',
    new.owner_id,
    current_date,
    coalesce(new.due_date, public.add_working_days(current_date, 3)),
    'Medium', 'Not Started',
    coalesce(public.auth_user_id(), new.created_by)
  ) returning id into v_task;

  update public.action_items set task_id = v_task, converted_at = now() where id = new.id;
  return null;
end $$;

drop trigger if exists trg_action_item_to_task on public.action_items;
create trigger trg_action_item_to_task after insert on public.action_items
  for each row execute function public.trg_action_item_to_task();

-- =====================================================================
-- 5. CLIENT ONBOARDING CASCADE
-- One client + one service scope row => project, cycle, deliverables,
-- task chains, approval flow and kickoff meeting. No further typing.
-- =====================================================================
create or replace function public.fn_client_onboarding_cascade(p_client_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client     public.clients%rowtype;
  v_project_id uuid;
  v_cycle_id   uuid;
  v_scope      record;
  v_created    int := 0;
  v_tasks      int := 0;
  v_meeting_id uuid;
  v_start      date;
  v_end        date;
begin
  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'Client % not found', p_client_id using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.client_service_scope
                  where client_id = p_client_id and is_active and deleted_at is null) then
    return jsonb_build_object('skipped', true, 'reason', 'no active service scope');
  end if;

  v_start := coalesce(v_client.contract_start_date, v_client.onboarding_date, current_date);
  v_start := date_trunc('month', v_start)::date;
  v_end   := (v_start + interval '1 month - 1 day')::date;

  -- Retainer project (idempotent).
  select id into v_project_id
    from public.projects
   where client_id = p_client_id and type = 'Retainer' and deleted_at is null
   limit 1;

  if v_project_id is null then
    insert into public.projects (client_id, name, type, start_date, end_date, manager_id, status, created_by)
    values (p_client_id, v_client.brand_name || ' — Retainer', 'Retainer',
            v_start, v_client.contract_end_date, v_client.account_manager_id, 'Active',
            coalesce(public.auth_user_id(), v_client.created_by))
    returning id into v_project_id;
  end if;

  -- First cycle.
  insert into public.retainer_cycles (project_id, client_id, cycle_month, start_date, end_date, generated_by)
  values (v_project_id, p_client_id, v_start, v_start, v_end, 'onboarding_cascade')
  on conflict (project_id, cycle_month) do nothing;

  select id into v_cycle_id from public.retainer_cycles
   where project_id = v_project_id and cycle_month = v_start;

  -- Deliverables + their standard task chains, one set per scope row.
  for v_scope in
    select * from public.client_service_scope
     where client_id = p_client_id and is_active and deleted_at is null
  loop
    v_created := v_created + public.fn_generate_deliverables_for_cycle(
                   v_cycle_id, v_scope.id, v_start, v_end);
  end loop;

  select count(*) into v_tasks from public.tasks t
    join public.deliverables d on d.id = t.deliverable_id
   where d.cycle_id = v_cycle_id;

  -- Default approval flow, if this client has none of its own.
  if not exists (select 1 from public.approval_chains where client_id = p_client_id) then
    insert into public.approval_chains (client_id, entity_type, step_no, level, approver_role_id, sla_days)
    select p_client_id, 'deliverables', s.step_no, s.level, r.id, s.sla_days
      from (values (1, 'Internal'::approval_level, 'EDIT_LEAD', 1),
                   (2, 'Manager'::approval_level,  'ACCOUNT_MANAGER', 1),
                   (3, 'Client'::approval_level,   null, 2)) as s(step_no, level, role_code, sla_days)
      left join public.roles r on r.code = s.role_code
    on conflict do nothing;
  end if;

  -- Kickoff meeting.
  insert into public.meetings (client_id, project_id, type, title, starts_at, duration_mins,
                               timezone, agenda, organiser_id, created_by)
  select p_client_id, v_project_id, 'Kickoff',
         v_client.brand_name || ' — Kickoff',
         (public.add_working_days(current_date, 2) + time '11:00') at time zone v_client.timezone,
         60, v_client.timezone,
         E'1. Introductions and points of contact\n2. Brand kit walkthrough\n3. Scope, cadence and SLAs\n4. Approval flow and turnaround expectations\n5. Content pillars and first cycle plan',
         v_client.account_manager_id, coalesce(public.auth_user_id(), v_client.created_by)
  where not exists (
    select 1 from public.meetings m where m.client_id = p_client_id and m.type = 'Kickoff' and m.deleted_at is null
  )
  returning id into v_meeting_id;

  update public.clients
     set status = case when status = 'Lead' then 'Onboarding' else status end,
         onboarding_date = coalesce(onboarding_date, current_date)
   where id = p_client_id;

  return jsonb_build_object(
    'client_id', p_client_id, 'project_id', v_project_id, 'cycle_id', v_cycle_id,
    'deliverables_created', v_created, 'tasks_created', v_tasks, 'kickoff_meeting_id', v_meeting_id
  );
end $$;

comment on function public.fn_client_onboarding_cascade(uuid) is
  'Acceptance test: creating a client with a service scope auto-generates project, cycle, deliverables, tasks and approvals with no further typing. Idempotent — safe to re-run.';

-- =====================================================================
-- 6. CYCLE GENERATION
-- Deliverables and their task chains are derived from the client's
-- service scope and templates — never hand-entered per month.
-- =====================================================================
create or replace function public.fn_generate_deliverables_for_cycle(
  p_cycle_id uuid,
  p_scope_id uuid,
  p_start    date,
  p_end      date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope     public.client_service_scope%rowtype;
  v_cycle     public.retainer_cycles%rowtype;
  v_i         int;
  v_step      int;
  v_due       date;
  v_deliv_id  uuid;
  v_count     int := 0;
  v_tmpl      record;
  v_task_id   uuid;
  v_map       jsonb := '{}'::jsonb;   -- template sort_order -> created task id
  v_pred      uuid;
begin
  select * into v_scope from public.client_service_scope where id = p_scope_id;
  select * into v_cycle from public.retainer_cycles      where id = p_cycle_id;
  if not found or v_scope.id is null then return 0; end if;

  v_step := greatest(1, ((p_end - p_start) / greatest(v_scope.qty_per_cycle, 1))::int);

  for v_i in 1 .. v_scope.qty_per_cycle loop
    v_due := public.add_working_days(p_start + (v_step * v_i), 0);
    if v_due > p_end then v_due := public.add_working_days(p_end, 0); end if;

    -- Idempotency: one deliverable per (cycle, scope, index).
    select id into v_deliv_id
      from public.deliverables
     where cycle_id = p_cycle_id and scope_id = p_scope_id
       and title = format('%s %s/%s', v_scope.deliverable_type, v_i, v_scope.qty_per_cycle)
     limit 1;
    if v_deliv_id is not null then continue; end if;

    insert into public.deliverables (
      project_id, client_id, cycle_id, scope_id, type, title, qty, due_date,
      owner_id, platform, status, approval_status, review_rounds_allowed, created_by
    ) values (
      v_cycle.project_id, v_cycle.client_id, p_cycle_id, p_scope_id,
      v_scope.deliverable_type,
      format('%s %s/%s', v_scope.deliverable_type, v_i, v_scope.qty_per_cycle),
      1, v_due, v_scope.default_owner_id, v_scope.platform,
      'Not Started', 'Draft', v_scope.review_rounds_allowed,
      coalesce(public.auth_user_id(), v_scope.default_owner_id)
    ) returning id into v_deliv_id;

    v_count := v_count + 1;
    v_map := '{}'::jsonb;

    -- Standard task chain from the templates.
    for v_tmpl in
      select * from public.task_templates
       where is_active
         and (deliverable_template_id = v_scope.task_template_id
              or (v_scope.task_template_id is null and deliverable_type = v_scope.deliverable_type))
       order by sort_order
    loop
      insert into public.tasks (
        deliverable_id, project_id, client_id, title, task_type,
        start_date, due_date, estimated_hours, priority, status, sop_id, sort_order, created_by
      ) values (
        v_deliv_id, v_cycle.project_id, v_cycle.client_id,
        v_tmpl.title, v_tmpl.task_type,
        public.add_working_days(v_due, v_tmpl.offset_days_from_due),
        public.add_working_days(v_due, v_tmpl.offset_days_from_due + v_tmpl.duration_days),
        v_tmpl.estimated_hours, 'Medium', 'Not Started', v_tmpl.sop_id, v_tmpl.sort_order,
        public.auth_user_id()
      ) returning id into v_task_id;

      v_map := v_map || jsonb_build_object(v_tmpl.sort_order::text, v_task_id);

      -- Wire the chain: this task waits on the template it names.
      if v_tmpl.depends_on_sort_order is not null then
        v_pred := nullif(v_map ->> v_tmpl.depends_on_sort_order::text, '')::uuid;
        if v_pred is not null then
          insert into public.task_dependencies (predecessor_id, successor_id, lag_days)
          values (v_pred, v_task_id, v_tmpl.lag_days)
          on conflict do nothing;
        end if;
      end if;

      -- Checklist from its template.
      if v_tmpl.checklist_template_id is not null then
        insert into public.checklist_items (task_id, label, sort_order)
        select v_task_id, item ->> 'label', coalesce((item ->> 'sort_order')::int, ord::int)
          from public.checklist_templates ct,
               lateral jsonb_array_elements(ct.items) with ordinality as e(item, ord)
         where ct.id = v_tmpl.checklist_template_id;
      end if;
    end loop;
  end loop;

  return v_count;
end $$;

create or replace function public.fn_generate_cycle(p_project_id uuid, p_month date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects%rowtype;
  v_start date; v_end date; v_cycle_id uuid; v_scope record;
begin
  select * into v_project from public.projects where id = p_project_id and deleted_at is null;
  if not found or v_project.type <> 'Retainer' or v_project.status <> 'Active' then
    return null;
  end if;

  v_start := date_trunc('month', p_month)::date;
  v_end   := (v_start + interval '1 month - 1 day')::date;

  -- Never generate past the contract end.
  if v_project.end_date is not null and v_start > v_project.end_date then
    return null;
  end if;

  insert into public.retainer_cycles (project_id, client_id, cycle_month, start_date, end_date, generated_by)
  values (p_project_id, v_project.client_id, v_start, v_start, v_end, 'cycle_generator')
  on conflict (project_id, cycle_month) do nothing;

  select id into v_cycle_id from public.retainer_cycles
   where project_id = p_project_id and cycle_month = v_start;

  for v_scope in
    select * from public.client_service_scope
     where client_id = v_project.client_id and is_active and deleted_at is null
       and (starts_on is null or starts_on <= v_end)
       and (ends_on   is null or ends_on   >= v_start)
  loop
    perform public.fn_generate_deliverables_for_cycle(v_cycle_id, v_scope.id, v_start, v_end);
  end loop;

  return v_cycle_id;
end $$;

-- Runs on the 25th: build next month for every active retainer.
create or replace function public.fn_generate_next_cycles()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_n int := 0; v_month date;
begin
  v_month := (date_trunc('month', current_date) + interval '1 month')::date;

  for r in
    select p.id from public.projects p
     join public.clients c on c.id = p.client_id
    where p.type = 'Retainer' and p.status = 'Active' and p.deleted_at is null
      and c.status = 'Active' and c.deleted_at is null
  loop
    if public.fn_generate_cycle(r.id, v_month) is not null then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end $$;

-- Adding a service scope row onboards the client automatically.
create or replace function public.trg_service_scope_cascade()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.in_cascade() then return null; end if;
  perform public.begin_cascade();
  perform public.fn_client_onboarding_cascade(new.client_id);
  perform public.end_cascade();
  return null;
end $$;

drop trigger if exists trg_service_scope_cascade on public.client_service_scope;
create trigger trg_service_scope_cascade after insert on public.client_service_scope
  for each row execute function public.trg_service_scope_cascade();

-- =====================================================================
-- 7. ESCALATION
-- Overdue notifies the assignee, then their manager the next day, then
-- the department head.
-- =====================================================================
create or replace function public.fn_escalate_overdue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_n int := 0; v_target uuid; v_stage text;
begin
  for r in
    select t.id, t.title, t.due_date, t.assignee_id, t.client_id,
           current_date - t.due_date as days_over,
           u.manager_id, u.department_id, d.head_user_id
      from public.tasks t
      join public.users u on u.id = t.assignee_id
      left join public.departments d on d.id = u.department_id
     where t.deleted_at is null
       and t.due_date < current_date
       and t.status not in ('Delivered','Approved','Cancelled')
  loop
    if r.days_over >= 3 and r.head_user_id is not null then
      v_target := r.head_user_id; v_stage := 'department head';
    elsif r.days_over >= 1 and r.manager_id is not null then
      v_target := r.manager_id;   v_stage := 'manager';
    else
      v_target := r.assignee_id;  v_stage := 'assignee';
    end if;

    -- One escalation per target per task per day.
    if not exists (
      select 1 from public.notifications n
       where n.user_id = v_target and n.entity_type = 'tasks' and n.entity_id = r.id
         and n.type = 'overdue_escalation' and n.created_at::date = current_date
    ) then
      insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
      values (v_target, 'overdue_escalation', 'tasks', r.id, r.client_id,
              format('Overdue %s day(s): %s', r.days_over, r.title),
              format('Escalated to %s. Due %s.', v_stage, r.due_date),
              '/tasks/' || r.id::text,
              case when r.days_over >= 3 then 'Critical' else 'High' end);
      v_n := v_n + 1;
    end if;
  end loop;

  -- Approvals untouched past due escalate to the approver's manager.
  for r in
    select a.id, a.entity_type, a.entity_id, a.client_id, a.approver_id, u.manager_id
      from public.approvals a
      join public.users u on u.id = a.approver_id
     where a.status = 'Pending' and a.deleted_at is null
       and a.due_at < now() and a.escalated_at is null
  loop
    if r.manager_id is not null then
      update public.approvals set escalated_at = now(), escalated_to = r.manager_id where id = r.id;
      insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
      values (r.manager_id, 'approval_escalation', r.entity_type, r.entity_id, r.client_id,
              'Approval overdue and escalated to you',
              'The original approver did not respond before the due date.',
              '/approvals/' || r.id::text, 'Critical');
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end $$;

-- =====================================================================
-- 8. RENEWAL & CONTRACT ALERTS — 60/30/15/7 days out
-- =====================================================================
create or replace function public.fn_renewal_alerts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_n int := 0; v_days int;
begin
  for r in
    select c.id, c.brand_name, c.renewal_date, c.contract_end_date, c.account_manager_id,
           u.manager_id
      from public.clients c
      left join public.users u on u.id = c.account_manager_id
     where c.deleted_at is null and c.status in ('Active','Onboarding')
       and (c.renewal_date is not null or c.contract_end_date is not null)
  loop
    foreach v_days in array array[60, 30, 15, 7] loop
      if (r.renewal_date = current_date + v_days) or (r.contract_end_date = current_date + v_days) then
        insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
        select uid, 'renewal_alert', 'clients', r.id, r.id,
               format('%s renews in %s days', r.brand_name, v_days),
               format('Renewal %s, contract end %s.', coalesce(r.renewal_date::text,'—'),
                      coalesce(r.contract_end_date::text,'—')),
               '/clients/' || r.id::text,
               case when v_days <= 15 then 'Critical' else 'High' end
          from unnest(array[r.account_manager_id, r.manager_id]) as t(uid)
         where uid is not null
           and not exists (
             select 1 from public.notifications n
              where n.user_id = t.uid and n.entity_id = r.id and n.type = 'renewal_alert'
                and n.created_at::date = current_date);
        v_n := v_n + 1;
      end if;
    end loop;
  end loop;

  -- Expiring client documents get the same treatment.
  insert into public.notifications (user_id, type, entity_type, entity_id, client_id, title, message, url, priority)
  select c.account_manager_id, 'document_expiry', 'client_documents', cd.id, cd.client_id,
         format('%s expires in %s days', cd.title, cd.expires_on - current_date),
         'Client document is approaching expiry.',
         '/clients/' || cd.client_id::text, 'High'
    from public.client_documents cd
    join public.clients c on c.id = cd.client_id
   where cd.deleted_at is null and cd.expires_on = any (array[
           current_date + 60, current_date + 30, current_date + 15, current_date + 7])
     and c.account_manager_id is not null;

  return v_n;
end $$;

-- =====================================================================
-- 9. DAILY DIGEST — 9 AM per user
-- =====================================================================
create or replace function public.fn_daily_digest(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_tz text; v_today date;
begin
  select timezone into v_tz from public.users where id = p_user_id;
  v_tz := coalesce(v_tz, 'Asia/Dubai');
  v_today := (now() at time zone v_tz)::date;

  return jsonb_build_object(
    'user_id', p_user_id,
    'local_date', v_today,
    'tasks_due_today', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title,
             'client', c.brand_name, 'priority', t.priority) order by t.priority desc), '[]'::jsonb)
        from public.tasks t left join public.clients c on c.id = t.client_id
       where t.assignee_id = p_user_id and t.deleted_at is null
         and t.due_date = v_today and t.status not in ('Delivered','Approved','Cancelled')),
    'tasks_overdue', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title,
             'due_date', t.due_date, 'days_over', v_today - t.due_date) order by t.due_date), '[]'::jsonb)
        from public.tasks t
       where t.assignee_id = p_user_id and t.deleted_at is null
         and t.due_date < v_today and t.status not in ('Delivered','Approved','Cancelled')),
    'approvals_waiting_on_me', (
      select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'entity_type', a.entity_type,
             'entity_id', a.entity_id, 'due_at', a.due_at, 'level', a.level) order by a.due_at), '[]'::jsonb)
        from public.approvals a
       where a.approver_id = p_user_id and a.status = 'Pending' and a.deleted_at is null),
    'shoots_today', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title,
             'call_time', coalesce(sc.individual_call_time, s.call_time),
             'location', s.location_name, 'map_link', s.map_link) order by s.call_time), '[]'::jsonb)
        from public.shoots s join public.shoot_crew sc on sc.shoot_id = s.id
       where sc.user_id = p_user_id and s.deleted_at is null and s.shoot_date = v_today),
    'posts_going_live', (
      select coalesce(jsonb_agg(jsonb_build_object('id', cc.id, 'title', cc.title,
             'platform', cc.platform, 'post_time', cc.post_time) order by cc.post_time), '[]'::jsonb)
        from public.content_calendar cc
       where cc.deleted_at is null and cc.post_date = v_today
         and (cc.owner_id = p_user_id or cc.reviewer_id = p_user_id)),
    'meetings_today', (
      select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title,
             'starts_at', m.starts_at, 'link', m.meeting_link) order by m.starts_at), '[]'::jsonb)
        from public.meetings m join public.meeting_attendees ma on ma.meeting_id = m.id
       where ma.user_id = p_user_id and m.deleted_at is null
         and (m.starts_at at time zone v_tz)::date = v_today)
  );
end $$;

create or replace function public.fn_queue_daily_digests()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_d jsonb; v_n int := 0; v_count int;
begin
  for r in
    select u.id, u.full_name from public.users u
      join public.roles ro on ro.id = u.role_id
     where u.deleted_at is null and u.status = 'Active' and not ro.is_external
  loop
    v_d := public.fn_daily_digest(r.id);
    v_count := jsonb_array_length(v_d -> 'tasks_due_today')
             + jsonb_array_length(v_d -> 'tasks_overdue')
             + jsonb_array_length(v_d -> 'approvals_waiting_on_me')
             + jsonb_array_length(v_d -> 'shoots_today')
             + jsonb_array_length(v_d -> 'posts_going_live')
             + jsonb_array_length(v_d -> 'meetings_today');

    if v_count > 0 then
      insert into public.notifications (user_id, type, title, message, channel, priority)
      values (r.id, 'daily_digest', format('Your day: %s item(s)', v_count), v_d::text, 'digest', 'Medium');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- =====================================================================
-- 10. DUPLICATE GUARD — warn before insert, never silently block
-- =====================================================================
create or replace function public.fn_check_duplicate_client(
  p_legal_name text, p_brand_name text, p_contact_email text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare v_similar jsonb; v_emails jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'client_id', c.id, 'client_code', c.client_code,
           'legal_name', c.legal_name, 'brand_name', c.brand_name,
           'similarity', round(greatest(
              similarity(c.legal_name, coalesce(p_legal_name, '')),
              similarity(c.brand_name, coalesce(p_brand_name, '')))::numeric, 2),
           'status', c.status)
         order by greatest(similarity(c.legal_name, coalesce(p_legal_name, '')),
                           similarity(c.brand_name, coalesce(p_brand_name, ''))) desc), '[]'::jsonb)
    into v_similar
    from public.clients c
   where c.deleted_at is null
     and (similarity(c.legal_name, coalesce(p_legal_name, '')) > 0.45
       or similarity(c.brand_name, coalesce(p_brand_name, '')) > 0.45);

  select coalesce(jsonb_agg(jsonb_build_object(
           'contact_id', cc.id, 'name', cc.name, 'email', cc.email,
           'client_id', cc.client_id, 'brand_name', c.brand_name)), '[]'::jsonb)
    into v_emails
    from public.client_contacts cc join public.clients c on c.id = cc.client_id
   where p_contact_email is not null and cc.deleted_at is null
     and lower(cc.email) = lower(p_contact_email);

  return jsonb_build_object(
    'has_warning', (jsonb_array_length(v_similar) > 0 or jsonb_array_length(v_emails) > 0),
    'similar_clients', v_similar,
    'duplicate_contact_emails', v_emails
  );
end $$;

comment on function public.fn_check_duplicate_client(text, text, text) is
  'Called by the UI before insert. Returns warnings, not an error: the operator decides whether the match is a real duplicate.';

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.fn_schedule_from_post_date(uuid, date, text)',
    'public.fn_assignment_conflict(uuid, date, date)',
    'public.fn_check_duplicate_client(text, text, text)',
    'public.fn_request_approval(text, uuid, int)',
    'public.fn_client_onboarding_cascade(uuid)',
    'public.fn_daily_digest(uuid)',
    'public.soft_delete(text, uuid)',
    'public.restore_record(text, uuid)',
    'public.hard_delete(text, uuid, text)',
    'public.recycle_bin(int)',
    'public.convert_lead_to_client(uuid, uuid, date, date, int)',
    'public.is_on_leave(uuid, date)',
    'public.add_working_days(date, int, text)'
  ] loop
    begin
      execute format('grant execute on function %s to authenticated', fn);
    exception when undefined_object then null; end;
  end loop;
end $$;
