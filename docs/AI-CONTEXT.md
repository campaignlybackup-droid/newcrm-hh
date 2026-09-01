# Agency Operations CRM — complete system context

**Purpose of this file.** This is a self-contained briefing for an AI (or engineer) picking
up this codebase cold. It states what exists, why each decision was made, which invariants
must never be broken, and — importantly — the bugs that were found during construction and
their root causes, because most of them are traps a fresh model would walk straight into.

Read this before changing anything. If a statement here conflicts with the code, the code
wins and this file is stale — say so rather than assuming.

---

## 1. What the system is

A multi-user operations CRM for a digital marketing / content production agency. It manages
clients, projects, deliverables, tasks, shoots, content calendars, approvals and people. All
records are interlinked and date-driven.

### The hard rule: no money module

There are **no** invoices, budgets, pricing, payroll, salaries, expenses, revenue or currency
fields anywhere. Where a feature would normally need money, it is modelled with dates and
status instead. Examples of how that was resolved:

| Would normally be money | Modelled instead as |
|---|---|
| Retainer value | `client_service_scope`: quantity per cycle + SLA days + review rounds |
| Deal value on a lead | Stage + `next_action_date` + `expected_start_date` |
| Campaign budget/spend | Date range + objective + status |
| Crew day rates | `shoot_crew`: scheduled/confirmed booleans + call times |
| Equipment purchase cost | `equipment.owned` boolean (owned vs rented-in) |
| Salary / compensation | Absent. `reviews` carries a rating and written feedback only |
| Billable hours | `tasks.estimated_hours` is **workload for balancing a team**, never billing |
| Out-of-scope revision charge | `revisions.is_out_of_scope` — a status flag for the account conversation |

This is enforced by the database, not by reviewer discipline:
`public.assert_no_money_columns()` scans `information_schema.columns` for money-shaped names
and the `money` type, and raises `23514` if any appears. It is called at the end of
migrations `0013` and `0019`, and asserted by acceptance test 18. **Do not weaken this
function to make a column pass** — that inverts its purpose.

---

## 2. Stack

| Layer | Choice | Version as built |
|---|---|---|
| Frontend | Next.js App Router + TypeScript + Tailwind | next 15.5.25, react 19.2.8, tailwind 3.4 |
| Tables | TanStack Table v8 | 8.x |
| Calendar | FullCalendar | 6.1.x |
| Data fetching | TanStack Query v5 | 5.x |
| Validation | Zod | 3.25 |
| Backend / DB | Supabase (Postgres) | supabase-js 2.112, @supabase/ssr **0.12.5** |
| Authorization | Postgres Row Level Security | — |
| Scheduled jobs | pg_cron + Edge Functions (Deno) | — |

**`@supabase/ssr` must be ≥ 0.12.** Version 0.5.x passes its generics positionally to a
`SupabaseClient` whose signature has since changed, so the `Database` type lands in the wrong
slot and every `Insert`/`Update` silently degrades to `never`. This wastes hours if you don't
know it — see §12, bug 6.

---

## 3. Ground truth: how to verify any claim

Everything below can be checked without a Supabase project. The harness downloads a private
PostgreSQL 18 binary (`embedded-postgres`), applies all migrations, seeds an agency and runs
the suite.

```bash
npm test                  # db:check + db:index-audit + test:acceptance
npm run db:check          # apply all migrations to a throwaway database
npm run db:index-audit    # prove every RLS-referenced column is index-backed
npm run test:acceptance   # the 17 acceptance tests (130 assertions)
npm run db:types          # regenerate src/lib/database.types.ts from the live schema
npm run typecheck
npm run build
```

Last verified state: **130 assertions, 0 failures.** 64 tables, 151 policies, 14 views, 292
indexes, 170 triggers, 24 enums, 31 roles × 18 modules = 558 permission rows.

> **Critical testing rule.** The Supabase SQL editor and any superuser connection **bypass
> RLS entirely**. A query that returns rows there proves nothing. Every visibility test must
> run as a non-superuser role with `request.jwt.claims` set:
>
> ```sql
> begin;
> set local role authenticated;
> select set_config('request.jwt.claims',
>   json_build_object('sub','<auth_id>','role','authenticated')::text, true);
> select count(*) from public.tasks;   -- what they actually get
> rollback;
> ```

---

## 4. File map

