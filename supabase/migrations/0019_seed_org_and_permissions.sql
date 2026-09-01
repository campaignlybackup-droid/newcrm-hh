-- =====================================================================
-- 0019_seed_org_and_permissions.sql
-- Structural seed: departments, roles and the default permission matrix.
-- This is CONFIGURATION, not demo data — it ships with the product.
-- Sample people and clients live in supabase/seed.sql instead.
--
-- The matrix below is only a starting point: it is fully editable from
-- the Founder-only Roles & Permissions screen, which writes to these
-- same rows.
-- =====================================================================

insert into public.departments (name, code, sort_order) values
  ('Creative',              'CREATIVE',   10),
  ('Production',            'PRODUCTION', 20),
  ('Social Media',          'SOCIAL',     30),
  ('Performance Marketing', 'PERF',       40),
  ('Client Servicing',      'SERVICING',  50),
  ('Sales',                 'SALES',      60),
  ('Technology/Web',        'TECH',       70),
  ('Operations & HR',       'OPSHR',      80)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Roles. Adding one later is an INSERT here plus a row per module in
-- role_permissions — never a code change.
-- ---------------------------------------------------------------------
insert into public.roles (name, code, level, is_manager, is_external, default_scope, department_id, sort_order)
select r.name, r.code, r.level, r.is_manager, r.is_external, r.scope::access_scope,
       (select id from public.departments d where d.code = r.dept), r.sort_order
from (values
  ('Founder',                 'FOUNDER',            0, true,  false, 'ALL',           null,         10),
  ('Co-Founder',              'CO_FOUNDER',         1, true,  false, 'ALL',           null,         20),

  ('Creative Head',           'CREATIVE_HEAD',      2, true,  false, 'SUBTREE', 'CREATIVE',         30),
  ('Production Head',         'PRODUCTION_HEAD',    2, true,  false, 'SUBTREE', 'PRODUCTION',       31),
  ('Social Media Head',       'SOCIAL_HEAD',        2, true,  false, 'SUBTREE', 'SOCIAL',           32),
  ('Performance Head',        'PERF_HEAD',          2, true,  false, 'SUBTREE', 'PERF',             33),
  ('Client Servicing Head',   'SERVICING_HEAD',     2, true,  false, 'SUBTREE', 'SERVICING',        34),
  ('Sales Head',              'SALES_HEAD',         2, true,  false, 'SUBTREE', 'SALES',            35),
  ('Operations/HR Head',      'OPSHR_HEAD',         2, true,  false, 'SUBTREE', 'OPSHR',            36),

  ('Account Manager',         'ACCOUNT_MANAGER',    3, true,  false, 'SUBTREE', 'SERVICING',        40),
  ('Project Manager',         'PROJECT_MANAGER',    3, true,  false, 'SUBTREE', 'SERVICING',        41),
  ('Production Manager',      'PRODUCTION_MANAGER', 3, true,  false, 'SUBTREE', 'PRODUCTION',       42),
  ('Social Media Manager',    'SOCIAL_MANAGER',     3, true,  false, 'SUBTREE', 'SOCIAL',           43),
  ('Sales Manager',           'SALES_MANAGER',      3, true,  false, 'SUBTREE', 'SALES',            44),

  ('Edit Lead',               'EDIT_LEAD',          4, true,  false, 'SUBTREE', 'PRODUCTION',       50),
  ('Design Lead',             'DESIGN_LEAD',        4, true,  false, 'SUBTREE', 'CREATIVE',         51),
  ('Content Lead',            'CONTENT_LEAD',       4, true,  false, 'SUBTREE', 'SOCIAL',           52),

  ('Video Editor',            'VIDEO_EDITOR',       5, false, false, 'OWN',     'PRODUCTION',       60),
  ('Graphic Designer',        'GRAPHIC_DESIGNER',   5, false, false, 'OWN',     'CREATIVE',         61),
  ('Cinematographer/DOP',     'DOP',                5, false, false, 'OWN',     'PRODUCTION',       62),
  ('Camera Assistant',        'CAMERA_ASSISTANT',   5, false, false, 'OWN',     'PRODUCTION',       63),
  ('Photographer',            'PHOTOGRAPHER',       5, false, false, 'OWN',     'PRODUCTION',       64),
  ('Copywriter',              'COPYWRITER',         5, false, false, 'OWN',     'CREATIVE',         65),
  ('Social Media Executive',  'SOCIAL_EXECUTIVE',   5, false, false, 'OWN',     'SOCIAL',           66),
  ('Ads Specialist',          'ADS_SPECIALIST',     5, false, false, 'OWN',     'PERF',             67),
  ('SEO Specialist',          'SEO_SPECIALIST',     5, false, false, 'OWN',     'PERF',             68),
  ('Web Developer',           'WEB_DEVELOPER',      5, false, false, 'OWN',     'TECH',             69),
  ('Sales Executive/BDR',     'SALES_EXECUTIVE',    5, false, false, 'OWN',     'SALES',            70),

  ('Intern',                  'INTERN',             6, false, false, 'OWN',      null,              80),
  ('Freelancer',              'FREELANCER',         6, false, false, 'OWN',      null,              81),

  ('Client User',             'CLIENT_USER',       99, false, true,  'CLIENT_PORTAL', null,         99)
) as r(name, code, level, is_manager, is_external, scope, dept, sort_order)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Default permission matrix, derived from role level.
-- ---------------------------------------------------------------------
do $$
declare
  r        record;
  m        record;
  v_scope  access_scope;
  v_view   boolean; v_create boolean; v_edit boolean; v_delete boolean;
  v_assign boolean; v_approve boolean; v_export boolean;

  -- Modules an executor works inside every day.
  c_exec_modules text[] := array['tasks','deliverables','assets','content_calendar','shoots','approvals','templates'];
  -- Modules a team lead additionally steers.
  c_lead_modules text[] := array['tasks','deliverables','assets','content_calendar','shoots','approvals','campaigns','templates','equipment'];
  -- What the client portal may ever see.
  c_portal_modules text[] := array['deliverables','content_calendar','approvals','meetings','reports'];
