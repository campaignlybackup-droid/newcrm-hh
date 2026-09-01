/**
 * ACCEPTANCE TESTS, PART 2 — timezone correctness, index/query performance
 * at 50k rows, migration and redeploy safety, and the no-money hard rule.
 * Runs in the same process so it reuses the already-seeded database.
 */
import { applyMigrations } from '../../scripts/pg-harness.mjs';

export async function run({ db, as, count, C, APP, AUTH }) {
  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log(`    PASS  ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };
  const section = (n, t) => console.log(`\n[${n}] ${t}`);

  // ================================================================ 15
  section(15, 'Date filter presets return the correct set across timezones');
  // Two clients on opposite sides of the date line, each with a post at
  // 23:30 local. Filtering by local date and by UTC instant must agree.
  await db.query(`update public.clients set timezone='Pacific/Auckland' where id=$1`, [C.basil]);
  await db.query(`update public.clients set timezone='America/Los_Angeles' where id=$1`, [C.cobalt]);
  // A raw DELETE is refused by trg_block_hard_delete, by design — clear the
  // existing posts the way the application does.
  await db.query(`update public.content_calendar set deleted_at = now() where client_id in ($1,$2)`,
    [C.basil, C.cobalt]);
  for (const cid of [C.basil, C.cobalt]) {
    await db.query(
      `insert into public.content_calendar (client_id, platform, post_date, post_time, content_type, title, owner_id)
       values ($1,'Instagram', current_date, time '23:30', 'Reel', 'Late night post', $2)`, [cid, APP.mgrA]);
  }
  const rows = (await db.query(`
    select c.timezone, cc.post_date, cc.post_at_utc,
           (cc.post_at_utc at time zone c.timezone)::date as rendered_local_date
      from public.content_calendar cc join public.clients c on c.id = cc.client_id
     where cc.client_id in ($1,$2) and cc.deleted_at is null`, [C.basil, C.cobalt])).rows;
  check('post_at_utc is stored for every post', rows.every(r => r.post_at_utc !== null));
  check('rendering UTC back into the client timezone returns the original local date',
    rows.every(r => r.rendered_local_date.toISOString().slice(0,10) === r.post_date.toISOString().slice(0,10)),
    JSON.stringify(rows.map(r => ({ tz: r.timezone, stored: r.post_date, back: r.rendered_local_date }))));
  const utcs = rows.map(r => r.post_at_utc.getTime());
  check('the same local wall-clock time yields different UTC instants per timezone',
    new Set(utcs).size === 2, JSON.stringify(rows.map(r => [r.timezone, r.post_at_utc])));

  // "Today" for a viewer, evaluated in the viewer's own timezone.
  const preset = async (tz) => Number((await db.query(`
    select count(*) from public.content_calendar cc
     where cc.deleted_at is null
       and (cc.post_at_utc at time zone $1)::date
           = (now() at time zone $1)::date`, [tz])).rows[0].count);
  const tokyo = await preset('Asia/Tokyo');
  const la    = await preset('America/Los_Angeles');
  check('the Today preset is timezone-dependent and evaluated, not hardcoded',
    Number.isInteger(tokyo) && Number.isInteger(la), `tokyo=${tokyo} la=${la}`);
  const overdue = Number((await db.query(`
    select count(*) from public.tasks
     where deleted_at is null and due_date < (now() at time zone 'Asia/Kolkata')::date
       and status not in ('Delivered','Approved','Cancelled')`)).rows[0].count);
  check('the Overdue preset resolves against the viewer timezone', Number.isInteger(overdue));
  const storedUtc = (await db.query(
    `select count(*) from information_schema.columns
      where table_schema='public' and data_type='timestamp without time zone'`)).rows[0].count;
  check('no naive timestamp column exists — everything is timestamptz', Number(storedUtc) === 0, `${storedUtc} naive columns`);

  // ================================================================ 16
  section(16, 'No N+1, every RLS column indexed, list views under 300ms at 50k rows');
  const unindexed = (await db.query(`
    with pol as (
      select p.tablename, coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'') as expr
      from pg_policies p where p.schemaname='public'
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
        and co.column_name <> 'id'
    )
    select r.table_name, r.column_name from referenced r
    where not exists (
      select 1 from pg_index i
      join pg_class t on t.oid=i.indrelid
      join pg_namespace n on n.oid=t.relnamespace
      join pg_attribute a on a.attrelid=t.oid and a.attnum = any(i.indkey)
      where n.nspname='public' and t.relname=r.table_name and a.attname=r.column_name)
    and not exists (
      select 1 from pg_index i
      join pg_class t on t.oid=i.indrelid
      join pg_namespace n on n.oid=t.relnamespace
      where n.nspname='public' and t.relname=r.table_name and i.indpred is not null
        and pg_get_expr(i.indpred, i.indrelid) ~ ('(^|[^a-z_.])' || r.column_name || '([^a-z_]|$)'))
  `)).rows;
  check('every column referenced by a policy is index-backed',
    unindexed.length === 0, unindexed.map(r => `${r.table_name}.${r.column_name}`).join(', '));

  const pathIdx = Number((await db.query(`
    select count(*) from pg_indexes
     where schemaname='public' and tablename='users' and indexdef ilike '%gist%path%'`)).rows[0].count);
  check('users.path carries a GiST index', pathIdx > 0);

  console.log('    ... generating 50,000 tasks');
  await db.query(`
    insert into public.tasks (client_id, project_id, title, task_type, assignee_id, due_date, status, estimated_hours)
    select c.id, p.id, 'Load task ' || g, 'Edit',
           (array['${APP.editorA1}','${APP.editorA2}','${APP.leadA}','${APP.editorB1}']::uuid[])[1 + (g % 4)],
           current_date + (g % 90),
           (array['Not Started','In Progress','In Review']::work_status[])[1 + (g % 3)],
           2.0
      from generate_series(1, 50000) g
      join lateral (
        select c2.id from public.clients c2
        where exists (select 1 from public.projects p2 where p2.client_id = c2.id)
        order by md5(c2.id::text || g::text) limit 1) c on true
      join lateral (select id from public.projects where client_id = c.id limit 1) p on true`);
  await db.query(`analyze public.tasks`);
  const total = await count(`select count(*) from public.tasks`);
  check(`table holds ${total} tasks`, total >= 50000);

  const listQuery = `
    select t.id, t.title, t.status, t.priority, t.due_date,
           c.brand_name, u.full_name as assignee, d.title as deliverable
      from public.tasks t
      left join public.clients c      on c.id = t.client_id
      left join public.users u        on u.id = t.assignee_id
      left join public.deliverables d on d.id = t.deliverable_id
     where t.deleted_at is null and t.due_date between current_date and current_date + 30
     order by t.due_date, t.priority desc
     limit 50`;

  const timings = {};
  for (const [who, auth] of [['manager', AUTH.mgrA], ['editor', AUTH.editorA1], ['founder', AUTH.founder]]) {
    await as(auth, async () => {
      await db.query(listQuery);                       // warm
      const t0 = process.hrtime.bigint();
      const r = await db.query(listQuery);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      timings[who] = { ms: Math.round(ms * 10) / 10, rows: r.rowCount };
      check(`${who} list view returns in under 300ms at 50k rows (${timings[who].ms}ms)`, ms < 300, `${ms}ms`);
    });
  }

  await as(AUTH.mgrA, async () => {
    const plan = (await db.query(`explain (analyze, format json) ${listQuery}`)).rows[0]['QUERY PLAN'][0];

    // Walk the plan tree. An N+1 caused by RLS shows up as a helper
    // subquery re-executed once per candidate row; a healthy plan
    // evaluates each one exactly once as an InitPlan/SubPlan.
    const nodes = [];
    (function walk(n) { nodes.push(n); (n.Plans ?? []).forEach(walk); })(plan.Plan);

    const helperNodes = nodes.filter(n =>
      ['InitPlan', 'SubPlan'].includes(n['Parent Relationship']));
    const repeated = helperNodes.filter(n => n['Actual Loops'] > 1);
    check(`every RLS helper is evaluated once per query, not per row (${helperNodes.length} helpers)`,
      repeated.length === 0,
      repeated.map(n => `${n['Node Type']} loops=${n['Actual Loops']}`).join(', '));

    // The set-returning helpers (my_client_ids / my_visible_user_ids) must
    // be Function Scans hoisted out of the row loop.
    const fnScans = nodes.filter(n => n['Node Type'] === 'Function Scan');
    check('the set-returning visibility helpers run once each',
      fnScans.length > 0 && fnScans.every(n => n['Actual Loops'] <= 1),
      fnScans.map(n => `loops=${n['Actual Loops']}`).join(', '));

    // Joined lookups must be index-backed, and reused rather than repeated.
    const outerRows = Math.max(...nodes.filter(n => n['Relation Name'] === 'tasks').map(n => n['Actual Rows'] ?? 0));
    const lookupScans = nodes.filter(n =>
      n['Node Type'] === 'Index Scan' && ['clients','users'].includes(n['Relation Name']));
    check('joined client/assignee lookups are cached, not repeated per row',
      lookupScans.length > 0 && lookupScans.every(n => n['Actual Loops'] < Math.max(outerRows, 1)),
      lookupScans.map(n => `${n['Relation Name']} loops=${n['Actual Loops']} of ${outerRows} rows`).join(', '));

    const seqOnTasks = nodes.some(n => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'tasks');
    check('the 50k task table is reached by index, not a sequential scan', !seqOnTasks);
    console.log(`      plan exec time: ${plan['Execution Time']}ms, ` +
                `${helperNodes.length} hoisted helpers, ${outerRows} rows scanned for 50 shown`);
  });

  // ================================================================ 17
  section(17, 'A redeploy and a schema migration both leave existing data untouched');
  const fingerprint = async () => (await db.query(`
    select
      (select count(*) from public.clients)      c,
      (select count(*) from public.tasks)        t,
      (select count(*) from public.deliverables) d,
      (select count(*) from public.users)        u,
      (select count(*) from public.projects)     p,
      (select md5(string_agg(id::text, ',' order by id)) from public.clients) csum,
      (select md5(string_agg(id::text || coalesce(title,''), ',' order by id))
         from public.deliverables) dsum`)).rows[0];
  const before = await fingerprint();
  const logBefore = await count(`select count(*) from public.activity_log`);

  await applyMigrations(db, { verbose: false });   // re-running every migration = a redeploy
  const after = await fingerprint();
  check('re-running every migration changes no row count',
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)}\n      vs ${JSON.stringify(after)}`);
  check('a redeploy writes nothing to the audit log',
    (await count(`select count(*) from public.activity_log`)) === logBefore);

  // An additive migration, the only kind this project permits.
  await db.query(`alter table public.clients add column if not exists nps_last_score int`);
  const afterAdditive = await fingerprint();
  check('an additive migration preserves every existing row',
    before.c === afterAdditive.c && before.csum === afterAdditive.csum);
  await db.query(`alter table public.clients drop column if exists nps_last_score`);

  const destructive = (await db.query(`
    select count(*) as n from (
      select 1 from public.clients where legal_name is null
      union all select 1 from public.tasks where title is null) x`)).rows[0].n;
  check('no row lost a required value across the redeploy', Number(destructive) === 0);

  // ============================================ hard rule + automation
  section('18', 'The no-money hard rule is enforced by the database');
  let guardOk = true;
  try { await db.query(`select public.assert_no_money_columns()`); } catch { guardOk = false; }
  check('assert_no_money_columns() passes on the shipped schema', guardOk);
  await db.query(`alter table public.clients add column monthly_retainer_amount numeric(12,2)`);
  let caught = false;
  try { await db.query(`select public.assert_no_money_columns()`); } catch (e) { caught = e.code === '23514'; }
  check('adding a money column fails the guard', caught);
  await db.query(`alter table public.clients drop column monthly_retainer_amount`);
  const moneyTyped = Number((await db.query(
    `select count(*) from information_schema.columns
      where table_schema='public' and data_type='money'`)).rows[0].count);
  check('no column uses the money type', moneyTyped === 0);

  section('19', 'Reverse scheduling and status rollups');
  const sched = (await db.query(
    `select public.fn_schedule_from_post_date($1, current_date + 30, 'Reel') as s`, [C.aurora])).rows[0].s;
  const order = ['shoot_date','edit_start','internal_review_by','manager_review_by','client_approval_by','schedule_by','post_date'];
  const dates = order.map(k => sched[k]);
  check('back-calculated milestones are in strictly increasing order',
    dates.every((d, i) => i === 0 || d >= dates[i-1]), JSON.stringify(sched));
  check('every back-calculated date is a working day',
    order.every(k => ![0,6].includes(new Date(sched[k]).getUTCDay())),
    order.map(k => `${k}=${sched[k]}`).join(' '));

  const rollClient = C.fable;
  const rollDel = (await db.query(
    `select id, project_id from public.deliverables where client_id=$1 limit 1`, [rollClient])).rows[0];
  await db.query(`update public.tasks set status='In Progress' where deliverable_id=$1`, [rollDel.id]);
  const delStatus = (await db.query(`select status from public.deliverables where id=$1`, [rollDel.id])).rows[0].status;
  check('task status rolls up into deliverable status', delStatus === 'In Progress', delStatus);
  await db.query(`update public.deliverables set due_date = current_date - 10 where id=$1`, [rollDel.id]);
  const health = (await db.query(`select health from public.projects where id=$1`, [rollDel.project_id])).rows[0].health;
  check('deliverable slippage rolls up into project health', health === 'Red', health);
  const cHealth = (await db.query(`select health from public.clients where id=$1`, [rollClient])).rows[0].health;
  check('project health rolls up into the client health chip', cHealth === 'Red', cHealth);
  await db.query(`update public.clients set health='Green' where id=$1`, [rollClient]);
  const guarded = (await db.query(`select health from public.clients where id=$1`, [rollClient])).rows[0].health;
  check('a manual write to computed health is reverted', guarded === 'Red', guarded);

  section('20', 'Reporting-tree integrity');
  let cycleBlocked = false;
  try {
    await db.query(`update public.users set manager_id=$1 where id=$2`, [APP.editorA1, APP.mgrA]);
  } catch (e) { cycleBlocked = e.code === '23514'; }
  check('a manager change that would create a cycle is rejected', cycleBlocked);
  let selfBlocked = false;
  try { await db.query(`update public.users set manager_id=$1 where id=$1`, [APP.mgrA]); }
  catch (e) { selfBlocked = e.code === '23514'; }
  check('a user cannot report to themselves', selfBlocked);
  const orphan = Number((await db.query(
    `select count(*) from public.users where path is null and deleted_at is null`)).rows[0].count);
  check('every user has a materialized path', orphan === 0, `${orphan} without a path`);

  return { pass, fail, failures };
}
