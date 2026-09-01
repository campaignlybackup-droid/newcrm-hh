-- =====================================================================
-- seed.sql — sample org and book of business for development and for the
-- acceptance test suite.
--
-- Shape (this is what the visibility tests depend on):
--   Founder
--   └── Co-Founder
--       ├── Client Servicing Head
--       │   ├── Manager A ──── clients: Aurora, Basil, Cobalt
--       │   │   ├── Edit Lead A
--       │   │   │   ├── Editor A1
--       │   │   │   └── Editor A2
--       │   │   ├── Designer A3
--       │   │   └── Intern A4
--       │   └── Manager B ──── clients: Dune, Ember
--       │       ├── Content Lead B
--       │       │   ├── Editor B1
--       │       │   └── Social Exec B2
--       │       └── Freelancer B3
--       └── Production Head
--           └── Manager C ──── client: Fable
--               ├── DOP C1
--               └── Camera Assistant C2
--
-- Manager A and Manager B are SIBLINGS. Neither may see the other's
-- clients, tasks, shoots or posts — that is the central assertion.
--
-- UUIDs are fixed so tests can address rows by name.
-- =====================================================================

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
insert into public.users (id, auth_id, full_name, email, role_id, department_id, manager_id,
                          employment_type, joined_on, status, timezone, skills, weekly_capacity_hours)
select v.id::uuid, v.auth_id::uuid, v.full_name, v.email,
       (select id from public.roles where code = v.role_code),
       (select id from public.departments where code = v.dept_code),
       nullif(v.manager_id, '')::uuid,
       v.employment::employment_type, date '2025-04-01', 'Active'::user_status,
       'Asia/Kolkata', v.skills::text[], v.capacity
from (values
  ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Ira Founder',      'founder@agency.test',   'FOUNDER',          null,        '',                                     'Full-time','{}',40),
  ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Cyrus Co-Founder', 'cofounder@agency.test', 'CO_FOUNDER',       null,        '00000000-0000-4000-8000-000000000001','Full-time','{}',40),

  ('00000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000010','Sana Servicing',   'servicehead@agency.test','SERVICING_HEAD',  'SERVICING', '00000000-0000-4000-8000-000000000002','Full-time','{}',40),
  ('00000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000011','Prakash Production','prodhead@agency.test',  'PRODUCTION_HEAD', 'PRODUCTION','00000000-0000-4000-8000-000000000002','Full-time','{}',40),

  ('00000000-0000-4000-8000-0000000000a0','10000000-0000-4000-8000-0000000000a0','Manager A',        'managera@agency.test',  'ACCOUNT_MANAGER',  'SERVICING', '00000000-0000-4000-8000-000000000010','Full-time','{}',40),
  ('00000000-0000-4000-8000-0000000000b0','10000000-0000-4000-8000-0000000000b0','Manager B',        'managerb@agency.test',  'ACCOUNT_MANAGER',  'SERVICING', '00000000-0000-4000-8000-000000000010','Full-time','{}',40),
  ('00000000-0000-4000-8000-0000000000c0','10000000-0000-4000-8000-0000000000c0','Manager C',        'managerc@agency.test',  'PRODUCTION_MANAGER','PRODUCTION','00000000-0000-4000-8000-000000000011','Full-time','{}',40),

  ('00000000-0000-4000-8000-0000000000a1','10000000-0000-4000-8000-0000000000a1','Lead A',           'leada@agency.test',     'EDIT_LEAD',        'PRODUCTION','00000000-0000-4000-8000-0000000000a0','Full-time','{"premiere","davinci"}',40),
  ('00000000-0000-4000-8000-0000000000a2','10000000-0000-4000-8000-0000000000a2','Editor A1',        'editora1@agency.test',  'VIDEO_EDITOR',     'PRODUCTION','00000000-0000-4000-8000-0000000000a1','Full-time','{"premiere"}',40),
  ('00000000-0000-4000-8000-0000000000a3','10000000-0000-4000-8000-0000000000a3','Editor A2',        'editora2@agency.test',  'VIDEO_EDITOR',     'PRODUCTION','00000000-0000-4000-8000-0000000000a1','Full-time','{"aftereffects"}',40),
  ('00000000-0000-4000-8000-0000000000a4','10000000-0000-4000-8000-0000000000a4','Designer A3',      'designera3@agency.test','GRAPHIC_DESIGNER', 'CREATIVE',  '00000000-0000-4000-8000-0000000000a0','Full-time','{"figma"}',40),
  ('00000000-0000-4000-8000-0000000000a5','10000000-0000-4000-8000-0000000000a5','Intern A4',        'interna4@agency.test',  'INTERN',           'CREATIVE',  '00000000-0000-4000-8000-0000000000a0','Intern','{}',20),

  ('00000000-0000-4000-8000-0000000000b1','10000000-0000-4000-8000-0000000000b1','Lead B',           'leadb@agency.test',     'CONTENT_LEAD',     'SOCIAL',    '00000000-0000-4000-8000-0000000000b0','Full-time','{"copy"}',40),
  ('00000000-0000-4000-8000-0000000000b2','10000000-0000-4000-8000-0000000000b2','Editor B1',        'editorb1@agency.test',  'VIDEO_EDITOR',     'PRODUCTION','00000000-0000-4000-8000-0000000000b1','Full-time','{"premiere"}',40),
  ('00000000-0000-4000-8000-0000000000b3','10000000-0000-4000-8000-0000000000b3','Social Exec B2',   'socialb2@agency.test',  'SOCIAL_EXECUTIVE', 'SOCIAL',    '00000000-0000-4000-8000-0000000000b1','Full-time','{}',40),
  ('00000000-0000-4000-8000-0000000000b4','10000000-0000-4000-8000-0000000000b4','Freelancer B3',    'freelancerb3@agency.test','FREELANCER',     'PRODUCTION','00000000-0000-4000-8000-0000000000b0','Freelancer','{"premiere"}',20),

  ('00000000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-0000000000c1','DOP C1',           'dopc1@agency.test',     'DOP',              'PRODUCTION','00000000-0000-4000-8000-0000000000c0','Full-time','{"fx3"}',40),
  ('00000000-0000-4000-8000-0000000000c2','10000000-0000-4000-8000-0000000000c2','Camera Asst C2',   'camc2@agency.test',     'CAMERA_ASSISTANT', 'PRODUCTION','00000000-0000-4000-8000-0000000000c0','Full-time','{}',40)
) as v(id, auth_id, full_name, email, role_code, dept_code, manager_id, employment, skills, capacity)
on conflict (id) do nothing;

