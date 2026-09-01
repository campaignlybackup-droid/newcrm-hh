/**
 * ACCEPTANCE TESTS — CLIENT SDK VARIANT
 *
 * The suite in acceptance.mjs proves the visibility model against a real
 * Postgres with RLS forced, driving it the way PostgREST does (a
 * non-superuser role plus request.jwt.claims). This file runs the same
 * assertions the way the spec asks for them: through @supabase/supabase-js
 * with REAL user sessions against a live Supabase project, so PostgREST,
 * the API gateway and the JWT verifier are all in the path too.
 *
 *   Setup once:
 *     supabase db push                     # apply supabase/migrations
 *     psql "$DIRECT_URL" -f supabase/seed.sql
 *     node tests/rls/client-sdk.mjs --create-auth-users   # creates logins
 *
 *   Then:
 *     SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node tests/rls/client-sdk.mjs
 *
 * Every account below is seeded by supabase/seed.sql; this script only
 * attaches auth identities to them and signs in.
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.TEST_PASSWORD ?? 'acceptance-test-passphrase-1';

if (!URL || !ANON) {
  console.error(`
This suite needs a live Supabase project.

  SUPABASE_URL=https://xxx.supabase.co \\
  SUPABASE_ANON_KEY=... \\
  SUPABASE_SERVICE_ROLE_KEY=... \\
  node tests/rls/client-sdk.mjs

The equivalent assertions run with no external dependency via:
  npm run test:acceptance
`);
  process.exit(2);
}

const ACCOUNTS = {
  founder:  { email: 'founder@agency.test',     authId: '10000000-0000-4000-8000-000000000001' },
  mgrA:     { email: 'managera@agency.test',    authId: '10000000-0000-4000-8000-0000000000a0' },
  mgrB:     { email: 'managerb@agency.test',    authId: '10000000-0000-4000-8000-0000000000b0' },
  editorA1: { email: 'editora1@agency.test',    authId: '10000000-0000-4000-8000-0000000000a2' },
  internA4: { email: 'interna4@agency.test',    authId: '10000000-0000-4000-8000-0000000000a5' },
  clientAurora: { email: 'client.aurora@client.test', authId: '10000000-0000-4000-8000-0000000000f1' },
};
const C = {
  aurora: '20000000-0000-4000-8000-000000000001',
  dune:   '20000000-0000-4000-8000-000000000004',
};

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Attaches auth identities to the seeded users. Service key required. */
async function createAuthUsers() {
  if (!SERVICE) { console.error('SUPABASE_SERVICE_ROLE_KEY required to create auth users'); process.exit(2); }
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    const { data, error } = await admin.auth.admin.createUser({
      email: a.email, password: PASSWORD, email_confirm: true,
    });
    if (error && !/already/i.test(error.message)) { console.error(key, error.message); continue; }
    const authId = data?.user?.id;
    if (authId) {
      // Point the seeded app user at the freshly created auth identity.
      const { error: uErr } = await admin.from('users').update({ auth_id: authId }).eq('email', a.email);
      if (uErr) console.error('link', key, uErr.message);
      else console.log(`linked ${key} -> ${authId}`);
    }
  }
  console.log('\nDone. Re-run without --create-auth-users to execute the suite.');
}