```
supabase/
  migrations/          22 files, 6,972 lines — see §5
  seed.sql             sample agency: 20 people, 6 clients, 3 manager branches
  functions/           Edge Functions (Deno, NOT typechecked by the app's tsc)
    _shared/cors.ts
    daily-digest/      renders + mails the queued digests
    nightly-backup/    NDJSON dump to a separate bucket, 30-day retention
    call-sheet/        print-styled HTML call sheet, runs as the CALLER
    google-calendar-sync/  two-way sync, per user
    deno.json
src/
  middleware.ts        MUST live here, not at the project root — see §12, bug 4
  modules/
    types.ts           field/module type system + Zod derivation (195 lines)
    registry.ts        THE REGISTRY — every module as data (519 lines)
    enums.ts           UI mirrors of the Postgres enums
  lib/
    supabase/{client,server,middleware}.ts
    session.ts         useSession(), can(), scopeOf()
    records.ts         THE SINGLE MUTATION SURFACE (282 lines)
    filters.ts         filter state <-> URL, timezone-aware date presets
    export.ts          CSV + SpreadsheetML
    database.types.ts  GENERATED — never hand-edit
  components/
    view-engine/       FieldEditor, ListView, KanbanView, CalendarView,
                       TimelineView, FilterBar, SavedViews, BulkBar,
                       ModuleView, DetailView, CreateView, RelatedRecords, Comments
    dashboards/        MyQueue, TeamLoadHeatmap
    ui/                primitives.tsx, Toaster.tsx
  app/
    (app)/[module]/page.tsx        one route serves all 15 modules
    (app)/[module]/[id]/page.tsx   detail + create (`id === 'new'`)
    (app)/{dashboard,calendar,notifications}/
    (app)/settings/{roles,recycle-bin,audit}/
    portal/                        client portal
scripts/
  pg-harness.mjs       boots embedded Postgres, applies migrations
  migrate-check.mjs    schema build gate
  seed-check.mjs       seed + cascade inspection
  policy-index-audit.mjs   derives policy columns from pg_policies, checks index cover
  gen-types.mjs        introspects the live schema -> database.types.ts
  plan-inspect.mjs     EXPLAIN tree walker for performance work
tests/rls/
  acceptance.mjs       tests 1-14 (529 lines)
  acceptance-part2.mjs tests 15-20 (277 lines)
  client-sdk.mjs       same assertions via @supabase/supabase-js, needs a live project
docs/
  ARCHITECTURE.md, OPERATIONS.md, AI-CONTEXT.md (this file)
```

---

## 5. Migration map

Migrations are **additive only** and **idempotent** — a redeploy replays them all, and
acceptance test 17 asserts this changes no data. Never drop or retype a column; add a new one
and backfill. Always write `drop constraint if exists` before `add constraint`.

| # | File | Contains |
|---|---|---|
| 0001 | extensions_and_enums | pgcrypto, ltree, btree_gist, pg_trgm, unaccent; 24 enums; `set_updated_at()` |
| 0002 | org_identity | departments, roles, users (+ ltree path & cycle detection), teams, modules, role_permissions, user_permission_overrides |
| 0003 | clients | clients + contacts, brand kit, social accounts, service scope, documents, team members, content pillars |
| 0004 | leads | leads, lead_activities, `convert_lead_to_client()` |
| 0005 | delivery | projects, retainer_cycles, deliverables, tasks, task_dependencies, checklist_items, revisions |
| 0006 | production | shoots, shoot_crew, equipment, equipment_bookings (exclusion constraint), shot lists, `v_call_sheet` |
| 0007 | social | campaigns, content_calendar |
| 0008 | assets_approvals | assets + asset_versions (append-only), approval_chains, approvals |
| 0009 | comms_reporting | meetings, attendees, action_items, client_reports, comments (+revisions), notifications |
| 0010 | people_ops | holidays, leave_requests, availability, onboarding, reviews, `add_working_days()`, `is_on_leave()` |
| 0011 | system | templates (project/deliverable/task/checklist), sops, automation_rules, saved_views, tags, custom fields, attachments |
| **0012** | **authz_helpers** | **`auth_ctx()` and the whole helper set — the heart of the system** |
| 0013 | audit_and_safety | `activity_log`, generic audit trigger, hard-delete guard, soft delete/restore/purge, recycle bin, **no-money guard** |
| **0014** | **rls_policies** | **151 policies, the `client_portal` role, the extra SECURITY DEFINER predicates** |
| 0015 | automation_core | inheritance triggers, status rollups, dependency date engine, reverse scheduling |
| 0016 | automation_jobs | auto-assignment, leave warnings, approval routing, onboarding cascade, cycle generation, escalation, renewals, digest, duplicate guard |
| 0017 | views | `v_client_context`, `v_capacity`, `v_calendar`, dashboards, **portal views + column grants** |
| 0018 | cron | pg_cron schedules, `fn_trigger_backup()` |
| 0019 | seed_org_and_permissions | 8 departments, 31 roles, the default permission matrix, approval chains, templates, fixed-date holidays |
| 0020 | policy_indexes | index cover for every policy-referenced column |
| 0021 | app_rpcs | `my_context()`, `dashboard_summary()`, `team_load()`, `record_history()`, `shift_task_dates()` |
| 0022 | backup_and_vault | `backup_table_order()`, `vault_read_google_refresh_token()` |

