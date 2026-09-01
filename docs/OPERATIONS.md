# Operations runbook

## Deploying a schema change

Migrations are **additive only**. Never drop or retype a column in a later migration; add a
new one and backfill. Every migration must be safe to re-run — a redeploy replays them all,
and acceptance test 17 enforces that this changes no data.

```bash
# 1. Prove it on a throwaway database first
npm run db:check

# 2. Prove the visibility model still holds
npm run test:acceptance

# 3. Staging
supabase link --project-ref <staging-ref>
supabase db push

# 4. Verify on staging, then production
supabase link --project-ref <production-ref>
supabase db push

# 5. Regenerate types and redeploy the app
npm run db:types && npm run build
```

An application redeploy must never touch data. It carries no migration step of its own.

## Adding a role

Roles are data. Adding one is an `INSERT` into `roles` plus a row per module in
`role_permissions` — no code change, no deploy.

```sql
insert into public.roles (name, code, level, is_manager, default_scope, department_id)
values ('Motion Designer', 'MOTION_DESIGNER', 5, false, 'OWN',
        (select id from public.departments where code = 'CREATIVE'));

-- Seed its matrix rows, then tune them in Settings → Roles & Permissions.
insert into public.role_permissions (role_id, module, can_view, can_edit, scope)
select r.id, m.key, m.key in ('tasks','deliverables','assets'),
       m.key in ('tasks','assets'), 'OWN'
from public.roles r cross join public.modules m
where r.code = 'MOTION_DESIGNER'
on conflict (role_id, module) do nothing;
```

## Adding a module to the UI

1. Add the table in a new migration, with `client_id`, `deleted_at`, `deleted_by`,
   `created_by` and `updated_at`.
2. Register it in `public.audited_tables` so it gets the audit trigger and delete guard.
3. Add its RLS policies, following the union shape in `0014_rls_policies.sql`. Wrap every
   session-scoped helper in `(select ...)`, and every cross-table reach in a
   `SECURITY DEFINER` predicate.
4. Add an entry to `MODULES` in `src/modules/registry.ts`.
5. Run `npm run db:index-audit` — it fails if any policy column lacks index support.

No new page component is required.

## Backups and recovery

- **Point-in-Time Recovery** — enable in the Supabase dashboard (Database → Backups). This is
  the primary protection against infrastructure loss.
- **Nightly logical dump** — the `nightly-backup` Edge Function writes NDJSON plus a manifest
  to a separate private bucket, with 30-day retention. This is the protection against a bad
  migration or a mass edit, because a dump can be read and diffed.

Restoring a single record does not need either: use the Founder Recycle Bin
(`/settings/recycle-bin`). Soft delete never removed the row, so relations survive.

Restoring from the nightly dump replays in the order given by `backup_table_order()`, which
is derived from the live foreign-key graph so parents land before children.

## Monitoring the automation

```sql
-- Did the cycle generator run on the 25th?
select * from cron.job_run_details order by start_time desc limit 20;

-- Cycles created for next month
select p.name, rc.cycle_month, rc.generated_by, rc.generated_at
from public.retainer_cycles rc join public.projects p on p.id = rc.project_id
where rc.cycle_month = date_trunc('month', current_date + interval '1 month')
order by rc.generated_at desc;

-- Escalations raised today
select n.type, count(*) from public.notifications n
where n.created_at::date = current_date group by 1;

-- Digests queued but never delivered (mail provider misconfigured?)
select count(*) from public.notifications
where type = 'daily_digest' and sent_at is null and created_at > now() - interval '2 days';
```

## Diagnosing "I can't see something I should"

Work down this list; it is ordered by how often each is the cause.

```sql
-- 1. What does the database think this person's access is?
select public.my_context();   -- run as them, not as postgres

-- 2. Is the record inside their tree or their client set?
select * from public.my_visible_user_ids();
select * from public.my_client_ids();

-- 3. Does the role matrix grant the module at all?
select m.key, rp.scope, rp.can_view, rp.can_edit, rp.can_approve
from public.role_permissions rp
join public.modules m on m.key = rp.module
join public.roles r on r.id = rp.role_id
where r.code = 'ACCOUNT_MANAGER' order by m.sort_order;

-- 4. Is there a personal override overriding the role?
select * from public.user_permission_overrides where user_id = '<id>';

-- 5. Is the record soft-deleted? Only Founders see those.
select id, deleted_at, deleted_by from public.<table> where id = '<id>';
```

Remember that the SQL editor runs as a superuser and **bypasses RLS entirely**. A query that
returns rows there proves nothing about what a user can see. Reproduce with their session, or
in psql:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '<their auth_id>', 'role', 'authenticated')::text, true);
select count(*) from public.tasks;   -- what they would actually get
rollback;
```

## Performance

If a list view slows down, check in this order:

1. `npm run db:index-audit` — a new policy may reference an unindexed column.
2. `EXPLAIN (ANALYZE, FORMAT JSON)` the list query as the affected role and look for any
   `InitPlan`/`SubPlan` with `Actual Loops > 1`. That means a helper lost its `(select ...)`
   wrapper and is running per row — the difference between 47 ms and 35 s at 50k rows.
3. Check `pg_stat_statements` for the query, and confirm the 50k-row test in
   `tests/rls/acceptance-part2.mjs` still passes.

## Before calling a deployment done

The database suite runs anywhere. These need the live project:

```bash
# Real user sessions through PostgREST, the gateway and the JWT verifier
node tests/rls/client-sdk.mjs --create-auth-users
SUPABASE_URL=... SUPABASE_ANON_KEY=... node tests/rls/client-sdk.mjs
```

Then confirm by hand:

- The Auth access-token hook is registered — sign in as a client user and check the JWT
  carries `"role": "client_portal"`. Without it they fall back to `authenticated` and lose
  column-level isolation.
- `pg_cron` and `pg_net` are enabled, and `app.settings.functions_url` /
  `app.settings.service_role_key` are set.
- A digest actually arrives (needs `RESEND_API_KEY` and `DIGEST_FROM`).
- The nightly backup produced an object in the bucket.
- PITR is switched on.