update public.departments d set head_user_id = u.id
from public.users u
where (d.code, u.email) in (('SERVICING','servicehead@agency.test'), ('PRODUCTION','prodhead@agency.test'))
  and d.head_user_id is null;

-- ---------------------------------------------------------------------
-- Clients. Three branches, six accounts.
-- ---------------------------------------------------------------------
insert into public.clients (id, legal_name, brand_name, industry, city, timezone, status,
                            source, priority, onboarding_date, contract_start_date,
                            contract_end_date, renewal_date, notice_period_days,
                            account_manager_id, service_tags, created_by)
select v.id::uuid, v.legal_name, v.brand_name, v.industry, v.city, v.tz, v.status::client_status,
       'Referral', v.priority::priority_level,
       date '2025-06-01', date '2025-06-01', date '2026-05-31', date '2026-04-30', 30,
       v.am::uuid, v.tags::text[], '00000000-0000-4000-8000-000000000001'::uuid
from (values
  ('20000000-0000-4000-8000-000000000001','Aurora Wellness Pvt Ltd','Aurora','Wellness','Mumbai','Asia/Kolkata','Active','High',    '00000000-0000-4000-8000-0000000000a0','{"reels","design"}'),
  ('20000000-0000-4000-8000-000000000002','Basil Foods LLP',        'Basil', 'F&B',     'Pune',  'Asia/Kolkata','Active','Medium',  '00000000-0000-4000-8000-0000000000a0','{"reels"}'),
  ('20000000-0000-4000-8000-000000000003','Cobalt Interiors',       'Cobalt','Interiors','Delhi','Asia/Kolkata','Active','Medium',  '00000000-0000-4000-8000-0000000000a0','{"design"}'),
  ('20000000-0000-4000-8000-000000000004','Dune Travel Co',         'Dune',  'Travel',  'Goa',   'Asia/Kolkata','Active','High',    '00000000-0000-4000-8000-0000000000b0','{"reels","social"}'),
  ('20000000-0000-4000-8000-000000000005','Ember Fitness',          'Ember', 'Fitness', 'Bengaluru','Asia/Kolkata','Active','Low',  '00000000-0000-4000-8000-0000000000b0','{"social"}'),
  ('20000000-0000-4000-8000-000000000006','Fable Studios',          'Fable', 'Media',   'Chennai','Asia/Kolkata','Active','High',   '00000000-0000-4000-8000-0000000000c0','{"cinematic"}')
) as v(id, legal_name, brand_name, industry, city, tz, status, priority, am, tags)
on conflict (id) do nothing;