---

## 6. Data model (64 tables)

**Identity & org** — departments, roles, users, teams, team_members, modules,
role_permissions, user_permission_overrides

**Client core (typed once)** — clients, client_contacts, client_brand_kit,
client_social_accounts, client_service_scope, client_documents, client_team_members,
content_pillars

**Pre-client** — leads, lead_activities

**Delivery** — projects, retainer_cycles, deliverables, tasks, task_dependencies,
checklist_items, revisions

**Production** — shoots, shoot_crew, equipment, equipment_bookings, shot_lists,
shot_list_items

**Social** — campaigns, content_calendar

**Assets & approvals** — assets, asset_versions, approval_chains, approvals,
approval_feedback_revisions

**Comms & reporting** — meetings, meeting_attendees, action_items, client_reports, comments,
comment_revisions, notifications

**People ops** — holidays, leave_requests, availability, onboarding_checklists, reviews

**System** — project_templates, deliverable_templates, task_templates, checklist_templates,
sops, automation_rules, saved_views, tags, entity_tags, custom_fields, custom_field_values,
attachments

**Infrastructure** — activity_log, audited_tables

### Column conventions every business table follows

```
id           uuid primary key default gen_random_uuid()
client_id    uuid  -- where applicable; a READ-ONLY MIRROR, see §9
created_at   timestamptz not null default now()
updated_at   timestamptz not null default now()   -- maintained by trigger
created_by   uuid references users(id)
deleted_at   timestamptz     -- soft delete
deleted_by   uuid references users(id)
```

All timestamps are `timestamptz`. **There is not one naive `timestamp` column** and test 15
asserts that. Store UTC, render in the viewer's timezone.

---

## 7. THE VISIBILITY MODEL — the most important section

Access is **two-dimensional**: vertical (the reporting tree) + horizontal (assignment).
A user's visible set is the union of:

| Scope | Meaning |
|---|---|
| `OWN` | they are creator, assignee, reviewer, owner or a listed participant |
| `SUBTREE` | anything belonging to anyone beneath them in `users.path`, recursive, unlimited depth |
| `TEAM` | records for clients/projects they are assigned to |
| `ALL` | levels 0–1 only |
| `CLIENT_PORTAL` | external users: their own client's client-facing records only |
| `NONE` | no access |

### Role levels (data, never hardcoded)

| Level | Roles | Count | Default scope |
|---|---|---|---|
| 0 | Founder | 1 | ALL |
| 1 | Co-Founder | 1 | ALL |
| 2 | Department Heads | 7 | SUBTREE |
| 3 | Managers | 5 | SUBTREE |
| 4 | Team Leads | 3 | SUBTREE |
| 5 | Executors | 11 | OWN |
| 6 | Intern, Freelancer | 2 | OWN (task-scoped) |
| 99 | Client User (external) | 1 | CLIENT_PORTAL |

Adding a role is an `INSERT` into `roles` plus rows in `role_permissions`. No code change.

### The reporting tree

`users.path` is an **ltree**, maintained exclusively by `trg_users_maintain_path`. Labels are
uuids with `-` replaced by `_` and prefixed `u` (ltree labels only accept `[A-Za-z0-9_]`).
Ancestor tests are a single GiST-indexed `<@` containment check at any depth — never a
recursive CTE per row.

Cycle detection: a `manager_id` change is rejected (`23514`) if the prospective manager's
path already contains this user's label. `trg_users_rebuild_descendants` rewrites the subtree
after a manager change.

### Helper function catalogue (migration 0012 + 0014)

Session-scoped (no row argument — **always wrap these in `(select ...)` inside a policy**):

```
jwt_claims()                 -> jsonb    current_setting('request.jwt.claims')
jwt_sub()                    -> uuid     the JWT 'sub'
auth_ctx()                   -> jsonb    THE one lookup per transaction (memoised in a GUC)
auth_user_id()               -> uuid     app user id
auth_role_level()            -> int      999 when unauthenticated
auth_is_active()             -> boolean
is_founder()                 -> boolean  level <= 1
is_client_portal_user()      -> boolean
auth_client_id()             -> uuid     non-null only for portal users
auth_scope(module)           -> access_scope
auth_can(module, action)     -> boolean  non-view actions also require can_view
my_path()                    -> ltree
my_visible_user_ids()        -> setof uuid   me + my subtree
my_client_ids()              -> setof uuid   the TEAM axis
my_team_ids()                -> setof uuid
my_task_client_ids()         -> setof uuid   clients reachable ONLY via an assigned task
```

