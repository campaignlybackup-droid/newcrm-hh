-- =====================================================================
-- 0030_fix_permissions.sql
-- Forcefully corrects any missing or stale role_permissions for Founders
-- and Department Heads (like Manav) so interlinking and visibility work.
-- =====================================================================

-- 1. Ensure Founder & Co-Founder (level <= 1) have ALL access to EVERYTHING.
insert into public.role_permissions (
  role_id, module, can_view, can_create, can_edit, can_delete,
  can_assign, can_approve, can_export, scope
)
select r.id, m.key, true, true, true, true, true, true, true, 'ALL'::access_scope
from public.roles r
cross join public.modules m
where r.level <= 1
on conflict (role_id, module) do update set
  can_view = true,
  can_create = true,
  can_edit = true,
  can_delete = true,
  can_assign = true,
  can_approve = true,
  can_export = true,
  scope = 'ALL'::access_scope;

-- 2. Give Department Heads (like Manav) ALL access to clients, projects, and leads.
update public.role_permissions
   set can_view = true,
       can_create = true,
       can_edit = true,
       can_assign = true,
       can_export = true,
       scope = 'ALL'::access_scope
 where module in ('clients', 'leads', 'projects', 'people')
   and role_id in (select id from public.roles where code in ('PRODUCTION_HEAD', 'OPSHR_HEAD', 'SOCIAL_HEAD', 'SALES_HEAD', 'CREATIVE_HEAD', 'PERF_HEAD'));