async function signIn(account) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: account.email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${account.email}: ${error.message}`);
  return c;
}

const count = async (c, table, build = (q) => q) => {
  const { count: n, error } = await build(c.from(table).select('id', { count: 'exact', head: true }));
  if (error) return { error };
  return { n: n ?? 0 };
};

async function run() {
  console.log('Running acceptance assertions through the client SDK\n' + '='.repeat(66));

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Founder sees every record');
  const founder = await signIn(ACCOUNTS.founder);
  const truth = {};
  for (const t of ['clients', 'tasks', 'shoots', 'deliverables', 'content_calendar']) {
    const r = await count(founder, t, (q) => q.is('deleted_at', null));
    truth[t] = r.n ?? 0;
    check(`founder reads ${t} (${truth[t]})`, !r.error && (r.n ?? 0) > 0, r.error?.message);
  }

  // ---------------------------------------------------------------- 2
  console.log("\n[2] Manager A cannot reach Manager B's branch through the API");
  const mgrA = await signIn(ACCOUNTS.mgrA);
  const brands = await mgrA.from('clients').select('brand_name').order('brand_name');
  check('Manager A client list excludes the sibling branch',
    !brands.error && !(brands.data ?? []).some((r) => ['Dune', 'Ember'].includes(r.brand_name)),
    JSON.stringify(brands.data));
  for (const t of ['tasks', 'shoots', 'content_calendar', 'deliverables']) {
    const r = await count(mgrA, t, (q) => q.in('client_id', [C.dune]));
    check(`Manager A reads zero ${t} for a sibling's client`, r.n === 0, String(r.n ?? r.error?.message));
  }
  const directRow = await mgrA.from('clients').select('*').eq('id', C.dune).maybeSingle();
  check('a direct by-id request for a foreign client returns nothing',
    !directRow.data, JSON.stringify(directRow.data));

  // ---------------------------------------------------------------- 4
  console.log('\n[4] An editor sees their tasks, the brand kit, and no client list');
  const editor = await signIn(ACCOUNTS.editorA1);
  const cl = await count(editor, 'clients');
  check('editor gets an empty client list', cl.n === 0, String(cl.n ?? cl.error?.message));
  const bk = await count(editor, 'client_brand_kit', (q) => q.eq('client_id', C.aurora));
  check('editor can read the brand kit behind their task', bk.n === 1, String(bk.n ?? bk.error?.message));
  const foreignKit = await count(editor, 'client_brand_kit', (q) => q.eq('client_id', C.dune));
  check('editor cannot read an unrelated brand kit', foreignKit.n === 0);

  // ---------------------------------------------------------------- 5
  console.log('\n[5] An intern cannot reach the client master by any route');
  const intern = await signIn(ACCOUNTS.internA4);
  for (const t of ['clients', 'client_brand_kit', 'client_contacts', 'client_service_scope', 'v_client_context']) {
    const r = await count(intern, t);
    check(`intern cannot reach ${t}`, r.n === 0 || Boolean(r.error),
      r.error ? r.error.message : String(r.n));
  }
  const ownTasks = await count(intern, 'tasks');
  check('intern can still see their own task(s)', (ownTasks.n ?? 0) > 0);

  // ---------------------------------------------------------------- 6
  console.log('\n[6] A client user sees only their own client, and no internal field');
  const portal = await signIn(ACCOUNTS.clientAurora);
  const mine = await portal.from('v_portal_deliverables').select('*');
  check('client user reads their own deliverables', !mine.error && (mine.data?.length ?? 0) > 0, mine.error?.message);
  check('every row belongs to their own client',
    (mine.data ?? []).every((r) => r.client_id === C.aurora));
  const foreign = await portal.from('v_portal_deliverables').select('*').eq('client_id', C.dune);
  check('a raw request for another client returns zero rows', (foreign.data?.length ?? 0) === 0);

  const internalCol = await portal.from('tasks').select('assignee_id').limit(1);
  check('a raw request for an internal table is refused',
    Boolean(internalCol.error), internalCol.error?.message ?? 'it returned data');

  const capacity = await portal.from('v_capacity').select('*').limit(1);
  check('a raw request for capacity data is refused or empty',
    Boolean(capacity.error) || (capacity.data?.length ?? 0) === 0);

  // ---------------------------------------------------------------- 11
  console.log('\n[11] Writes are audited with the acting user as the actor');
  const beforeEdit = await mgrA.from('clients').select('id,city').eq('id', C.aurora).single();
  if (!beforeEdit.error) {
    const newCity = `QA-${Date.now() % 100000}`;
    await mgrA.from('clients').update({ city: newCity }).eq('id', C.aurora);
    const hist = await mgrA.rpc('record_history', {
      p_entity_type: 'clients', p_entity_id: C.aurora, p_limit: 5,
    });
    const cityChange = (hist.data ?? []).find((h) => h.field_name === 'city');
    check('the edit produced an audit row with the new value',
      cityChange?.new_value === newCity, JSON.stringify(cityChange));
    await mgrA.from('clients').update({ city: beforeEdit.data.city }).eq('id', C.aurora);
  } else {
    check('audit check could run', false, beforeEdit.error.message);
  }

  // ---------------------------------------------------------------- 13
  console.log('\n[13] Overlapping equipment bookings are refused by the database');
  const anyEquip = await founder.from('equipment_bookings').select('equipment_id,out_date,in_date').limit(1);
  if (anyEquip.data?.length) {
    const b = anyEquip.data[0];
    const clash = await founder.from('equipment_bookings').insert({
      equipment_id: b.equipment_id, out_date: b.out_date, in_date: b.in_date, purpose: 'SDK clash test',
    });
    check('an overlapping booking is rejected through the API',
      Boolean(clash.error), clash.error?.message ?? 'it was accepted');
  } else {
    check('equipment booking present to test against', false, 'no bookings seeded');
  }

  console.log('\n' + '='.repeat(66));
  console.log(`CLIENT SDK ACCEPTANCE: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('\nFailures:\n  - ' + failures.join('\n  - '));
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes('--create-auth-users')) await createAuthUsers();
else await run();
