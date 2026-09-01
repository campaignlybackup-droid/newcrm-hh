-- =====================================================================
-- 0020_policy_indexes.sql
-- Every column an RLS policy consults gets index support.
--
-- Two shapes are used deliberately:
--   * For id-like columns, a plain (or partial) btree.
--   * For the low-cardinality flags a policy pairs with a client or user
--     (is_internal, is_client_visible, approval_status ...), a PARTIAL
--     index on the selective column with the flag as the predicate. A
--     standalone index on a two-value boolean would never be chosen by
--     the planner; folding it into the predicate makes it useful.
--
-- scripts/policy-index-audit.mjs proves the set is complete and is wired
-- into the acceptance suite.
-- =====================================================================

-- ---- soft-delete predicates on tables that had no partial index yet ----
create index if not exists checklist_items_live_idx        on public.checklist_items (task_id) where deleted_at is null;
create index if not exists client_brand_kit_live_idx       on public.client_brand_kit (client_id) where deleted_at is null;
create index if not exists client_service_scope_live_idx   on public.client_service_scope (client_id) where deleted_at is null;
create index if not exists client_social_accounts_live_idx on public.client_social_accounts (client_id) where deleted_at is null;
create index if not exists content_pillars_live_idx        on public.content_pillars (client_id) where deleted_at is null;
create index if not exists departments_live_idx            on public.departments (id) where deleted_at is null;
create index if not exists equipment_live_idx              on public.equipment (id) where deleted_at is null;
create index if not exists lead_activities_live_idx        on public.lead_activities (lead_id) where deleted_at is null;
create index if not exists onboarding_checklists_live_idx  on public.onboarding_checklists (user_id) where deleted_at is null;
create index if not exists retainer_cycles_live_idx        on public.retainer_cycles (client_id) where deleted_at is null;
create index if not exists reviews_live_idx                on public.reviews (user_id) where deleted_at is null;
create index if not exists revisions_live_idx              on public.revisions (deliverable_id) where deleted_at is null;
create index if not exists roles_live_idx                  on public.roles (id) where deleted_at is null;
create index if not exists shot_lists_live_idx             on public.shot_lists (id) where deleted_at is null;
create index if not exists shot_list_items_live_idx        on public.shot_list_items (shot_list_id) where deleted_at is null;
create index if not exists teams_live_idx                  on public.teams (id) where deleted_at is null;

-- ---- ownership / authorship columns consulted by OWN-scope policies ----
create index if not exists clients_created_by_idx      on public.clients (created_by);
create index if not exists leads_created_by_idx        on public.leads (created_by);
create index if not exists teams_lead_user_idx         on public.teams (lead_user_id);
create index if not exists onboarding_checklists_owner_idx on public.onboarding_checklists (owner_id);
create index if not exists attachments_uploaded_by_idx on public.attachments (uploaded_by);
create index if not exists custom_field_values_client_idx on public.custom_field_values (client_id);
create index if not exists entity_tags_client_idx      on public.entity_tags (client_id);

-- ---- flag-qualified partial indexes (the client-portal read paths) ----
create index if not exists approvals_client_level_idx on public.approvals (client_id, level)
  where deleted_at is null;
create index if not exists assets_client_visible_idx on public.assets (client_id)
  where is_client_visible and deleted_at is null;
create index if not exists attachments_client_visible_idx on public.attachments (client_id)
  where is_client_visible and deleted_at is null;
create index if not exists comments_client_external_idx on public.comments (client_id, created_at desc)
  where not is_internal and deleted_at is null;
create index if not exists client_reports_shared_idx on public.client_reports (client_id, report_date desc)
  where approval_status = 'Approved' and shared_at is not null and deleted_at is null;
create index if not exists meetings_client_type_idx on public.meetings (client_id, type)
  where deleted_at is null;
create index if not exists reviews_user_status_idx on public.reviews (user_id, status)
  where deleted_at is null;
create index if not exists saved_views_shared_idx on public.saved_views (module)
  where is_shared;

-- The hot path for the default task list: assignee + due date, with the
-- soft-delete predicate folded in so the index answers the filter alone.
create index if not exists tasks_live_due_idx on public.tasks (due_date, priority desc)
  where deleted_at is null and status not in ('Delivered','Approved','Cancelled');
create index if not exists deliverables_live_due_idx on public.deliverables (due_date)
  where deleted_at is null and status not in ('Delivered','Approved','Cancelled');

analyze;