Row-scoped (take a column — **never wrap these**):

```
is_in_my_subtree(uuid)              is_my_ancestor(uuid)
can_see_client(uuid, module)        can_see_user_work(uuid, module)
can_see_brand_kit(uuid)             can_see_task(uuid)
can_see_deliverable(uuid)           can_see_shoot(uuid)
is_shoot_crew(uuid)                 shoot_has_crew_in_my_subtree(uuid)
is_meeting_participant(uuid)        i_have_a_task_on_deliverable(uuid)
shares_client_pod_with(uuid)
```

**Every one of these is `SECURITY DEFINER` with a pinned `search_path`.** That is not
optional — see gotcha A.

### Canonical policy shape

```sql
create policy tasks_select on public.tasks for select using (
  (deleted_at is null or (select public.is_founder()))          -- soft-delete visibility
  and not (select public.is_client_portal_user())               -- internal-only table
  and (select public.auth_can('tasks','view'))
  and (
    (select public.auth_scope('tasks')) = 'ALL'
    or assignee_id = (select public.auth_user_id())              -- OWN
    or reviewer_id = (select public.auth_user_id())
    or created_by  = (select public.auth_user_id())
    or ((select public.auth_scope('tasks')) = 'SUBTREE'
        and assignee_id in (select id from public.my_visible_user_ids()))
    or ((select public.auth_scope('tasks')) in ('SUBTREE','TEAM')
        and client_id in (select id from public.my_client_ids()))
  )
);
```

### The four hard-won gotchas

**A. Policy helpers must be `SECURITY DEFINER`, or you get infinite recursion.**
A policy on `tasks` that reads `users` re-enters `users`' policy, which reads
`role_permissions`… Postgres raises *"infinite recursion detected in policy for relation X"*.
`SECURITY DEFINER` reads with the definer's rights, so the other table's policy is never
re-entered.

**B. A policy must not name a table the acting role lacks a grant on — even in an
unreachable branch.** Policy expressions are permission-checked when the statement is
**planned**, not when a branch is evaluated. `deliverables_select` had an inline
`exists (select 1 from tasks …)` for the executor case; a `client_portal` user reading their
own deliverables got `permission denied for table tasks`, because planning checked it. Fix:
wrap every cross-table reach in a `SECURITY DEFINER` predicate
(`i_have_a_task_on_deliverable()`, `shares_client_pod_with()`).

**C. Two tables whose policies reference each other deadlock the planner.**
`shoots` referenced `shoot_crew` and vice versa. Fixed with `can_see_shoot()` and
`shoot_has_crew_in_my_subtree()`.

**D. Wrap session-scoped helpers in `(select ...)` or the query is catastrophically slow.**
Postgres constant-folds only `IMMUTABLE` functions. A bare `STABLE` `auth_scope('tasks')` in
a policy is re-evaluated **per candidate row**. Measured on 50k tasks: **35 seconds**.
Wrapped as `(select public.auth_scope('tasks'))` the planner hoists it to a single
`InitPlan`: **47 ms**. All **217** such call sites in `0014` use the wrapped form.

`auth_ctx()` further memoises the whole permission picture in a transaction-local GUC
(`crm.auth_ctx`), so repeat calls are a GUC read rather than a query.

### The client portal is a separate database role

Internal staff and client users are both `authenticated` in stock Supabase, which makes
column-level grants useless. `public.custom_access_token_hook` stamps
`"role": "client_portal"` into the JWT for external users, so PostgREST switches into a role
that has **no privilege on internal tables at all**, plus explicit column grants on the few
it may read (migration 0017).

That is what makes *"a raw API request with a client token returns no internal fields"* true
at the wire level. The acceptance suite asserts the **privilege error `42501`**, not an empty
result — a stronger guarantee.

**Registering this hook in Supabase Auth is mandatory.** Without it, portal accounts fall
back to `authenticated` and lose column isolation entirely.

### Deny by default

Every table has RLS **enabled AND forced**. `npm run db:check` asserts that no table lacks
RLS and no table lacks a policy. `anon` has all grants revoked.

---

## 8. Automation catalogue

Every rule is a database trigger or scheduled function — never UI convenience — so an
import, an API call and the UI all behave identically.

