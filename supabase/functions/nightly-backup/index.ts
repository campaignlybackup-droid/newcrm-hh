/**
 * Nightly logical backup to a SEPARATE storage bucket, 30-day retention.
 *
 * This is the belt to Point-in-Time Recovery's braces: PITR protects
 * against infrastructure loss, this protects against a bad migration or a
 * mass edit, because the dump is a readable snapshot you can diff.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, requireAuth } from '../_shared/cors.ts';

const BUCKET = Deno.env.get('BACKUP_BUCKET') ?? 'db-backups';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = requireAuth(req);
    if (auth.kind !== 'service') {
      return new Response('Scheduler only', { status: 403, headers: corsHeaders });
    }

    const { retention_days = 30 } = await req.json().catch(() => ({}));
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    await admin.storage.createBucket(BUCKET, { public: false }).catch(() => {});

    // Table-by-table JSON export. Ordered so a restore can replay parents
    // before children without deferring constraints.
    const { data: tables, error: tErr } = await admin.rpc('backup_table_order');
    if (tErr) throw tErr;

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const manifest: { table: string; rows: number; bytes: number }[] = [];
    const chunks: string[] = [];

    for (const t of (tables ?? []) as { table_name: string }[]) {
      let from = 0;
      const size = 1000;
      let rows = 0;
      const lines: string[] = [];
      for (;;) {
        const { data, error } = await admin.from(t.table_name).select('*').range(from, from + size - 1);
        if (error) throw error;
        if (!data?.length) break;
        for (const r of data) lines.push(JSON.stringify({ table: t.table_name, row: r }));
        rows += data.length;
        if (data.length < size) break;
        from += size;
      }
      const body = lines.join('\n');
      manifest.push({ table: t.table_name, rows, bytes: body.length });
      if (body) chunks.push(body);
    }

    const dump = chunks.join('\n');
    const path = `${stamp}/dump.ndjson`;
    const up = await admin.storage.from(BUCKET).upload(path, new Blob([dump]), {
      contentType: 'application/x-ndjson', upsert: false,
    });
    if (up.error) throw up.error;

    await admin.storage.from(BUCKET).upload(
      `${stamp}/manifest.json`,
      new Blob([JSON.stringify({ taken_at: new Date().toISOString(), manifest }, null, 2)]),
      { contentType: 'application/json', upsert: false },
    );

    // Retention sweep.
    const { data: existing } = await admin.storage.from(BUCKET).list('', { limit: 1000 });
    const cutoff = Date.now() - retention_days * 86_400_000;
    let purged = 0;
    for (const folder of existing ?? []) {
      const created = new Date(folder.created_at ?? 0).getTime();
      if (created && created < cutoff) {
        const { data: inner } = await admin.storage.from(BUCKET).list(folder.name);
        await admin.storage.from(BUCKET)
          .remove((inner ?? []).map((f) => `${folder.name}/${f.name}`));
        purged++;
      }
    }

    return new Response(JSON.stringify({
      path, tables: manifest.length,
      rows: manifest.reduce((a, m) => a + m.rows, 0),
      bytes: dump.length, purged_snapshots: purged,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