insert into public.client_brand_kit (client_id, colour_hex_list, tone_of_voice_notes, do_list, dont_list)
select id, array['#0f172a','#38bdf8'], 'Warm, direct, no jargon.',
       array['Lead with the benefit','Show real people'],
       array['No stock-photo smiles','Never use competitor names']
from public.clients
on conflict (client_id) do nothing;

insert into public.client_contacts (client_id, name, designation, email, phone, is_primary, is_decision_maker)
select c.id, c.brand_name || ' POC', 'Marketing Head',
       'poc.' || lower(c.brand_name) || '@client.test', '+91-90000-0000' || right(c.client_code, 1), true, true
from public.clients c
where not exists (select 1 from public.client_contacts cc where cc.client_id = c.id);

-- The pods. This is the horizontal (TEAM) axis.
insert into public.client_team_members (client_id, user_id, role_on_account, is_lead)
values
  ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a0','Account Manager', true),
  ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','Edit Lead',       false),
  ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000a0','Account Manager', true),
  ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-0000000000a0','Account Manager', true),
  ('20000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-0000000000b0','Account Manager', true),
  ('20000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-0000000000b1','Content Lead',    false),
  ('20000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-0000000000b0','Account Manager', true),
  ('20000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-0000000000c0','Production Manager', true)
on conflict (client_id, user_id) do nothing;

-- ---------------------------------------------------------------------
-- Service scope. Inserting these rows FIRES THE ONBOARDING CASCADE:
-- project, cycle, deliverables, task chains, approval flow and kickoff
-- meeting all appear without another statement.
-- ---------------------------------------------------------------------
insert into public.client_service_scope (client_id, deliverable_type, qty_per_cycle, sla_days,
                                         review_rounds_allowed, default_owner_id, platform)
values
  ('20000000-0000-4000-8000-000000000001','Reel',     4, 5, 2, '00000000-0000-4000-8000-0000000000a2','Instagram'),
  ('20000000-0000-4000-8000-000000000001','Carousel', 2, 4, 2, '00000000-0000-4000-8000-0000000000a4','Instagram'),
  ('20000000-0000-4000-8000-000000000002','Reel',     2, 7, 1, '00000000-0000-4000-8000-0000000000a3','Instagram'),
  ('20000000-0000-4000-8000-000000000003','Static',   3, 6, 2, '00000000-0000-4000-8000-0000000000a4','Instagram'),
  ('20000000-0000-4000-8000-000000000004','Reel',     4, 5, 2, '00000000-0000-4000-8000-0000000000b2','Instagram'),
  ('20000000-0000-4000-8000-000000000005','Static',   2, 7, 1, '00000000-0000-4000-8000-0000000000b3','Instagram'),
  ('20000000-0000-4000-8000-000000000006','Reel',     3, 5, 2, '00000000-0000-4000-8000-0000000000c1','YouTube')
on conflict (client_id, deliverable_type) do nothing;

-- ---------------------------------------------------------------------
-- Client portal users — one for a Manager A account, one for Manager B's.
-- ---------------------------------------------------------------------
insert into public.users (id, auth_id, full_name, email, role_id, client_id,
                          employment_type, status, timezone)
select v.id::uuid, v.auth_id::uuid, v.full_name, v.email,
       (select id from public.roles where code = 'CLIENT_USER'),
       v.client_id::uuid, 'External'::employment_type, 'Active'::user_status, 'Asia/Kolkata'
from (values
  ('00000000-0000-4000-8000-0000000000f1','10000000-0000-4000-8000-0000000000f1','Aurora Client User','client.aurora@client.test','20000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000000000f2','10000000-0000-4000-8000-0000000000f2','Dune Client User',  'client.dune@client.test',  '20000000-0000-4000-8000-000000000004')
) as v(id, auth_id, full_name, email, client_id)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Production: equipment, a shoot per branch, crew
-- ---------------------------------------------------------------------
insert into public.equipment (id, item_name, category, asset_tag, custodian_id)
values
  ('30000000-0000-4000-8000-000000000001','Sony FX3',        'Camera',   'CAM-001','00000000-0000-4000-8000-0000000000c1'),
  ('30000000-0000-4000-8000-000000000002','Sony 24-70 GM II','Lens',     'LEN-001','00000000-0000-4000-8000-0000000000c1'),
  ('30000000-0000-4000-8000-000000000003','Aputure 600D',    'Lighting', 'LGT-001','00000000-0000-4000-8000-0000000000c2'),
  ('30000000-0000-4000-8000-000000000004','Rode Wireless GO','Audio',    'AUD-001','00000000-0000-4000-8000-0000000000c2')
