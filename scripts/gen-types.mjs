/**
 * Generates src/lib/database.types.ts by introspecting the real schema.
 * Regenerate after every migration: `npm run db:types`.
 * Hand-editing the output is pointless — it is derived, not authored.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPostgres, applyMigrations, installSupabaseCompatRoles, stopPostgres, ROOT } from './pg-harness.mjs';

const PG_TO_TS = (t, udt) => {
  if (t === 'ARRAY') return `${PG_TO_TS('', udt.replace(/^_/, ''))}[]`;
  switch (udt) {
    case 'uuid': case 'text': case 'varchar': case 'citext': case 'date': case 'time':
    case 'timetz': case 'timestamp': case 'timestamptz': case 'inet': case 'ltree':
      return 'string';
    case 'int2': case 'int4': case 'int8': case 'numeric': case 'float4': case 'float8':
      return 'number';
    case 'bool': return 'boolean';
    case 'json': case 'jsonb': return 'Json';
    default: return null; // enum or unknown -> resolved below
  }
};

const ctx = await startPostgres();
try {
  await installSupabaseCompatRoles(ctx.admin);
  await applyMigrations(ctx.admin, { verbose: false });

  const enums = (await ctx.admin.query(`
    select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' group by t.typname order by t.typname`)).rows;
  const enumNames = new Set(enums.map(e => e.typname));

  const cols = (await ctx.admin.query(`
    select c.table_name, t.table_type, c.column_name, c.data_type, c.udt_name,
           c.is_nullable, c.column_default, c.ordinal_position
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
    order by c.table_name, c.ordinal_position`)).rows;

  // Every function PostgREST can expose: public schema, not a trigger
  // handler, not an internal helper. Names are DISTINCT — an overloaded
  // function must appear once, or the emitted type literal has a
  // duplicate key and the whole Database type collapses to never.
  const fns = (await ctx.admin.query(`
    select distinct on (p.proname) p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype <> 'trigger'::regtype
      and p.proname not like 'trg\\_%'
      and p.prokind = 'f'
    order by p.proname, p.oid`)).rows;

  // supabase-js requires a Relationships entry on every table and view;
  // without it the Database type fails the GenericSchema constraint and
  // every Insert/Update silently degrades to `never`.
  const rels = (await ctx.admin.query(`
    select con.conname as fk_name,
           src.relname as table_name,
           array_agg(sa.attname::text order by u.ord) as columns,
           tgt.relname as referenced_relation,
           array_agg(ta.attname::text order by u.ord) as referenced_columns,
           con.conkey
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    join lateral unnest(con.conkey) with ordinality as u(attnum, ord) on true
    join pg_attribute sa on sa.attrelid = con.conrelid and sa.attnum = u.attnum
    join lateral unnest(con.confkey) with ordinality as v(attnum, ord)
      on v.ord = u.ord
    join pg_attribute ta on ta.attrelid = con.confrelid and ta.attnum = v.attnum
    where con.contype = 'f' and n.nspname = 'public'
    group by con.conname, src.relname, tgt.relname, con.conkey
    order by src.relname, con.conname`)).rows;

  const relsByTable = new Map();
  for (const r of rels) {
    if (!relsByTable.has(r.table_name)) relsByTable.set(r.table_name, []);
    relsByTable.get(r.table_name).push(r);
  }

  const relationshipsFor = (name) => {
    const list = relsByTable.get(name) ?? [];
    if (!list.length) return '        Relationships: [];\n';
    let out = '        Relationships: [\n';
    for (const r of list) {
      out += `          { foreignKeyName: ${JSON.stringify(r.fk_name)}; ` +
             `columns: [${r.columns.map((c) => JSON.stringify(c)).join(', ')}]; ` +
             `isOneToOne: false; ` +
             `referencedRelation: ${JSON.stringify(r.referenced_relation)}; ` +
             `referencedColumns: [${r.referenced_columns.map((c) => JSON.stringify(c)).join(', ')}] },\n`;
    }
    out += '        ];\n';
    return out;
  };

  const byTable = new Map();
  for (const c of cols) {
    if (!byTable.has(c.table_name)) byTable.set(c.table_name, { type: c.table_type, cols: [] });
    byTable.get(c.table_name).cols.push(c);
  }

  const tsType = (c) => {
    const base = PG_TO_TS(c.data_type, c.udt_name);
    if (base) return base;
    const bare = c.udt_name.replace(/^_/, '');
    if (enumNames.has(bare)) {
      const t = `Enums['${bare}']`;
      return c.udt_name.startsWith('_') ? `${t}[]` : t;
    }
    return 'unknown';
  };

  let out = `// AUTO-GENERATED by scripts/gen-types.mjs — do not edit by hand.
// Regenerate with: npm run db:types

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Enums = {
${enums.map(e => `  ${e.typname}: ${e.labels.map(l => JSON.stringify(l)).join(' | ')};`).join('\n')}
};

export type Database = {
  public: {
    Tables: {
`;

  for (const [name, { type, cols: cc }] of [...byTable].filter(([, v]) => v.type === 'BASE TABLE')) {
    out += `      ${name}: {\n        Row: {\n`;
    for (const c of cc) out += `          ${c.column_name}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''};\n`;
    out += `        };\n        Insert: {\n`;
    for (const c of cc) {
      const optional = c.is_nullable === 'YES' || c.column_default !== null;
      out += `          ${c.column_name}${optional ? '?' : ''}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''};\n`;
    }
    out += `        };\n        Update: {\n`;
    for (const c of cc) out += `          ${c.column_name}?: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''};\n`;
    out += `        };\n`;
    out += relationshipsFor(name);
    out += `      };\n`;
  }

  out += `    };\n    Views: {\n`;
  for (const [name, { type, cols: cc }] of [...byTable].filter(([, v]) => v.type === 'VIEW')) {
    out += `      ${name}: {\n        Row: {\n`;
    for (const c of cc) out += `          ${c.column_name}: ${tsType(c)} | null;\n`;
    out += `        };\n        Relationships: [];\n      };\n`;
  }
  out += `    };\n    Functions: {\n`;
  const emitted = new Set();
  for (const f of fns) {
    if (emitted.has(f.proname)) continue;
    emitted.add(f.proname);
    out += `      /** (${f.args || 'no args'}) -> ${f.result} */\n`;
    out += `      ${f.proname}: { Args: Record<string, unknown>; Returns: unknown };\n`;
  }
  out += `    };\n    Enums: Enums;\n  };\n};\n\n`;

  out += `export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];
`;

  const dest = join(ROOT, 'src', 'lib', 'database.types.ts');
  writeFileSync(dest, out);
  console.log(`wrote ${dest}`);
  console.log(`  ${[...byTable].filter(([,v])=>v.type==='BASE TABLE').length} tables, ` +
              `${[...byTable].filter(([,v])=>v.type==='VIEW').length} views, ${enums.length} enums`);
} finally { await stopPostgres(ctx); }
