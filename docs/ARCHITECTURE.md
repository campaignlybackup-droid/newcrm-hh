# Architecture

Why the system is shaped the way it is. Ordered by how load-bearing each decision is.

---

## 1. Authorization lives in Postgres, not in the application

Every table has `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, and no table
is reachable without an explicit policy. The Next.js app holds only the anon key; the
service-role key never reaches the browser and is used solely by Edge Functions.

This means there is no privileged read path to get wrong. A server component, a client
component, a raw `curl` against PostgREST and a bulk import all get the same rows, because
the filter is in the database.

### The recursion problem, and why helpers are `SECURITY DEFINER`

A policy on `tasks` that reads `users` would re-enter `users`' own policy, which reads
`role_permissions`, and so on. Postgres detects this and raises *infinite recursion detected
in policy*. Every helper in `0012_authz_helpers.sql` is therefore `SECURITY DEFINER`: it
reads with the definer's rights, so the other table's policy is never re-entered.

This bit twice during development, and both cases are now tests:

- `shoots` and `shoot_crew` each referenced the other. Fixed with `can_see_shoot()` and
  `shoot_has_crew_in_my_subtree()`.
- `deliverables` inlined a subquery on `tasks`, and `users` inlined one on
  `client_team_members`. Those are now `i_have_a_task_on_deliverable()` and
  `shares_client_pod_with()`.

The second case is subtler and worth stating plainly: **a policy expression is
permission-checked when the statement is planned, not when a branch is reached.** A policy
naming a table the acting role has no grant on fails outright — even for a role whose branch
of the `OR` never touches it. That is what made client-portal users unable to read their own
deliverables until the subquery was wrapped.

### Performance: the `(select ...)` wrapper

Postgres constant-folds only `IMMUTABLE` functions. A `STABLE` `auth_scope('tasks')` sitting
bare in a policy is re-evaluated **for every candidate row**. At 50k rows that was measured
at **35 seconds** for a manager's task list.

Wrapping each session-scoped helper in a scalar subquery — `(select public.auth_scope('tasks'))`
— makes the planner hoist it into an `InitPlan` evaluated once per statement. Same query,
same data: **47 ms**. All 217 such call sites in `0014_rls_policies.sql` use the wrapped form.

Acceptance test 16 asserts this structurally rather than by timing alone: it walks the
`EXPLAIN (ANALYZE, FORMAT JSON)` tree and fails if any `InitPlan`/`SubPlan` node has
`Actual Loops > 1`.

`auth_ctx()` additionally memoises the whole permission picture in a transaction-local GUC,
so repeat calls within a statement are a GUC read rather than a fresh query.

### The reporting tree

`users.path` is an `ltree` maintained exclusively by trigger. Ancestor tests are a single
indexed `<@` containment check at any depth — no recursive CTE per row. Changing a manager
rewrites the subtree, and a change that would create a cycle is rejected with `23514`.

### The client portal is a separate database role

Internal staff and client users are both `authenticated` in stock Supabase, which makes
column-level grants useless. `custom_access_token_hook` stamps `role = client_portal` for
external users, so PostgREST switches into a role that has **no privilege at all** on
internal tables, plus explicit column grants on the handful it may read.

That is what makes "a raw API request with their token returns no internal fields" true at
the wire level rather than by hiding columns in the UI. The acceptance suite asserts the
privilege error (`42501`), not an empty result.

---

## 2. One registry drives every module

`src/modules/registry.ts` describes each module as data: fields, types, options, which are
editable, which are inherited, which view modes apply, which date columns are filterable.

From that single description the app derives:

- list columns and their inline editors
- the detail page's sections and fields
- the create form
- the Zod validation schema (`moduleSchema` / `modulePatchSchema`)
- the filter bar, including the date-field picker
- CSV/XLSX export columns

There is **one route** (`src/app/(app)/[module]/page.tsx`) and **one** detail route for all
15 modules. Adding a module is a registry entry, not a screen.

### Why this satisfies the "list edit == detail edit" requirement

The specification requires that every field editable in the list view is editable on the
detail page, with identical validation and identical permission enforcement. Rather than
maintain that as a rule people must remember, it is structural:

- Both surfaces render the same `FieldEditor` component.
- Both compute editability with the same two inputs: `isEditable(field)` and
  `can(session, module, action)`.
- Both commit through the same `useUpdateRecord` mutation, which validates with the same
  derived schema before sending.
- The database then applies the same policy and the same `CHECK` constraints to both.

There is no second, looser write path in the codebase.

---

## 3. A client is typed once

`clients` is the master record. Every other module stores `client_id` and *renders* the
client's data through `v_client_context`; nothing keeps a copy a user must retype.

`deliverables.client_id`, `tasks.client_id` and similar are **read-only mirrors** written by
inheritance triggers, not user input. They exist so RLS can filter on one indexed local
column instead of walking three joins per row. Attempting to edit one through the UI is
refused with an explanation pointing at the parent.

Acceptance test 8 renames a client and asserts the new name appears identically in 8 modules
while existing in exactly one row, and that no other base table holds a `brand_name` or
`legal_name` column.

---

## 4. Automation is database-level

Every rule in the specification's section 5 is a trigger or a scheduled function, never UI
convenience — so an import, an API call and the UI all behave the same.

| Rule | Implementation |
|---|---|
| Onboarding cascade | `fn_client_onboarding_cascade()`, fired by a trigger on `client_service_scope` |
| Recurring cycles | `fn_generate_next_cycles()` on pg_cron, 25th monthly |
| Auto-assignment | `fn_pick_assignee()` — fixed / round-robin / least-loaded / by-skill, skipping approved leave |
| Dependency date engine | `fn_cascade_task_dates()` — working-day aware, honours `lag_days` |
| Reverse scheduling | `fn_schedule_from_post_date()` — back-calculates from go-live |
| Status rollups | task → deliverable → project health → client health, with a guard that reverts manual writes |
| Approval routing | `fn_request_approval()` reads `approval_chains`; no hardcoded sequence |
| Escalation | `fn_escalate_overdue()` — assignee, then manager, then department head |
| Renewal alerts | `fn_renewal_alerts()` at 60/30/15/7 days |
| Minutes → tasks | trigger on `action_items` |
| Daily digest | `fn_daily_digest()` + hourly cron picking users for whom it is locally 09:00 |
| Equipment conflicts | GiST exclusion constraint — rejected at the constraint level, not by a check-then-insert race |
| Duplicate guard | `fn_check_duplicate_client()` via pg_trgm — warns, never blocks |

### Timezones

Timestamps are `timestamptz` throughout; there is not a single naive `timestamp` column
(asserted by test 15). `content_calendar.post_at_utc` is the canonical instant, derived from
the client-local `post_date`/`post_time` by trigger. Changing a client's timezone re-derives
that instant for every unpublished post — a bug the timezone test caught, since without it a
client moving timezones silently drifts their whole calendar.

---

## 5. Audit and data safety

A single generic trigger on every business table writes to `activity_log`: **one row per
changed field**, with actor, old value, new value, IP and user agent. Automated changes are
recorded with `actor_id = null, is_system = true`. The log is append-only — an
`UPDATE`/`DELETE` trigger refuses, so it cannot be rewritten from the application.

Soft delete everywhere. A raw `DELETE` is **blocked by trigger**; the only physical delete
path is `hard_delete()`, which is Founder-only and requires a typed confirmation string.
Because soft delete never removed the row, restoring is non-destructive: every foreign key
still resolves, which is why test 12 can assert a restored client comes back with its
projects, deliverables and tasks intact.

Migrations are additive and idempotent. Test 17 re-runs the entire migration set against a
seeded database and asserts every row count and content checksum is unchanged, and that a
redeploy writes nothing to the audit log.

---

## 6. Deliberate limitations

- **`.xlsx` export is SpreadsheetML**, not a real zipped xlsx. It opens natively in Excel,
  Numbers and Sheets, and avoids a zip dependency. If a true xlsx is needed, add `exceljs`
  and swap `toXlsxXml`.
- **The call sheet returns HTML**, printed to PDF by the browser. A headless-Chrome PDF
  service is the upgrade path; the HTML is already print-styled with `@page` rules.
- **Google Calendar sync assumes OAuth is already wired.** Refresh tokens are read from
  Supabase Vault via `vault_read_google_refresh_token()`; the consent flow itself is not
  built.
- **`fn_cascade_task_dates` stops at depth 50** and warns, rather than running unbounded.
- **The `Functions` block in the generated types uses `Args: Record<string, unknown>`**
  rather than per-function argument types. RPC arguments are therefore not individually
  typechecked; the functions themselves validate their inputs.
- **Registry-driven queries use an explicitly untyped Supabase handle**
  (`supabaseDynamic()`), because the table name and select string are runtime data and
  PostgREST's compile-time select parser cannot resolve them. Validation is not lost, only
  relocated: those writes are checked by the derived Zod schema before sending and by RLS
  and `CHECK` constraints on arrival.