begin
  for r in select * from public.roles loop
    for m in select key from public.modules loop

      v_scope  := r.default_scope;
      v_view   := false; v_create := false; v_edit := false; v_delete := false;
      v_assign := false; v_approve := false; v_export := false;

      if r.level <= 1 then
        -- Founder / Co-Founder: everything, everywhere, always.
        v_scope := 'ALL';
        v_view := true; v_create := true; v_edit := true; v_delete := true;
        v_assign := true; v_approve := true; v_export := true;

      elsif r.is_external then
        -- Client portal: read their own work, decide their own approvals.
        if m.key = any (c_portal_modules) then
          v_scope := 'CLIENT_PORTAL';
          v_view := true;
          v_approve := (m.key = 'approvals');
        else
          v_scope := 'NONE';
        end if;

      elsif r.level = 2 then
        -- Department head: their whole subtree, no destructive rights.
        v_scope := 'SUBTREE';
        v_view := true; v_create := true; v_edit := true;
        v_assign := true; v_approve := true; v_export := true;
        if m.key = 'settings' then
          v_create := false; v_edit := false; v_assign := false; v_approve := false;
        end if;
        if m.key = 'audit_log' then
          v_create := false; v_edit := false; v_assign := false; v_approve := false; v_export := false;
        end if;

      elsif r.level = 3 then
        -- Manager: their subtree and their assigned clients only.
        v_scope := 'SUBTREE';
        v_view := true; v_create := true; v_edit := true;
        v_assign := true; v_approve := true; v_export := true;
        if m.key in ('settings','audit_log','people') then
          v_create := false; v_edit := (m.key = 'people'); v_assign := false;
          v_approve := (m.key = 'people'); v_export := (m.key <> 'settings');
        end if;
        if m.key = 'leaves' then
          v_approve := true;   -- managers approve their reports' leave
        end if;

      elsif r.level = 4 then
        -- Team lead: steers the work of their reports.
        if m.key = any (c_lead_modules) then
          v_scope := 'SUBTREE';
          v_view := true; v_create := true; v_edit := true; v_assign := true; v_export := true;
          v_approve := (m.key in ('approvals','deliverables','assets','content_calendar'));
        elsif m.key in ('clients','projects','meetings','people','leaves') then
          v_scope := 'TEAM';
          v_view := true;
        else
          v_scope := 'NONE';
        end if;

      elsif r.level = 5 then
        -- Executor: only their own work. No client list.
        if m.key = any (c_exec_modules) then
          v_scope := 'OWN';
          v_view := true;
          v_edit := (m.key in ('tasks','deliverables','assets','content_calendar'));
          v_create := (m.key in ('assets','tasks'));
        elsif m.key = 'leaves' then
          v_scope := 'OWN'; v_view := true; v_create := true;
        elsif m.key = 'projects' then
          v_scope := 'OWN'; v_view := true;
        else
          v_scope := 'NONE';
        end if;
        -- Sales executives work leads, not production.
        if r.code = 'SALES_EXECUTIVE' and m.key = 'leads' then
          v_scope := 'OWN'; v_view := true; v_create := true; v_edit := true; v_export := true;
        end if;

      elsif r.level = 6 then
        -- Intern / Freelancer: the task and its attachments. Nothing else.
        if m.key = 'tasks' then
          v_scope := 'OWN'; v_view := true; v_edit := true;
        elsif m.key = 'assets' then
          v_scope := 'OWN'; v_view := true; v_create := true;
        elsif m.key = 'leaves' then
          v_scope := 'OWN'; v_view := true; v_create := true;
        else
          v_scope := 'NONE';
        end if;
      end if;

      insert into public.role_permissions (
        role_id, module, can_view, can_create, can_edit, can_delete,
        can_assign, can_approve, can_export, scope)
      values (r.id, m.key, v_view, v_create, v_edit, v_delete,
              v_assign, v_approve, v_export, v_scope)
      on conflict (role_id, module) do nothing;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Default approval chain (client_id null = applies to every client that
-- has not overridden it).
-- ---------------------------------------------------------------------
insert into public.approval_chains (client_id, entity_type, deliverable_type, step_no, level, approver_role_id, sla_days)
select null, 'deliverables', null, s.step_no, s.level::approval_level,
       (select id from public.roles ro where ro.code = s.role_code), s.sla_days
