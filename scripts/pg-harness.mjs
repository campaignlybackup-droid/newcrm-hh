// Boots a throwaway PostgreSQL instance so the schema, the RLS policies
// and the acceptance tests can be executed for real on any machine — no
// Docker, no system Postgres, no Supabase project required.
import EmbeddedPostgres from 'embedded-postgres';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, '.pgdata');
const PORT = Number(process.env.CRM_TEST_PORT ?? 54999);

export async function startPostgres({ fresh = true } = {}) {
  if (fresh && existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });

  const instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase('crm');

  const admin = new pg.Client({
    host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'crm',
  });
  await admin.connect();
  return { instance, admin, port: PORT };
}

export function migrationFiles() {
  const dir = join(ROOT, 'supabase', 'migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => ({
    name: f,
    sql: readFileSync(join(dir, f), 'utf8'),
  }));
}

export async function applyMigrations(admin, { verbose = true } = {}) {
  for (const { name, sql } of migrationFiles()) {
    const t0 = Date.now();
    try {
      await admin.query(sql);
      if (verbose) console.log(`  ok   ${name}  (${Date.now() - t0}ms)`);
    } catch (err) {
      console.error(`\n  FAIL ${name}`);
      console.error(`  ${err.message}`);
      if (err.position) {
        const pos = Number(err.position);
        const upto = sql.slice(0, pos);
        const line = upto.split('\n').length;
        const ctx = sql.split('\n').slice(Math.max(0, line - 4), line + 2)
          .map((l, i) => `    ${Math.max(1, line - 3) + i}| ${l}`).join('\n');
        console.error(`  at line ${line}:\n${ctx}`);
      }
      if (err.detail) console.error(`  detail: ${err.detail}`);
      if (err.hint) console.error(`  hint: ${err.hint}`);
      throw err;
    }
  }
}

// Mirrors what Supabase/PostgREST provide, so the migrations exercise the
// same role names and the same JWT plumbing as production.
export async function installSupabaseCompatRoles(admin) {
  await admin.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then
        create role authenticator login password 'authenticator' noinherit;
      end if;
    end $$;
    grant anon, authenticated, service_role to authenticator;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public
      grant all on tables to authenticated, service_role;
  `);
}

export async function stopPostgres({ instance, admin }) {
  try { await admin?.end(); } catch {}
  try { await instance?.stop(); } catch {}
  rmSync(DATA_DIR, { recursive: true, force: true });
}
