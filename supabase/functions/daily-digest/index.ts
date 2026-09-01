/**
 * Daily digest — invoked hourly by pg_cron, which only picks the users for
 * whom it is currently 09:00 in THEIR timezone. This function turns the
 * queued digest notifications into email.
 *
 * The digest content is computed in the database (fn_daily_digest) so the
 * numbers here are exactly what the user would see in the app under their
 * own RLS scope. This function never widens that.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, requireAuth } from '../_shared/cors.ts';

interface Digest {
  local_date: string;
  tasks_due_today: { id: string; title: string; client: string; priority: string }[];
  tasks_overdue: { id: string; title: string; due_date: string; days_over: number }[];
  approvals_waiting_on_me: { id: string; entity_type: string; due_at: string; level: string }[];
  shoots_today: { id: string; title: string; call_time: string; location: string; map_link: string }[];
  posts_going_live: { id: string; title: string; platform: string; post_time: string }[];
  meetings_today: { id: string; title: string; starts_at: string; link: string }[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = requireAuth(req);
    if (auth.kind !== 'service') {
      return new Response('Scheduler only', { status: 403, headers: corsHeaders });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Pending digest notifications queued by fn_queue_daily_digests().
    const { data: queued, error } = await admin
      .from('notifications')
      .select('id, user_id, message, users:user_id(email, full_name, timezone)')
      .eq('type', 'daily_digest')
      .eq('channel', 'digest')
      .is('sent_at', null)
      .limit(500);
    if (error) throw error;

    let sent = 0;
    for (const n of queued ?? []) {
      const user = (n as Record<string, unknown>).users as
        { email: string; full_name: string; timezone: string } | null;
      if (!user?.email) continue;

      let digest: Digest;
      try { digest = JSON.parse(String(n.message)); } catch { continue; }

      const html = renderDigest(user.full_name, digest);
      const ok = await deliver(user.email, `Your day · ${digest.local_date}`, html);
      if (ok) {
        await admin.from('notifications').update({ sent_at: new Date().toISOString() }).eq('id', n.id);
        sent++;
      }
    }

    return new Response(JSON.stringify({ queued: queued?.length ?? 0, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});

function section(title: string, rows: string[]): string {
  if (!rows.length) return '';
  return `<h3 style="margin:16px 0 6px;font:600 13px system-ui">${title}</h3>
    <ul style="margin:0;padding-left:18px;font:14px system-ui;line-height:1.55">${rows.join('')}</ul>`;
}

function renderDigest(name: string, d: Digest): string {
  const parts = [
    section('Due today', d.tasks_due_today.map((t) =>
      `<li>${esc(t.title)}${t.client ? ` <span style="color:#697">· ${esc(t.client)}</span>` : ''}</li>`)),
    section('Overdue', d.tasks_overdue.map((t) =>
      `<li><strong style="color:#c33">${t.days_over}d</strong> ${esc(t.title)}</li>`)),
    section('Approvals waiting on you', d.approvals_waiting_on_me.map((a) =>
      `<li>${esc(a.level)} approval on ${esc(a.entity_type.replace('_', ' '))}</li>`)),
    section('Shoots today', d.shoots_today.map((s) =>
      `<li>${esc(s.title)} · call ${esc(s.call_time ?? '')}${
        s.map_link ? ` · <a href="${esc(s.map_link)}">map</a>` : ''}</li>`)),
    section('Going live today', d.posts_going_live.map((p) =>
      `<li>${esc(p.platform)} · ${esc(p.title ?? '')} ${esc(p.post_time ?? '')}</li>`)),
    section('Meetings', d.meetings_today.map((m) =>
      `<li>${esc(m.title)} · ${new Date(m.starts_at).toLocaleTimeString()}</li>`)),
  ].filter(Boolean);

  return `<div style="max-width:560px;margin:0 auto;font:14px system-ui;color:#111">
    <p style="font:600 16px system-ui">Good morning, ${esc(name.split(' ')[0])}</p>
    ${parts.length ? parts.join('') : '<p>Nothing scheduled today.</p>'}
    <p style="margin-top:20px;font-size:12px;color:#697">
      Sent at 09:00 in your timezone. Everything here is scoped to what you can already see.
    </p></div>`;
}

const esc = (s: string) => String(s ?? '').replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));

/**
 * Mail delivery. Configured via RESEND_API_KEY; if no provider is set the
 * function reports the digest as un-sent rather than pretending it went out.
 */
async function deliver(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('DIGEST_FROM');
  if (!key || !from) {
    console.warn('No mail provider configured; digest left queued for', to);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) console.error('Mail failed', res.status, await res.text());
  return res.ok;
}