from (values
  (1, 'Internal', 'EDIT_LEAD',       1),
  (2, 'Manager',  'ACCOUNT_MANAGER', 1),
  (3, 'Client',   null,              2)
) as s(step_no, level, role_code, sla_days)
where not exists (
  select 1 from public.approval_chains ac
   where ac.client_id is null and ac.entity_type = 'deliverables'
     and ac.deliverable_type is null and ac.step_no = s.step_no
);

insert into public.approval_chains (client_id, entity_type, deliverable_type, step_no, level, approver_role_id, sla_days)
select null, 'content_calendar', null, s.step_no, s.level::approval_level,
       (select id from public.roles ro where ro.code = s.role_code), s.sla_days
from (values
  (1, 'Internal', 'CONTENT_LEAD',    1),
  (2, 'Manager',  'SOCIAL_MANAGER',  1),
  (3, 'Client',   null,              1)
) as s(step_no, level, role_code, sla_days)
where not exists (
  select 1 from public.approval_chains ac
   where ac.client_id is null and ac.entity_type = 'content_calendar'
     and ac.deliverable_type is null and ac.step_no = s.step_no
);

-- ---------------------------------------------------------------------
-- Standard production templates. These are what turn a service-scope
-- row into a dated task chain with no typing.
-- ---------------------------------------------------------------------
insert into public.project_templates (name, type, description)
values ('Social Media Retainer', 'Retainer',
        'Default monthly retainer: concept, shoot, edit, review, approval, schedule.')
on conflict (name) do nothing;

