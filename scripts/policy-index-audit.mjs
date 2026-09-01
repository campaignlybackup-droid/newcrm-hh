// Extracts the columns each RLS policy actually references and reports any
// that lack an index. This is the precise form of "index every column
// referenced in a policy".
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres } from './pg-harness.mjs';

const ctx = await startPostgres();
try {
  await installSupabaseCompatRoles(ctx.admin);
  await applyMigrations(ctx.admin, { verbose: false });
  const { rows } = await ctx.admin.query(`
    with pol as (
      select p.schemaname, p.tablename,
             coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'') as expr
      from pg_policies p where p.schemaname = 'public'
    ),
    cols as (
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
      where c.table_schema='public'
    ),
    referenced as (
      select distinct co.table_name, co.column_name
      from pol p join cols co on co.table_name = p.tablename
      where p.expr ~ ('(^|[^a-z_.])' || co.column_name || '([^a-z_]|$)')
        and co.column_name not in ('id')
    )
    select r.table_name, r.column_name
    from referenced r
    where not exists (
      -- Covered if the column is a key column of ANY index...
      select 1 from pg_index i
      join pg_class t on t.oid=i.indrelid
      join pg_namespace n on n.oid=t.relnamespace
      join pg_attribute a on a.attrelid=t.oid and a.attnum = any(i.indkey)
      where n.nspname='public' and t.relname=r.table_name and a.attname=r.column_name
    )
    and not exists (
      -- ...or the column appears in a PARTIAL index predicate. A partial
      -- index WHERE deleted_at IS NULL serves a deleted_at IS NULL test better
      -- than an index on deleted_at itself would.
      select 1 from pg_index i
      join pg_class t on t.oid=i.indrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public' and t.relname=r.table_name
        and i.indpred is not null
        and pg_get_expr(i.indpred, i.indrelid) ~ ('(^|[^a-z_.])' || r.column_name || '([^a-z_]|$)')
    )
    order by r.table_name, r.column_name`);
  console.log(JSON.stringify(rows.map(r => `${r.table_name}.${r.column_name}`), null, 0));
  console.log('missing:', rows.length);
} finally { await stopPostgres(ctx); }
