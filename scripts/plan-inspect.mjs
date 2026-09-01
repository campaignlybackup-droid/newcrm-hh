import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres, ROOT } from './pg-harness.mjs';
const ctx = await startPostgres(); const db = ctx.admin;
try {
  await installSupabaseCompatRoles(db);
  await applyMigrations(db, { verbose: false });
  await db.query(readFileSync(join(ROOT,'supabase','seed.sql'),'utf8'));
  await db.query(`
    insert into public.tasks (client_id, project_id, title, task_type, assignee_id, due_date, status, estimated_hours)
    select c.id, p.id, 'Load '||g, 'Edit', '00000000-0000-4000-8000-0000000000a2'::uuid,
           current_date + (g % 90), 'Not Started', 2.0
      from generate_series(1,50000) g
      join lateral (select c2.id from public.clients c2
                    where exists (select 1 from public.projects p2 where p2.client_id=c2.id)
                    order by md5(c2.id::text||g::text) limit 1) c on true
      join lateral (select id from public.projects where client_id=c.id limit 1) p on true`);
  await db.query('analyze');
  await db.query('begin');
  await db.query(`set local role authenticated`);
  await db.query(`select set_config('request.jwt.claims',$1,true)`,
    [JSON.stringify({ sub:'10000000-0000-4000-8000-0000000000a0', role:'authenticated' })]);
  const plan = (await db.query(`explain (analyze, verbose, format json)
    select t.id, t.title, t.status, t.priority, t.due_date, c.brand_name, u.full_name, d.title
      from public.tasks t
      left join public.clients c on c.id=t.client_id
      left join public.users u on u.id=t.assignee_id
      left join public.deliverables d on d.id=t.deliverable_id
     where t.deleted_at is null and t.due_date between current_date and current_date+30
     order by t.due_date, t.priority desc limit 50`)).rows[0]['QUERY PLAN'][0];
  const walk = (n, depth = 0) => {
    console.log(`${'  '.repeat(depth)}${n['Node Type']}${n['Relation Name']?' on '+n['Relation Name']:''}` +
      ` loops=${n['Actual Loops']} rows=${n['Actual Rows']}` +
      (n['Parent Relationship'] ? ` [${n['Parent Relationship']}]` : ''));
    (n.Plans ?? []).forEach(c => walk(c, depth+1));
  };
  walk(plan.Plan);
  console.log('Execution Time:', plan['Execution Time'], 'ms');
  await db.query('rollback');
} finally { await stopPostgres(ctx); }