on conflict (id) do nothing;

insert into public.shoots (id, client_id, title, shoot_date, call_time, wrap_time,
                           location_name, address, type, status, director_id, created_by)
values
  ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Aurora — August Reels',
   current_date + 7, time '08:00', time '17:00', 'Aurora Flagship Store', 'Bandra West, Mumbai',
   'Reel','Confirmed','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000a0'),
  ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000004','Dune — Goa Campaign',
   current_date + 10, time '06:30', time '15:00', 'Ashwem Beach', 'North Goa',
   'Cinematic','Confirmed','00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000b0')
on conflict (id) do nothing;

insert into public.shoot_crew (shoot_id, user_id, role_on_shoot, individual_call_time, confirmed)
values
  ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','DOP',              time '07:30', true),
  ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c2','Camera Assistant', time '07:00', true),
  ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','Editor on set',    time '09:00', false),
  ('40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000c1','DOP',              time '06:00', true)
on conflict (shoot_id, user_id) do nothing;

insert into public.equipment_bookings (equipment_id, shoot_id, out_date, in_date, purpose, booked_for)
values
  ('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001', current_date + 6, current_date + 8, 'Aurora reels', '00000000-0000-4000-8000-0000000000c1'),
  ('30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001', current_date + 6, current_date + 8, 'Key light',    '00000000-0000-4000-8000-0000000000c2')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Content calendar
-- ---------------------------------------------------------------------
insert into public.content_calendar (client_id, platform, post_date, post_time, content_type,
                                     title, hook, caption, hashtags, owner_id, reviewer_id, status)
select c.id, 'Instagram', current_date + (n * 3), time '11:00', 'Reel',
       c.brand_name || ' — post ' || n,
       'Three things nobody tells you about ' || lower(c.industry),
       'Full breakdown in the caption.', array['#'||lower(c.brand_name), '#reels'],
       c.account_manager_id, c.account_manager_id, 'Not Started'
from public.clients c cross join generate_series(1, 3) n
where not exists (select 1 from public.content_calendar cc where cc.client_id = c.id);

-- ---------------------------------------------------------------------
-- Availability, leave, and an automation rule with a round-robin pool
-- ---------------------------------------------------------------------
insert into public.availability (user_id, weekday, is_working, start_time, end_time)
select u.id, d, d between 1 and 5, time '10:00', time '19:00'
from public.users u cross join generate_series(0, 6) d
where u.deleted_at is null
on conflict (user_id, weekday) do nothing;

insert into public.leave_requests (user_id, from_date, to_date, type, reason, status, approver_id, decided_at)
values ('00000000-0000-4000-8000-0000000000a2', current_date + 5, current_date + 9, 'Casual',
        'Family function', 'Approved', '00000000-0000-4000-8000-0000000000a1', now())
on conflict do nothing;

insert into public.automation_rules (name, client_id, task_type, strategy, pool_user_ids, skip_on_leave, priority)
values ('Aurora edits — round robin', '20000000-0000-4000-8000-000000000001', 'Edit', 'round_robin',
        array['00000000-0000-4000-8000-0000000000a2'::uuid, '00000000-0000-4000-8000-0000000000a3'::uuid],
        true, 10)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- A lead in the pipeline, ready for one-click conversion
-- ---------------------------------------------------------------------
insert into public.leads (id, company, brand_name, contact_name, contact_email, contact_phone,
                          designation, industry, city, source, stage, owner_id,
                          next_action_date, expected_start_date, service_interest)
values ('50000000-0000-4000-8000-000000000001','Gilded Jewels Pvt Ltd','Gilded','Nikhil Rao',
        'nikhil@gilded.test','+91-98800-11223','Founder','Jewellery','Jaipur','Instagram DM',
        'Proposal Sent','00000000-0000-4000-8000-0000000000b0', current_date + 2, current_date + 21,
        array['reels','design'])
on conflict (id) do nothing;

select 'seed complete' as status,
       (select count(*) from public.users)        as users,
       (select count(*) from public.clients)      as clients,
       (select count(*) from public.projects)     as projects,
       (select count(*) from public.deliverables) as deliverables,
       (select count(*) from public.tasks)        as tasks;
