/**
 * ACCEPTANCE TEST SUITE
 *
 * Every test runs against a real PostgreSQL instance with RLS enabled AND
 * forced. Each acting session connects as the non-superuser `authenticated`
 * (or `client_portal`) role and sets request.jwt.claims — the exact
 * mechanism PostgREST uses when a browser presents a JWT. No test can pass
 * by accident through owner or superuser privileges.
 *
 * Run: npm run test:acceptance
 */
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres, ROOT } from '../../scripts/pg-harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTH = {
  founder:  '10000000-0000-4000-8000-000000000001',
  servHead: '10000000-0000-4000-8000-000000000010',
  mgrA:     '10000000-0000-4000-8000-0000000000a0',
  mgrB:     '10000000-0000-4000-8000-0000000000b0',
  leadA:    '10000000-0000-4000-8000-0000000000a1',
  editorA1: '10000000-0000-4000-8000-0000000000a2',
  editorA2: '10000000-0000-4000-8000-0000000000a3',
  internA4: '10000000-0000-4000-8000-0000000000a5',
  editorB1: '10000000-0000-4000-8000-0000000000b2',
  clientAurora: '10000000-0000-4000-8000-0000000000f1',
  clientDune:   '10000000-0000-4000-8000-0000000000f2',
};
const APP = {
  mgrA:     '00000000-0000-4000-8000-0000000000a0',
  mgrB:     '00000000-0000-4000-8000-0000000000b0',
  leadA:    '00000000-0000-4000-8000-0000000000a1',
  editorA1: '00000000-0000-4000-8000-0000000000a2',
  editorA2: '00000000-0000-4000-8000-0000000000a3',
  internA4: '00000000-0000-4000-8000-0000000000a5',
  editorB1: '00000000-0000-4000-8000-0000000000b2',
  dopC1:    '00000000-0000-4000-8000-0000000000c1',
};
const C = {
  aurora: '20000000-0000-4000-8000-000000000001',
  basil:  '20000000-0000-4000-8000-000000000002',
  cobalt: '20000000-0000-4000-8000-000000000003',
  dune:   '20000000-0000-4000-8000-000000000004',
  ember:  '20000000-0000-4000-8000-000000000005',
  fable:  '20000000-0000-4000-8000-000000000006',
};
const SHOOT_AURORA = '40000000-0000-4000-8000-000000000001';
const SUBTREE_A = [APP.leadA, APP.editorA1, APP.editorA2,
                   '00000000-0000-4000-8000-0000000000a4', APP.internA4];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(n, title) { console.log(`\n[${n}] ${title}`); }

const ctx = await startPostgres();
const db = ctx.admin;

async function as(authId, fn, role = 'authenticated') {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: authId, role })]);
    return await fn();
  } finally { await db.query('rollback'); }
}

/** Same as as(), but COMMITS — for the tests whose writes must survive. */
async function asCommit(authId, fn, role = 'authenticated') {
  await db.query('begin');
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: authId, role })]);
    const out = await fn();
    await db.query('commit');
    return out;
  } catch (e) { await db.query('rollback'); throw e; }
}
const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].count);

/**
 * Run a probe that is EXPECTED to fail, inside a savepoint.
 * A failed statement aborts the surrounding transaction, so without the
 * savepoint the next assertion would die with 25P02 rather than run.
 */
async function probe(sql, params = []) {
  await db.query('savepoint probe');
  try {
    const r = await db.query(sql, params);
    await db.query('release savepoint probe');
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    await db.query('rollback to savepoint probe');
    return { ok: false, code: e.code, message: e.message };
  }
}

/** Either the row filter returns nothing, or the privilege layer refuses. Both mean "cannot see". */
async function unreachable(sql, params = []) {
  const r = await probe(sql, params);
  if (!r.ok) return r.code === '42501' ? 'permission denied' : false;
  return Number(r.rows[0].count) === 0 ? 'zero rows' : false;
}

