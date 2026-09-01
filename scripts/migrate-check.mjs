// Applies every migration to a throwaway database. This is the "does the
// schema actually build" gate; CI runs it before the RLS suite.
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres } from './pg-harness.mjs';

const ctx = await startPostgres();
try {
  console.log('Installing Supabase-compatible roles...');
  await installSupabaseCompatRoles(ctx.admin);
  console.log('Applying migrations:');
  await applyMigrations(ctx.admin);
  const { rows } = await ctx.admin.query(`
    select
      (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
      (select count(*) from pg_policies where schemaname='public') as policies,
      (select count(*) from information_schema.views where table_schema='public') as views,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') as functions,
      (select count(*) from pg_indexes where schemaname='public') as indexes
  `);
  console.log('\nSchema built:', rows[0]);
  const noRls = await ctx.admin.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
  `);
  console.log('Tables without RLS:', noRls.rows.length === 0 ? 'none' : noRls.rows.map(r=>r.relname));
  const noPolicy = await ctx.admin.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
  `);
  console.log('Tables with RLS but NO policy (unreachable, deny-by-default):',
    noPolicy.rows.length === 0 ? 'none' : noPolicy.rows.map(r=>r.relname).join(', '));
  console.log('\nMIGRATIONS OK');
} finally {
  await stopPostgres(ctx);
}