| Rule | Implementation |
|---|---|
| Client onboarding cascade | `fn_client_onboarding_cascade()`, fired by `trg_service_scope_cascade` on `client_service_scope` insert. Creates project, cycle, deliverables, task chains, dependencies, approval flow, kickoff meeting. Idempotent. |
| Recurring cycle generator | `fn_generate_next_cycles()` on pg_cron, 25th monthly at 02:00 |
| Auto-assignment | `fn_pick_assignee()` — strategies `fixed_user`, `round_robin`, `least_loaded`, `by_skill`; skips approved leave and rolls on |
| Dependency date engine | `fn_cascade_task_dates()` — working-day aware, honours `lag_days`, depth-capped at 50 |
| Shoot date cascade | `trg_shoot_date_cascade` — shifts tasks, downstream chain, posts, deliverable, approvals, equipment bookings |
| Reverse scheduling | `fn_schedule_from_post_date()` — back-calculates shoot → edit → internal review → client approval → schedule |
| Status rollups | task → deliverable → project health → client health. `trg_guard_computed_health` silently reverts manual writes |
| Field inheritance | `trg_deliverables_inherit`, `trg_tasks_inherit`; `trg_guard_inherited` rejects edits to mirrors |
| Approval routing | `fn_request_approval()` reads `approval_chains` — no hardcoded Editor→Lead→Manager→Client sequence |
| Approve ≠ edit | `trg_approvals_require_approve_permission` |
| Overdue escalation | `fn_escalate_overdue()` — assignee, then manager next day, then department head at 3 days |
| Renewal alerts | `fn_renewal_alerts()` at 60/30/15/7 days |
| Minutes → tasks | `trg_action_item_to_task` |
| Daily digest | `fn_daily_digest()` + `fn_queue_daily_digests(hour)` hourly, picking users for whom it is locally 09:00 |
| Equipment conflicts | GiST **exclusion constraint** — rejected at constraint level, no check-then-insert race |
| Leave conflicts | `fn_assignment_conflict()` returns a warning plus ranked alternatives; never blocks |
| Duplicate guard | `fn_check_duplicate_client()` via pg_trgm similarity; warns, never blocks |
| Timezone repointing | `trg_client_timezone_repoint` re-derives `post_at_utc` when a client's timezone changes |

### Cascade recursion guard

Triggers that write to other tables call `begin_cascade()` / `end_cascade()`, which increment
a transaction-local depth GUC. Triggers check `in_cascade()` and return early. **Read the GUC
through `cascade_depth()`**, which uses `nullif(..., '')` — see §12, bug 3.

---

## 9. "A client is typed once"

`clients` is the master record. Every other module stores `client_id` and **renders** the
client's data through `v_client_context`; nothing keeps a copy the user must retype.

`deliverables.client_id`, `tasks.client_id` etc. are **read-only mirrors** written by
inheritance triggers, not user input. They exist so RLS can filter on one indexed local
column instead of walking three joins per row. In the UI they are marked
`inheritedFrom: 'project'` in the registry, which renders them locked with an explanation
pointing at the parent.

Acceptance test 8 renames a client and asserts the new name appears identically in **8**
modules while existing in exactly one row, and that no other **base table** holds a
`brand_name` or `legal_name` column. (Views that render the name are the point; a second base
table holding a copy would be the violation.)

---

## 10. Audit and data safety

**`activity_log`** — a single generic trigger (`trg_audit`) on every business table writes
**one row per changed field**, with `entity_type, entity_id, client_id, actor_id, is_system,
action, field_name, old_value, new_value, changed_at, ip, user_agent, request_id`.
Automated/system changes are recorded with `actor_id = null, is_system = true`. The log is
append-only — `trg_activity_log_append_only` refuses UPDATE and DELETE, so it cannot be
rewritten from the application. There is no INSERT policy: rows arrive only through the
`SECURITY DEFINER` trigger.

Membership is declared in `public.audited_tables`. **Adding a business table means adding a
row there**, otherwise it gets no audit trigger and no delete guard.

**Soft delete** — a raw `DELETE` is blocked by `trg_block_hard_delete` (`42501`). The only
physical delete path is `hard_delete(entity_type, id, confirmation)`, which is Founder-only
and requires the typed string `DELETE <table>`. It sets `crm.allow_hard_delete = on` for the
duration so cascades succeed.

**Restore is non-destructive** because soft delete never removed the row: every foreign key
still resolves. Test 12 asserts a restored client returns with its projects, deliverables and
tasks intact.

**Immutability** — `asset_versions` is append-only; a new upload forks a version rather than
overwriting. Comment and approval-feedback edits write a visible revision row.

---

## 11. Frontend architecture

### The registry is the whole design

`src/modules/registry.ts` describes each module as data. From that one description the app
derives: list columns and their inline editors, the detail page sections, the create form,
the Zod schema, the filter bar (including the date-field picker), and the export columns.