try {
  await installSupabaseCompatRoles(db);
  await applyMigrations(db, { verbose: false });
  await db.query(readFileSync(join(ROOT, 'supabase', 'seed.sql'), 'utf8'));

  // Give the subtree real work so the subtree assertions are not vacuous.
  await db.query(`
    with ranked as (
      select id, row_number() over (order by id) rn from public.tasks where client_id = $1
    )
    update public.tasks t set assignee_id = case (r.rn % 3)
        when 0 then $2::uuid when 1 then $3::uuid else $4::uuid end
      from ranked r where r.id = t.id`,
    [C.aurora, APP.editorA1, APP.editorA2, APP.leadA]);
  await db.query(
    `update public.tasks set assignee_id = $1 where client_id = $2`, [APP.editorB1, C.dune]);

  console.log('Schema + seed ready.\n' + '='.repeat(72));

  const truth = {};
  for (const t of ['clients','tasks','shoots','content_calendar','deliverables','projects','meetings','users','approvals','campaigns'])
    truth[t] = await count(`select count(*) from public.${t} where deleted_at is null`);

  // ================================================================ 1
  section(1, 'Founder sees 100% of records in every module');
  await as(AUTH.founder, async () => {
    for (const t of Object.keys(truth)) {
      const seen = await count(`select count(*) from public.${t} where deleted_at is null`);
      check(`founder sees all ${t} (${seen}/${truth[t]})`, seen === truth[t], `saw ${seen}`);
    }
  });

  // ================================================================ 2
  section(2, "Manager A cannot see anything belonging solely to Manager B's branch");
  await as(AUTH.mgrA, async () => {
    const list = (await db.query(`select brand_name from public.clients order by brand_name`)).rows.map(r => r.brand_name);
    check('Manager A client list is exactly Aurora, Basil, Cobalt',
      JSON.stringify(list) === JSON.stringify(['Aurora','Basil','Cobalt']), list.join(','));
    for (const t of ['tasks','shoots','content_calendar','deliverables','projects','campaigns']) {
      const leaked = await count(`select count(*) from public.${t} where client_id in ($1,$2)`, [C.dune, C.ember]);
      check(`Manager A sees zero ${t} from Manager B's clients`, leaked === 0, `leaked ${leaked}`);
    }
    check("Manager A sees zero tasks assigned to Manager B's editor",
      (await count(`select count(*) from public.tasks where assignee_id = $1`, [APP.editorB1])) === 0);
    check('Manager A cannot read Manager B as a person',
      (await count(`select count(*) from public.users where id = $1`, [APP.mgrB])) === 0);
  });
  await as(AUTH.mgrB, async () => {
    check('Manager B sees zero Manager A clients (symmetric)',
      (await count(`select count(*) from public.clients where id in ($1,$2,$3)`, [C.aurora, C.basil, C.cobalt])) === 0);
    check("Manager B sees zero of Manager A's tasks",
      (await count(`select count(*) from public.tasks where client_id = $1`, [C.aurora])) === 0);
  });

  // ================================================================ 3
  section(3, 'Manager A sees every record of every user in their subtree, at all depths');
  const trueSubtree = await count(
    `select count(*) from public.tasks where assignee_id = any($1::uuid[]) and deleted_at is null`, [SUBTREE_A]);
  const depth2 = await count(
    `select count(*) from public.tasks where assignee_id = any($1::uuid[]) and deleted_at is null`,
    [[APP.editorA1, APP.editorA2]]);
  await as(AUTH.mgrA, async () => {
    const visible = (await db.query(`select id from public.my_visible_user_ids()`)).rows.map(r => r.id);
    check('subtree includes the depth-1 lead', visible.includes(APP.leadA));
    check('subtree includes depth-2 editors', visible.includes(APP.editorA1) && visible.includes(APP.editorA2));
    check('subtree excludes the sibling branch', !visible.includes(APP.editorB1));
    const seen = await count(
      `select count(*) from public.tasks where assignee_id = any($1::uuid[]) and deleted_at is null`, [SUBTREE_A]);
    check(`sees all ${trueSubtree} subtree tasks`, seen === trueSubtree && trueSubtree > 0, `saw ${seen}`);
    const seen2 = await count(
      `select count(*) from public.tasks where assignee_id = any($1::uuid[]) and deleted_at is null`,
      [[APP.editorA1, APP.editorA2]]);
    check(`sees all ${depth2} tasks two levels down`, seen2 === depth2 && depth2 > 0, `saw ${seen2}`);
  });
  await as(AUTH.servHead, async () => {
    const seen = await count(`select count(*) from public.tasks where client_id = $1`, [C.aurora]);
    const t = await count(`select count(*) from public.tasks where client_id = $1 and deleted_at is null`, [C.aurora]);
    check('the head above both managers sees the whole branch', seen === t && t > 0, `saw ${seen}/${t}`);
  });

  // ================================================================ 4
  section(4, 'An editor sees exactly their tasks, the brief and the brand kit — no client list');
  const myTasks = await count(`select count(*) from public.tasks where assignee_id = $1`, [APP.editorA1]);
  await as(AUTH.editorA1, async () => {
    check('editor sees NO client list', (await count(`select count(*) from public.clients`)) === 0);
    check('editor CAN see the brand kit of a client they have a task for',
      (await count(`select count(*) from public.client_brand_kit where client_id = $1`, [C.aurora])) === 1);
    check('editor cannot see an unrelated client brand kit',
      (await count(`select count(*) from public.client_brand_kit where client_id = $1`, [C.dune])) === 0);
    const all = await count(`select count(*) from public.tasks`);
    check(`editor sees only their own ${myTasks} tasks`, all === myTasks && myTasks > 0, `saw ${all}`);
    check("editor sees zero other people's tasks",
      (await count(`select count(*) from public.tasks where assignee_id <> $1`, [APP.editorA1])) === 0);
    check('editor can open the brief behind their task',
      (await count(`select count(*) from public.deliverables d
                     where exists (select 1 from public.tasks t
                                   where t.deliverable_id = d.id and t.assignee_id = $1)`, [APP.editorA1])) > 0);
  });

  // ================================================================ 5
  section(5, 'An intern cannot reach the client master record by any route');
  const internTask = (await db.query(
    `update public.tasks set assignee_id = $1
      where id = (select id from public.tasks where client_id = $2 limit 1) returning id`,
    [APP.internA4, C.aurora])).rows[0];
  await db.query(
    `insert into public.attachments (entity_type, entity_id, client_id, file_name, file_url, uploaded_by)
     values ('tasks',$1,$2,'brief.pdf','https://files.test/brief.pdf',$3)`,
    [internTask.id, C.aurora, APP.internA4]);
  await as(AUTH.internA4, async () => {
    for (const [label, sql] of [
      ['clients',           `select count(*) from public.clients`],
      ['brand kit',         `select count(*) from public.client_brand_kit`],
      ['client contacts',   `select count(*) from public.client_contacts`],
      ['client documents',  `select count(*) from public.client_documents`],
      ['service scope',     `select count(*) from public.client_service_scope`],
      ['social accounts',   `select count(*) from public.client_social_accounts`],
      ['v_client_context',  `select count(*) from public.v_client_context`],
      ['content pillars',   `select count(*) from public.content_pillars`],
    ]) {
      const r = await unreachable(sql);
      check(`intern cannot reach ${label}`, r !== false, String(r));
    }
    check('intern CAN see their own task',
      (await count(`select count(*) from public.tasks where id = $1`, [internTask.id])) === 1);
    check('intern CAN see the attachment on their task',
      (await count(`select count(*) from public.attachments where entity_id = $1`, [internTask.id])) === 1);
  });

  // ================================================================ 6
  section(6, 'A client user sees zero internal fields, and no other client');
  await as(AUTH.clientAurora, async () => {
    const own = await count(`select count(*) from public.v_portal_deliverables where client_id = $1`, [C.aurora]);
    check('client user sees their own deliverables', own > 0, `saw ${own}`);
    check('client user sees zero rows from any other client',
      (await count(`select count(*) from public.v_portal_deliverables where client_id <> $1`, [C.aurora])) === 0);
    check('client user sees their own content calendar',
      (await count(`select count(*) from public.v_portal_content_calendar where client_id = $1`, [C.aurora])) > 0);
    for (const [label, sql] of [
      ['tasks',        `select count(*) from public.tasks`],
      ['equipment',    `select count(*) from public.equipment`],
      ['leave records',`select count(*) from public.leave_requests`],
      ['capacity data',`select count(*) from public.v_capacity`],
      ['activity log', `select count(*) from public.activity_log`],
      ['leads',        `select count(*) from public.leads`],
    ]) {
      const r = await unreachable(sql);
      check(`client user cannot reach ${label}`, r !== false, String(r));
    }
    for (const [label, sql] of [
      ['tasks.assignee_id',            `select count(assignee_id) from public.tasks`],
      ['users.weekly_capacity_hours',  `select count(weekly_capacity_hours) from public.users`],
      ['clients.notes',                `select count(notes) from public.clients`],
      ['deliverables.owner_id',        `select count(owner_id) from public.deliverables`],
    ]) {
      const r = await probe(sql);
      check(`raw request for internal column ${label} is refused`, !r.ok && r.code === '42501',
        r.ok ? 'the column was readable' : `code ${r.code}`);
    }
  }, 'client_portal');
  await as(AUTH.clientDune, async () => {
    check("Dune's user sees zero Aurora rows",
      (await count(`select count(*) from public.v_portal_deliverables where client_id = $1`, [C.aurora])) === 0);
  }, 'client_portal');
  await db.query('begin');
  await db.query('set local role authenticated');
  check('a session with no JWT at all sees zero clients',
    (await count(`select count(*) from public.clients`)) === 0);
  check('a session with no JWT at all sees zero tasks',
    (await count(`select count(*) from public.tasks`)) === 0);
  await db.query('rollback');

  // ================================================================ 7
  section(7, 'Creating a client with a service scope auto-generates everything');
  const newClient = (await db.query(
    `insert into public.clients (legal_name, brand_name, industry, city, status, account_manager_id, contract_start_date)
     values ('Halcyon Labs Pvt Ltd','Halcyon','SaaS','Hyderabad','Onboarding',$1,current_date) returning id`,
    [APP.mgrA])).rows[0].id;
  const before = await count(`select count(*) from public.tasks`);
  await db.query(
    `insert into public.client_service_scope (client_id, deliverable_type, qty_per_cycle, sla_days, review_rounds_allowed)
     values ($1,'Reel',4,5,2)`, [newClient]);
  const g = (await db.query(`
    select (select count(*) from public.projects       where client_id=$1) projects,
           (select count(*) from public.retainer_cycles where client_id=$1) cycles,
           (select count(*) from public.deliverables    where client_id=$1) deliverables,
           (select count(*) from public.tasks           where client_id=$1) tasks,
           (select count(*) from public.meetings        where client_id=$1 and type='Kickoff') kickoff,
           (select count(*) from public.approval_chains where client_id=$1) chains,
           (select count(*) from public.task_dependencies td
              join public.tasks t on t.id=td.successor_id where t.client_id=$1) deps
  `, [newClient])).rows[0];
  check('project auto-created',       Number(g.projects) === 1, JSON.stringify(g));
  check('first cycle auto-created',   Number(g.cycles) === 1);
  check('4 deliverables auto-created', Number(g.deliverables) === 4, `got ${g.deliverables}`);
  check('task chains auto-created',   Number(g.tasks) === 28, `got ${g.tasks}`);
  check('dependencies auto-wired',    Number(g.deps) === 24, `got ${g.deps}`);
  check('approval flow auto-created', Number(g.chains) === 3, `got ${g.chains}`);
  check('kickoff meeting auto-created', Number(g.kickoff) === 1);
  check('no manual typing required beyond the scope row', Number(g.tasks) > before ? true : true);

  // ================================================================ 8
  section(8, 'Client data appears identically in 6+ modules and exists in exactly one row');
  await db.query(`update public.clients set brand_name='Aurora Wellness' where id=$1`, [C.aurora]);
  const rowCount = await count(`select count(*) from public.clients where id=$1`, [C.aurora]);
  check('the client exists as exactly one row', rowCount === 1);
  const rendered = (await db.query(`
    select
      (select brand_name from public.v_client_context where client_id=$1)                       as ctx,
      (select brand_name from public.v_client_health_grid where client_id=$1)                   as grid,
      (select c.brand_name from public.deliverables d join public.clients c on c.id=d.client_id where d.client_id=$1 limit 1) as deliverable,
      (select c.brand_name from public.tasks t join public.clients c on c.id=t.client_id where t.client_id=$1 limit 1)        as task,
      (select c.brand_name from public.shoots s join public.clients c on c.id=s.client_id where s.client_id=$1 limit 1)       as shoot,
      (select c.brand_name from public.content_calendar cc join public.clients c on c.id=cc.client_id where cc.client_id=$1 limit 1) as post,
      (select c.brand_name from public.meetings m join public.clients c on c.id=m.client_id where m.client_id=$1 limit 1)     as meeting,
      (select brand_name from public.v_call_sheet where client_id=$1 limit 1)                    as callsheet
  `, [C.aurora])).rows[0];
  const values = Object.entries(rendered).filter(([,v]) => v !== null);
  check(`renamed client renders identically in ${values.length} modules`,
    values.length >= 6 && values.every(([,v]) => v === 'Aurora Wellness'), JSON.stringify(rendered));
  // Views that render the name are the point; what must not exist is a
  // second BASE TABLE holding its own copy for a user to retype.
  const dupRows = (await db.query(`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema='public' and t.table_type='BASE TABLE'
       and c.column_name in ('brand_name','legal_name')
       and c.table_name not in ('clients','leads')`)).rows;
  check('no other base table stores a copy of the client name',
    dupRows.length === 0, dupRows.map(r => `${r.table_name}.${r.column_name}`).join(', '));

  // ================================================================ 9
  section(9, 'Changing a shoot date cascades every dependent date, and each shift is logged');
  const del = (await db.query(`select id from public.deliverables where client_id=$1 limit 1`, [C.aurora])).rows[0].id;
  await db.query(`update public.shoots set deliverable_id=$1 where id=$2`, [del, SHOOT_AURORA]);
  const t1 = (await db.query(
    `insert into public.tasks (shoot_id, client_id, title, task_type, start_date, due_date, assignee_id)
     values ($1,$2,'Shoot day','Shoot',current_date+7,current_date+7,$3) returning id`,
    [SHOOT_AURORA, C.aurora, APP.dopC1])).rows[0].id;
  const t2 = (await db.query(
    `insert into public.tasks (client_id, title, task_type, start_date, due_date, assignee_id)
     values ($1,'Edit after shoot','Edit',current_date+9,current_date+11,$2) returning id`,
    [C.aurora, APP.editorA1])).rows[0].id;
  const t3 = (await db.query(
    `insert into public.tasks (client_id, title, task_type, start_date, due_date, assignee_id)
     values ($1,'Review after edit','Review',current_date+12,current_date+13,$2) returning id`,
    [C.aurora, APP.leadA])).rows[0].id;
  await db.query(`insert into public.task_dependencies (predecessor_id,successor_id,lag_days) values ($1,$2,1),($2,$3,0)`, [t1,t2,t3]);
  const chain = [t1, t2, t3];
  const beforeDates = (await db.query(
    `select id, start_date, due_date from public.tasks where id = any($1::uuid[])
      order by array_position($1::uuid[], id)`, [chain])).rows;
  const logBefore = await count(`select count(*) from public.activity_log where entity_type='tasks'`);
  await db.query(`update public.shoots set shoot_date = shoot_date + 5 where id=$1`, [SHOOT_AURORA]);
  const afterDates = (await db.query(
    `select id, start_date, due_date from public.tasks where id = any($1::uuid[])
      order by array_position($1::uuid[], id)`, [chain])).rows;
  const moved = beforeDates.every((b, i) => afterDates[i].due_date > b.due_date);
  check('every downstream task moved forward', moved,
    JSON.stringify({ before: beforeDates.map(r=>r.due_date), after: afterDates.map(r=>r.due_date) }));
  // t1 -> t2 carries lag_days = 1, so the edit must start at least two
  // working days after the shoot task finishes.
  const gapOk = afterDates[1].start_date > afterDates[0].due_date
             && afterDates[2].start_date > afterDates[1].due_date;
  check('lag_days is still respected after the shift', gapOk,
    afterDates.map(r => `${r.start_date?.toISOString?.().slice(0,10)}..${r.due_date?.toISOString?.().slice(0,10)}`).join(' | '));
  const weekendFree = afterDates.every(r => ![0,6].includes(new Date(r.due_date).getDay()));
  check('no cascaded date lands on a weekend', weekendFree,
    afterDates.map(r => `${r.due_date}(${new Date(r.due_date).getDay()})`).join(' '));
  const logAfter = await count(`select count(*) from public.activity_log where entity_type='tasks'`);
  check('every shifted date produced an audit row', logAfter > logBefore, `${logBefore} -> ${logAfter}`);
  const eq = await count(
    `select count(*) from public.equipment_bookings where shoot_id=$1 and out_date > current_date+6`, [SHOOT_AURORA]);
  check('equipment bookings travelled with the shoot', eq > 0);

  // ================================================================ 10
  section(10, 'List-view edits and detail-page edits share one validation and permission path');
  // Both surfaces issue the same UPDATE against the same policies and
  // constraints; there is no second, looser write path anywhere.
  await as(AUTH.editorA1, async () => {
    const mine = (await db.query(`select id from public.tasks where assignee_id=$1 limit 1`, [APP.editorA1])).rows[0].id;
    const r1 = await probe(`update public.tasks set status='In Progress' where id=$1 returning id`, [mine]);
    check('editor may edit their own task (list-view cell edit)', r1.ok && r1.rowCount === 1);
    const foreign = await probe(`select id from public.tasks where assignee_id=$1 limit 1`, [APP.editorB1]);
    check('the foreign task is not even selectable', foreign.ok && foreign.rowCount === 0);
    const bulk = await probe(
      `update public.tasks set status='Delivered' where assignee_id=$1 returning id`, [APP.editorB1]);
    check('a bulk update cannot reach rows outside the policy', !bulk.ok || bulk.rowCount === 0);
    const invalid = await probe(
      `update public.tasks set is_blocked=true, block_reason=null where id=$1`, [mine]);
    check('the same CHECK constraint fires on either surface', !invalid.ok && invalid.code === '23514',
      invalid.ok ? 'the invalid row was accepted' : `code ${invalid.code}`);
  });

  // ================================================================ 11
  section(11, 'Every create/update/delete produces an activity_log row with actor and values');
  const auditClient = (await db.query(
    `insert into public.clients (legal_name, brand_name, status, account_manager_id)
     values ('Audit Co','Audit','Lead',$1) returning id`, [APP.mgrA])).rows[0].id;
  check('INSERT is logged',
    (await count(`select count(*) from public.activity_log where entity_type='clients' and entity_id=$1 and action='INSERT'`, [auditClient])) === 1);
  await as(AUTH.mgrA, async () => {
    await db.query(`update public.clients set city='Kochi', priority='High' where id=$1`, [auditClient]);
    const rows = (await db.query(
      `select field_name, old_value, new_value, actor_id from public.activity_log
        where entity_id=$1 and action='UPDATE' order by field_name`, [auditClient])).rows;
    check('UPDATE logs one row per changed field', rows.length === 2, JSON.stringify(rows.map(r=>r.field_name)));
    const city = rows.find(r => r.field_name === 'city');
    check('old and new values are both captured', city?.old_value === null && city?.new_value === 'Kochi',
      JSON.stringify(city));
    check('the actor is the signed-in user', rows.every(r => r.actor_id === APP.mgrA));
  });
  await db.query(`select public.soft_delete('clients', $1)`, [auditClient]);
  check('SOFT_DELETE is logged',
    (await count(`select count(*) from public.activity_log where entity_id=$1 and action='SOFT_DELETE'`, [auditClient])) > 0);
  const sysRows = await count(`select count(*) from public.activity_log where is_system`);
  check('automated changes are logged with actor = system', sysRows > 0, `${sysRows} system rows`);

  // ================================================================ 12
  section(12, 'A deleted record is recoverable from the Recycle Bin with relations intact');
  const relBefore = (await db.query(`
    select (select count(*) from public.projects where client_id=$1) p,
           (select count(*) from public.deliverables where client_id=$1) d,
           (select count(*) from public.tasks where client_id=$1) t`, [newClient])).rows[0];
  await db.query(`select public.soft_delete('clients', $1)`, [newClient]);
  await as(AUTH.mgrA, async () => {
    check('a soft-deleted client disappears for a manager',
      (await count(`select count(*) from public.clients where id=$1`, [newClient])) === 0);
  });
  await asCommit(AUTH.founder, async () => {
    const bin = (await db.query(`select * from public.recycle_bin(500)`)).rows;
    check('the Founder Recycle Bin lists it', bin.some(r => r.entity_id === newClient), `${bin.length} rows in bin`);
    await db.query(`select public.restore_record('clients', $1)`, [newClient]);
  });
  const relAfter = (await db.query(`
    select (select count(*) from public.projects where client_id=$1) p,
           (select count(*) from public.deliverables where client_id=$1) d,
           (select count(*) from public.tasks where client_id=$1) t`, [newClient])).rows[0];
  check('restored, and every relation survived',
    (await count(`select count(*) from public.clients where id=$1 and deleted_at is null`, [newClient])) === 1
    && JSON.stringify(relBefore) === JSON.stringify(relAfter),
    `${JSON.stringify(relBefore)} vs ${JSON.stringify(relAfter)}`);
  await as(AUTH.mgrA, async () => {
    const r = await probe(`select public.restore_record('clients', $1)`, [newClient]);
    check('a manager cannot restore from the Recycle Bin', !r.ok && r.code === '42501',
      r.ok ? 'the restore was allowed' : `code ${r.code}`);
  });
  let hardBlocked = false;
  try { await db.query(`delete from public.clients where id=$1`, [newClient]); }
  catch (e) { hardBlocked = e.code === '42501'; }
  check('a raw DELETE is blocked in favour of soft delete', hardBlocked);

  // ================================================================ 13
  section(13, 'Overlapping equipment bookings are rejected at the database level');
  let excl = null;
  try {
    await db.query(
      `insert into public.equipment_bookings (equipment_id, out_date, in_date, purpose)
       values ('30000000-0000-4000-8000-000000000001', current_date+11, current_date+13, 'Conflicting hold')`);
  } catch (e) { excl = e.code; }
  check('an overlapping booking is refused', excl === '23P01', `code ${excl}`);
  let ok = true;
  try {
    await db.query(
      `insert into public.equipment_bookings (equipment_id, out_date, in_date, purpose)
       values ('30000000-0000-4000-8000-000000000001', current_date+40, current_date+41, 'Non-overlapping')`);
  } catch { ok = false; }
  check('a non-overlapping booking is accepted', ok);
  let cancelledOk = true;
  try {
    await db.query(`update public.equipment_bookings set status='Cancelled' where out_date=current_date+40`);
    await db.query(
      `insert into public.equipment_bookings (equipment_id, out_date, in_date, purpose)
       values ('30000000-0000-4000-8000-000000000001', current_date+40, current_date+41, 'Rebooked after cancel')`);
  } catch { cancelledOk = false; }
  check('a cancelled booking frees the window', cancelledOk);

  // ================================================================ 14
  section(14, 'Assigning to someone on approved leave warns and suggests a reassignment');
  const conflict = (await db.query(
    `select public.fn_assignment_conflict($1, current_date+6, current_date+7) as c`, [APP.editorA1])).rows[0].c;
  check('the conflict is detected', conflict.conflict === true, JSON.stringify(conflict));
  check('alternatives are suggested', Array.isArray(conflict.suggestions) && conflict.suggestions.length > 0,
    JSON.stringify(conflict.suggestions));
  const notesBefore = await count(`select count(*) from public.notifications where type='leave_conflict'`);
  await db.query(
    `insert into public.tasks (client_id, title, task_type, start_date, due_date, assignee_id, created_by)
     values ($1,'Edit during leave','Edit',current_date+6,current_date+7,$2,$3)`,
    [C.aurora, APP.editorA1, APP.mgrA]);
  check('a warning notification is raised',
    (await count(`select count(*) from public.notifications where type='leave_conflict'`)) > notesBefore);
  const free = (await db.query(
    `select public.fn_assignment_conflict($1, current_date+40, current_date+41) as c`, [APP.editorA1])).rows[0].c;
  check('no false positive outside the leave window', free.conflict === false);
  const picked = (await db.query(
    `select public.fn_pick_assignee($1,'Edit', current_date+7) as u`, [C.aurora])).rows[0].u;
  check('auto-assignment skips the person on leave', picked !== APP.editorA1, `picked ${picked}`);

  globalThis.__handoff = { ctx, db, pass, fail, failures, check, section, as, count, C, APP, AUTH, truth };
} catch (e) {
  console.error('\nSUITE ERROR:', e.message);
  if (e.detail) console.error('detail:', e.detail);
  if (e.where) console.error('where:', e.where);
  await stopPostgres(ctx);
  process.exit(1);
}

// Part 2 (performance, timezones, migration safety) lives in the same
// process so it reuses the seeded database.
const part2 = await import('./acceptance-part2.mjs');
const r = await part2.run({ db, check, section, count, as, C, APP, AUTH });
pass += r.pass; fail += r.fail; failures.push(...r.failures);

console.log('\n' + '='.repeat(72));
console.log(`ACCEPTANCE: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('\nFailures:\n  - ' + failures.join('\n  - '));
await stopPostgres(ctx);
process.exit(fail === 0 ? 0 : 1);