insert into public.checklist_templates (name, task_type, items) values
  ('Edit QC', 'Edit', '[
     {"label":"Correct aspect ratio and safe margins","sort_order":1},
     {"label":"Brand colours and logo lockup applied","sort_order":2},
     {"label":"Audio levels normalised","sort_order":3},
     {"label":"Captions burned in and spell-checked","sort_order":4},
     {"label":"Export preset matches platform","sort_order":5}]'),
  ('Publish Checklist', 'Schedule', '[
     {"label":"Caption and hashtags final","sort_order":1},
     {"label":"Cover frame selected","sort_order":2},
     {"label":"Collaborator and location tags added","sort_order":3},
     {"label":"Scheduled at the agreed slot","sort_order":4}]')
on conflict (name) do nothing;

do $$
declare
  v_pt  uuid;
  v_dt  uuid;
  v_qc  uuid := (select id from public.checklist_templates where name = 'Edit QC');
  v_pub uuid := (select id from public.checklist_templates where name = 'Publish Checklist');
  v_type text;
begin
  select id into v_pt from public.project_templates where name = 'Social Media Retainer';

  foreach v_type in array array['Reel','Carousel','Static'] loop
    insert into public.deliverable_templates (project_template_id, name, deliverable_type,
                                              default_qty, default_sla_days, sort_order)
    select v_pt, v_type, v_type, 1, 7,
           case v_type when 'Reel' then 10 when 'Carousel' then 20 else 30 end
    where not exists (
      select 1 from public.deliverable_templates dt
       where dt.project_template_id = v_pt and dt.deliverable_type = v_type);

    select id into v_dt from public.deliverable_templates
     where project_template_id = v_pt and deliverable_type = v_type;

    -- offset_days_from_due is relative to the deliverable due date and
    -- negative, so the chain lands BEFORE the date the client sees.
    insert into public.task_templates (
      deliverable_template_id, deliverable_type, title, task_type, sort_order,
      offset_days_from_due, duration_days, estimated_hours,
      default_role_id, depends_on_sort_order, lag_days, checklist_template_id)
    select v_dt, v_type, s.title, s.task_type, s.sort_order,
           s.offset_days, s.duration, s.hours,
           (select id from public.roles ro where ro.code = s.role_code),
           s.depends_on, s.lag,
           case when s.task_type = 'Edit' then v_qc
                when s.task_type = 'Schedule' then v_pub end
    from (values
      ('Concept & hook',      'Concept',  1, -12, 1, 2.0, 'CONTENT_LEAD',    null, 0),
      ('Script / copy',       'Copy',     2, -11, 1, 2.0, 'COPYWRITER',      1,    0),
      ('Shoot',               'Shoot',    3,  -9, 1, 6.0, 'DOP',             2,    0),
      ('Edit v1',             'Edit',     4,  -6, 2, 6.0, 'VIDEO_EDITOR',    3,    1),
      ('Internal review',     'Review',   5,  -4, 1, 1.0, 'EDIT_LEAD',       4,    0),
      ('Client approval',     'Approval', 6,  -3, 1, 0.5, 'ACCOUNT_MANAGER', 5,    0),
      ('Schedule & publish',  'Schedule', 7,  -1, 1, 0.5, 'SOCIAL_EXECUTIVE',6,    0)
    ) as s(title, task_type, sort_order, offset_days, duration, hours, role_code, depends_on, lag)
    where not exists (
      select 1 from public.task_templates tt
       where tt.deliverable_template_id = v_dt and tt.sort_order = s.sort_order);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Fixed-date national holidays. Festival dates move every year and are
-- not invented here — Operations adds them from the official gazette.
-- ---------------------------------------------------------------------
insert into public.holidays (holiday_on, name, country) values
  ('2026-01-26', 'Republic Day',      'India'),
  ('2026-08-15', 'Independence Day',  'India'),
  ('2026-10-02', 'Gandhi Jayanti',    'India'),
  ('2027-01-26', 'Republic Day',      'India'),
  ('2027-08-15', 'Independence Day',  'India'),
  ('2027-10-02', 'Gandhi Jayanti',    'India')
on conflict (holiday_on, country) do nothing;

select public.assert_no_money_columns();