```ts
interface ModuleDef {
  key: ModuleKey;          // matches public.modules.key AND role_permissions.module
  table: TableName;        // literal key of Database['public']['Tables'] — NOT string
  label; singular; titleField;
  fields: FieldDef[];
  views: ViewMode[];       // 'list' | 'kanban' | 'calendar' | 'timeline'
  defaultView; kanbanGroupBy; kanbanGroupOptions;
  calendar?: { start; end?; allDay? };
  timeline?: { start; end; groupBy? };
  dateFields: { key; label }[];   // what the user may filter the range on
  select: string;          // PostgREST select incl. embedded relations
  defaultSort; clientScoped; softDelete; searchFields;
}

interface FieldDef {
  key; label; type;        // text|longtext|number|date|datetime|time|select|
                           // multiselect|boolean|user|client|relation|tags|url|email|phone|json
  options?; relation?;     // static options, or a table to read options from
  required?; editable?;    // editable:false = computed, never writable
  inheritedFrom?;          // read-only mirror of a parent field
  inList?; width?; section?; help?;
  permissionAction?;       // defaults to 'edit'; e.g. 'assign' or 'approve'
}
```

`moduleSchema(mod)` and `modulePatchSchema(mod)` **derive** Zod schemas from `fields`. They
are not written alongside the fields — that is what makes list and detail validation
identical by construction rather than by discipline.

There is **one route** for all 15 modules (`app/(app)/[module]/page.tsx`) and one detail route
(`[id]/page.tsx`, where `id === 'new'` renders the create form). Adding a module is a registry
entry, not a screen.

### The single mutation surface

`src/lib/records.ts` `useUpdateRecord()` is the **only** write path for record edits. An
inline list cell and a detail-page field both call it, so they:

1. validate with the same derived schema (`modulePatchSchema`),
2. hit the same `UPDATE`, therefore the same RLS policy and the same CHECK constraints,
3. get the same optimistic update, rollback-on-error and Undo toast.

