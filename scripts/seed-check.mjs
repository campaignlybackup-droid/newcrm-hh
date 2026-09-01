import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres, ROOT } from './pg-harness.mjs';

const ctx = await startPostgres();
try {
  await installSupabaseCompatRoles(ctx.admin);
  await applyMigrations(ctx.admin, { verbose: false });
  console.log('migrations ok');
  const seed = readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  const res = await ctx.admin.query(seed);
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  console.log('SEED:', last.rows?.[0] ?? last);

  for (const q of [
    ['users by path depth', `select full_name, nlevel(path) as depth, path::text from public.users order by path limit 25`],
    ['cascade output', `select c.brand_name, count(distinct p.id) projects, count(distinct rc.id) cycles,
                          count(distinct d.id) deliverables, count(distinct t.id) tasks,
                          count(distinct m.id) meetings
                        from public.clients c
                        left join public.projects p on p.client_id=c.id
                        left join public.retainer_cycles rc on rc.client_id=c.id
                        left join public.deliverables d on d.client_id=c.id
                        left join public.tasks t on t.client_id=c.id
                        left join public.meetings m on m.client_id=c.id
                        group by c.brand_name order by c.brand_name`],
    ['task dependencies', `select count(*) as deps from public.task_dependencies`],
    ['approval chains', `select count(*) as chains from public.approval_chains`],
    ['audit rows', `select action, count(*) from public.activity_log group by action order by 2 desc`],
  ]) {
    const r = await ctx.admin.query(q[1]);
    console.log(`\n--- ${q[0]} ---`);
    console.table(r.rows);
  }
} catch (e) {
  console.error('SEED FAILED:', e.message);
  if (e.detail) console.error('detail:', e.detail);
  if (e.where) console.error('where:', e.where);
  process.exitCode = 1;
} finally {
  await stopPostgres(ctx);
}
