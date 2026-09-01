# Agency Operations CRM

Clients, projects, deliverables, tasks, shoots, content calendars, approvals and people —
all interlinked, all date-driven.

**There is no money module.** No invoices, budgets, pricing, payroll, salaries, expenses,
revenue or currency fields exist anywhere. Where a feature would normally need money, it is
modelled with dates and status instead. This is enforced by the database, not by convention:
`assert_no_money_columns()` fails CI if anyone ever adds a price, budget, salary or currency
column (see `supabase/migrations/0013_audit_and_safety.sql`).

---

## Status

| Area | State |
|---|---|
| Schema, RLS, audit, automation (Phases 0, 3, 7) | Built and verified — 22 migrations apply cleanly |
| Acceptance test suite | **130 assertions, 0 failures** against a real Postgres with RLS forced |
| Next.js app: view engine, modules, dashboards, portal, admin (Phases 1–6, 8, 9 UI) | Built, typechecks clean, production build passes |
| Edge Functions (digest, backup, call sheet, Google sync) | Written; not executed — needs a deployed Supabase project |
| Client-SDK acceptance suite | Written; needs a live project (`tests/rls/client-sdk.mjs`) |

What has **not** been run: anything requiring a hosted Supabase — Edge Functions, pg_cron
schedules, Auth sign-in, PITR and the nightly backup. See [Verification](#verification).

---

## Quick start

```bash
npm install
```

### Run the database test suite with no external dependencies

The test harness downloads and boots a private PostgreSQL 18 instance, applies every
migration, seeds a realistic agency, and runs the acceptance suite. No Docker, no local
Postgres, no Supabase project.

```bash
npm test
```

That runs, in order:

```bash
npm run db:check        # apply all 22 migrations to a throwaway database
npm run db:index-audit  # prove every RLS-referenced column is index-backed
npm run test:acceptance # the 17 acceptance tests from the specification
```

### Run the app

```bash
cp .env.example .env.local   # fill in your Supabase project values
npm run dev
```

### Deploy the database

```bash
supabase db push                              # applies supabase/migrations in order
psql "$DIRECT_URL" -f supabase/seed.sql       # optional sample agency
supabase functions deploy daily-digest nightly-backup call-sheet google-calendar-sync
npm run db:types                              # regenerate src/lib/database.types.ts
```

Enable `pg_cron` and `pg_net` in the Supabase dashboard, then set:

```sql
alter database postgres set app.settings.functions_url = 'https://<ref>.functions.supabase.co';
alter database postgres set app.settings.service_role_key = '<service-role-key>';
```

Register `public.custom_access_token_hook` as the Auth access-token hook. This is what
stamps `role = client_portal` for external users — without it, client portal accounts fall
back to the `authenticated` role and lose their column-level isolation.

---

## The visibility model

Access is two-dimensional: **vertical** (the reporting tree) + **horizontal** (assignment).
A user's visible set is the union of:

| Scope | Meaning |
|---|---|
| `OWN` | records where they are creator, assignee, reviewer, owner or a listed participant |
| `SUBTREE` | everything belonging to anyone beneath them in `users.path` (recursive, unlimited depth) |
| `TEAM` | records for clients/projects they are assigned to |
| `ALL` | levels 0–1 only |

Enforced entirely by Postgres Row Level Security. Every table has RLS **enabled and forced**;
no table is reachable without an explicit policy. The application layer contains no
permission checks that matter — `can()` in `src/lib/session.ts` decides which buttons to
render, nothing more.

Key properties, each covered by a test:

- Founder and Co-Founder see every record, always — a short-circuit in `auth_scope()` so a
  mis-edit in the permission matrix cannot lock everyone out.
- A manager sees their own clients and their reports' work, and **nothing** from a sibling
  manager's branch.
- An executor sees only what is assigned to them — plus the brand kit and brief behind those
  tasks, and no client list.
- Interns and freelancers get the task and its attachments only. No client master record by
  any route.
- Client users are switched into a separate `client_portal` database role that holds no
  privilege on internal tables or columns, so a raw API call cannot read an assignee name.
- Edit rights are always a subset of view rights. Approving is a separate permission from
  editing.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how this is implemented and why.

---

## Repository layout

```
supabase/
  migrations/     22 additive migrations — schema, RLS, automation, cron, seed config
  seed.sql        sample agency: 20 people, 6 clients across 3 manager branches
  functions/      Edge Functions (Deno)
src/
  modules/        THE REGISTRY — every module is data, not a page component
  components/
    view-engine/  list / kanban / calendar / timeline + the shared field editor
    dashboards/   role-specific panels
  lib/            supabase clients, session, filters, the single mutation surface
  app/            routes (one dynamic route serves all 15 modules)
scripts/          test harness, type generation, index audit
tests/rls/        the acceptance suite
docs/             architecture, operations runbook
```

---

## Verification

Everything in this table was executed on this machine and passed.

| Check | Command | Result |
|---|---|---|
| 22 migrations apply to a clean database | `npm run db:check` | 64 tables, 151 policies, 14 views, 292 indexes |
| Every table has RLS and at least one policy | `npm run db:check` | no table without either |
| Every RLS-referenced column is index-backed | `npm run db:index-audit` | 0 missing |
| 17 acceptance tests | `npm run test:acceptance` | **130 assertions, 0 failures** |
| List view at 50k rows | acceptance test 16 | 47 ms (manager), 88 ms (editor), 4 ms (founder) |
| No N+1 from RLS | acceptance test 16 | 26 helper subqueries, all `loops=1` |
| TypeScript | `npm run typecheck` | clean |
| Production build | `npm run build` | 16 routes + middleware |
| App renders, auth gate active | browser | login renders; protected routes redirect |

**Not verified here**, because it needs a hosted Supabase project: Edge Function execution,
pg_cron firing, Auth sign-in end-to-end, Point-in-Time Recovery, and the nightly backup
round-trip. `tests/rls/client-sdk.mjs` re-runs the visibility assertions through
`@supabase/supabase-js` with real user sessions once you have a project — run that before
calling the deployment done.