There is no second, looser write path in the codebase. **Do not add one.** This is what makes
acceptance test 10 ("every field editable in list view is editable on the detail page with
identical validation and identical permission enforcement") structurally true.

Editability is computed identically in `ListView.editableFor()` and `DetailView.guardFor()`
from exactly two inputs: `isEditable(field)` and `can(session, module, action)`.

### `can()` is chrome, not security

`src/lib/session.ts` `can()` decides which buttons render. It is **not** the authorization
boundary — hiding a button changes nothing about what the database accepts. Never "fix" an
access bug by changing `can()`; fix the policy.

### The dynamic Supabase handle

`supabaseDynamic()` returns a deliberately untyped client. The view engine builds its table
name and select string from the registry at runtime, so PostgREST's compile-time select
parser has nothing to work from and collapses results to an error type. Correctness is not
lost, only relocated: those writes are Zod-validated before sending and RLS/CHECK-enforced on
arrival. Use the typed `supabase()` everywhere the table name is a literal.

### Generated types

`src/lib/database.types.ts` is produced by `scripts/gen-types.mjs` introspecting the live
schema. **Never hand-edit it.** Regenerate after every migration: `npm run db:types`.

The generator must emit `Relationships: [...]` on every table and view — supabase-js's
`GenericSchema` constraint requires it, and without it the whole `Database` type silently
fails the constraint and every `Insert`/`Update` becomes `never`. It also emits **distinct**
function names; an overloaded function appearing twice creates a duplicate key that poisons
the type literal.

---

## 12. Bug post-mortems

These are the traps. Each cost real time and each is now covered by a test or a comment.

**1. `~*` and `||` share a precedence level.**
`col ~* 'a' || 'b'` parses as `(col ~* 'a') || 'b'` → *"argument of OR must be type boolean"*.
Parenthesise concatenated regexes: `col ~* ('a' || 'b')`.

**2. CHECK constraints cannot contain subqueries.**
`check((select bool_and(...) from unnest(arr)))` is rejected. Move the logic into an
`IMMUTABLE` function (`are_hex_colours()`) and call that.

**3. A custom GUC returns `''`, not NULL, after a transaction that set it rolls back.**
`coalesce(current_setting('crm.cascade_depth', true), '0')::int` threw
*"invalid input syntax for integer: """*. Always
`coalesce(nullif(current_setting(...), '')::int, 0)`. This only appears once tests run
multiple rolled-back transactions in one session — easy to miss.

**4. With a `src/` directory, middleware must be `src/middleware.ts`.**
It was at the project root, so Next never loaded it and **every protected route returned 200
to anonymous users**. The build output tells you: `ƒ Middleware` appears only when it is
registered. This was invisible to typecheck and to `next build`; only driving the browser
caught it.

**5. `next dev <dir>` does not change the process cwd.**
Tailwind resolved `tailwind.config.ts` against the launcher's directory, found nothing, fell
back to stock Tailwind, and every custom colour vanished. Fix: pin the config path in
`postcss.config.mjs` via `import.meta.url`, and anchor `content` globs to `__dirname`.

**6. `@supabase/ssr@0.5.x` breaks typing with modern supabase-js.**
It passes generics positionally to a `SupabaseClient` whose signature changed, so the schema
lands in the wrong slot and everything becomes `never`. Upgrade to ≥ 0.12.

**7. Mixing comma-joins and `JOIN` changes scope.**
`from a, b join c on c.x = a.x` — the `ON` binds to `b` only, so `a` is out of scope
(*"invalid reference to FROM-clause entry"*). Put the cross join last:
`from a join c on c.x = a.x cross join b`.

**8. `array_agg(name_column)` is not parsed by node-postgres.**
`pg_attribute.attname` is type `name`; there is no default array parser. Cast:
`array_agg(x::text)`.

**9. A backtick inside a SQL comment terminates a JS template literal.**
Cost a confusing `SyntaxError: missing ) after argument list`.

**10. Changing a client's timezone silently drifted their whole content calendar.**
`post_at_utc` was derived at write time and never re-derived. Added
`trg_client_timezone_repoint`. Found only because test 15 rendered UTC back into the client
timezone and compared to the original local date.

**11. Writes inside a test helper that always rolls back do not persist.**
The `as()` helper wraps each acting session in `begin … rollback`. Test 12's restore needed
`asCommit()`. If a test asserts a side effect, check which helper it used.

**12. `EXPLAIN` loop counts are not an N+1 signal by themselves.**
`Memoize`/`Materialize` inner nodes legitimately report high `Actual Loops`. The meaningful
assertion is that no node whose `Parent Relationship` is `InitPlan`/`SubPlan` has
`Actual Loops > 1`.

---

## 13. Invariants — do not break these

1. **No money columns.** `assert_no_money_columns()` must keep passing.
2. **RLS enabled and forced on every table; every table has at least one policy.**
3. **Every policy helper is `SECURITY DEFINER` with a pinned `search_path`.**
4. **Session-scoped helpers are wrapped in `(select ...)` inside policies.** Row-scoped ones
   are not.
5. **No policy names a table directly** — cross-table reach goes through a definer predicate.
6. **Edit rights are a subset of view rights**; approving is separate from editing.
7. **One write path** for record mutations (`useUpdateRecord`). No bypass.
8. **Migrations are additive and idempotent.**
9. **`database.types.ts` is generated**, never hand-edited.
10. **New business table ⇒ add it to `audited_tables`** and give it RLS policies and indexes.
11. **All timestamps are `timestamptz`.**
12. **Never expose the service-role key to the browser.**
13. **`can()` in the UI is not security.**

---

## 14. Extension recipes

### Add a field to an existing module
1. Migration: `alter table ... add column if not exists ...`.
2. `npm run db:types`.
3. Add a `FieldDef` to that module in `registry.ts`. That is the whole UI change — list
   column, detail field, create form, validation and export all follow.
4. If a policy references it, `npm run db:index-audit`.

### Add a module
1. Migration for the table (follow the column conventions in §6).
2. Insert into `audited_tables`.
3. Add RLS policies using the canonical shape; obey gotchas A–D.
4. Add indexes; run `npm run db:index-audit`.
5. Add a `ModuleDef` to `MODULES` and its key to `MODULE_ORDER`.
6. Add the module key to `public.modules` if it is a new permission surface, and seed
   `role_permissions` rows.

### Add a role
Insert into `roles`, then seed `role_permissions`. Tune in Settings → Roles & Permissions.
No deploy.

### Add an automation rule
Write it as a trigger or a function called by pg_cron — never as UI logic. Use
`begin_cascade()`/`end_cascade()` if it writes to other tables. Add an acceptance assertion.

---

## 15. Known limitations and deliberate non-goals

- **`.xlsx` export is SpreadsheetML**, not a zipped xlsx. Opens natively in Excel/Numbers/
  Sheets; avoids a zip dependency. Swap in `exceljs` if a true xlsx is required.
- **The call sheet returns print-styled HTML**, not a PDF. Browser Print → Save as PDF.
  Headless Chrome is the upgrade path.
- **Google Calendar sync assumes OAuth is already wired.** Refresh tokens are read from
  Supabase Vault; the consent flow is not built.
- **`fn_cascade_task_dates` stops at depth 50** and warns rather than running unbounded.
- **RPC argument types are `Record<string, unknown>`** in the generated types; the functions
  validate their own inputs.
- **Registry-driven queries are untyped** (see §11).
- **Realtime is not wired up.** TanStack Query invalidation covers same-session updates;
  cross-user live updates would need Supabase Realtime subscriptions.
- **Never built, by design:** anything in the money list at §1.

### What has NOT been executed

Everything requiring a hosted Supabase: Edge Function execution, pg_cron firing, Auth
sign-in end-to-end, PITR, and the nightly backup round-trip. `tests/rls/client-sdk.mjs`
re-runs the visibility assertions through `@supabase/supabase-js` with real sessions once a
project exists. Run it before calling a deployment done.

---

## 16. The 17 acceptance tests

Seeded with 3 managers, 11 non-manager staff (2 team leads, 7 executors, 1 intern, 1 freelancer) and 6 clients across sibling branches, plus 2 client-portal users. All run as
non-superuser roles through the real JWT path.

| # | Assertion |
|---|---|
| 1 | Founder sees 100% of records in every module |
| 2 | Manager A cannot see any client, task, shoot or post belonging solely to Manager B's branch — via UI and direct API |
| 3 | Manager A sees every record of every user in their subtree, at all depths |
| 4 | An editor sees exactly their tasks, brief and brand kit — and no client list |
| 5 | An intern cannot reach the client master record by any route |
| 6 | A client user sees zero internal fields; a raw request with their token returns no other client's rows |
| 7 | Creating a client with a service scope auto-generates project, cycle, deliverables, tasks and approvals |
| 8 | Client data appears identically in 6+ modules and exists in exactly one row |
| 9 | Changing a shoot date cascades every dependent date correctly, and each shift is logged |
| 10 | List-view and detail-page edits share one validation and permission path |
| 11 | Every create/update/delete produces an activity_log row with correct actor, old and new values |
| 12 | A deleted record is recoverable from the Recycle Bin with all relations intact |
| 13 | Overlapping equipment bookings are rejected at the database level |
| 14 | Assigning to someone on approved leave warns and suggests a reassignment |
| 15 | Every date filter preset returns the correct set across timezones |
| 16 | Zero N+1 on list views; every RLS column indexed; under 300 ms at 50k rows |
| 17 | A redeploy and a schema migration both leave existing data untouched |
| 18 | (extra) The no-money hard rule is enforced by the database |
| 19 | (extra) Reverse scheduling and status rollups |
| 20 | (extra) Reporting-tree integrity — cycle rejection, no orphan paths |

Measured at 50k tasks: manager 47 ms, editor 88 ms, founder 4 ms; 26 hoisted helper
subqueries, all `loops = 1`.

---

## 17. Command reference

```bash
npm test                 # db:check + db:index-audit + test:acceptance
npm run db:check         # migrations apply to a clean DB; reports RLS coverage
npm run db:seed          # seed + inspect the onboarding cascade
npm run db:index-audit   # policy columns without index cover (must be 0)
npm run db:types         # regenerate database.types.ts
npm run test:acceptance  # 130 assertions
npm run typecheck
npm run build
npm run dev
npm run functions:check  # deno check on the Edge Functions

node scripts/plan-inspect.mjs   # EXPLAIN tree for the list query, for perf work

# Live project only:
node tests/rls/client-sdk.mjs --create-auth-users
SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/rls/client-sdk.mjs
```

---

## 18. Seeded fixture (what the tests assume)

```
Founder (Ira)
└── Co-Founder (Cyrus)
    ├── Client Servicing Head (Sana)
    │   ├── Manager A ──── Aurora, Basil, Cobalt
    │   │   ├── Edit Lead A
    │   │   │   ├── Editor A1
    │   │   │   └── Editor A2
    │   │   ├── Designer A3
    │   │   └── Intern A4
    │   └── Manager B ──── Dune, Ember
    │       ├── Content Lead B
    │       │   ├── Editor B1
    │       │   └── Social Exec B2
    │       └── Freelancer B3
    └── Production Head (Prakash)
        └── Manager C ──── Fable
            ├── DOP C1
            └── Camera Asst C2
```

Manager A and Manager B are **siblings** — neither may see the other's records. That is the
central assertion of the whole system. Portal users exist for Aurora and Dune.

UUIDs are fixed so tests can address rows by name: users `00000000-0000-4000-8000-…`, auth
ids `10000000-…`, clients `20000000-…`, equipment `30000000-…`, shoots `40000000-…`, leads
`50000000-…`.

Inserting the 7 `client_service_scope` rows alone produces 6 projects, 6 cycles, 20
deliverables, 140 tasks, 120 dependencies, 24 approval chain steps and 6 kickoff meetings —
with no further input. That is the onboarding cascade, and it is the single best demonstration
of the "nobody types the same thing twice" principle.
