/**
 * Auto-generated call sheet.
 *
 * Runs as the CALLER, not the service role: the client is created with the
 * user's own Authorization header, so v_call_sheet is filtered by RLS and
 * someone who cannot see the shoot cannot render its call sheet either.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, requireAuth } from '../_shared/cors.ts';

interface CrewMember { name: string; phone: string | null; role_on_shoot: string; call_time: string | null; confirmed: boolean }
interface Shot { sort_order: number; shot_name: string; shot_type: string | null; camera_move: string | null; duration_secs: number | null; props: string[] }
interface Kit { item_name: string; category: string | null; asset_tag: string | null }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = requireAuth(req);
    const { shoot_id } = await req.json();
    if (!shoot_id) return new Response('shoot_id required', { status: 400, headers: corsHeaders });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${auth.token}` } } },
    );

    const { data, error } = await supabase
      .from('v_call_sheet').select('*').eq('shoot_id', shoot_id).single();
    if (error || !data) {
      return new Response('Shoot not found, or not visible to you', { status: 404, headers: corsHeaders });
    }

    const html = renderCallSheet(data as Record<string, unknown>);
    return new Response(html, {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});

const esc = (s: unknown) => String(s ?? '').replace(/[<>&"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));

function renderCallSheet(s: Record<string, unknown>): string {
  const crew = (s.crew ?? []) as CrewMember[];
  const shots = (s.shot_list ?? []) as Shot[];
  const kit = (s.equipment ?? []) as Kit[];
  const brand = (s.colour_hex_list as string[] | null)?.[0] ?? '#111827';

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Call sheet · ${esc(s.title)}</title>
<style>
  @page { size: A4; margin: 14mm }
  body { font: 12px/1.5 system-ui, sans-serif; color: #111; margin: 0 }
  h1 { font-size: 20px; margin: 0 }
  h2 { font-size: 13px; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 2px solid ${esc(brand)} }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 3px solid ${esc(brand)}; padding-bottom: 10px }
  .muted { color: #6b7280 }
  table { width: 100%; border-collapse: collapse; margin-top: 4px }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280 }
  .times { display: flex; gap: 22px; margin-top: 8px }
  .times div span { display: block; font-size: 10px; text-transform: uppercase; color: #6b7280 }
  .times div strong { font-size: 15px }
  .note { margin-top: 18px; padding: 8px 10px; background: #f9fafb; border-left: 3px solid ${esc(brand)} }
  @media print { .noprint { display: none } }
</style></head><body>

<div class="head">
  <div>
    <h1>${esc(s.title)}</h1>
    <p class="muted">${esc(s.brand_name)} · ${esc(s.type)} · ${esc(s.status)}</p>
  </div>
  <div style="text-align:right">
    <strong>${esc(s.shoot_date)}</strong>
    <p class="muted">${esc(s.project_name ?? '')}</p>
  </div>
</div>

<div class="times">
  <div><span>General call</span><strong>${esc(s.call_time ?? 'TBC')}</strong></div>
  <div><span>Estimated wrap</span><strong>${esc(s.wrap_time ?? 'TBC')}</strong></div>
  <div><span>Timezone</span><strong>${esc(s.client_timezone)}</strong></div>
</div>

<h2>Location</h2>
<p><strong>${esc(s.location_name ?? 'TBC')}</strong><br>
${esc(s.address ?? '')}
${s.map_link ? `<br><a href="${esc(s.map_link)}">Open map</a>` : ''}</p>
${s.weather_note ? `<p class="muted">Weather: ${esc(s.weather_note)}</p>` : ''}

<h2>Contacts</h2>
<table>
  <tr><th>Role</th><th>Name</th><th>Phone</th></tr>
  ${s.account_manager_name ? `<tr><td>Account manager</td><td>${esc(s.account_manager_name)}</td><td></td></tr>` : ''}
  ${s.director_name ? `<tr><td>Director</td><td>${esc(s.director_name)}</td><td></td></tr>` : ''}
  ${s.client_poc_name ? `<tr><td>Client POC</td><td>${esc(s.client_poc_name)}</td><td>${esc(s.client_poc_phone ?? '')}</td></tr>` : ''}
</table>

<h2>Crew · ${crew.length}</h2>
<table>
  <tr><th>Call</th><th>Name</th><th>Role</th><th>Phone</th><th>Confirmed</th></tr>
  ${crew.map((c) => `<tr>
    <td><strong>${esc(c.call_time ?? s.call_time)}</strong></td>
    <td>${esc(c.name)}</td><td>${esc(c.role_on_shoot)}</td>
    <td>${esc(c.phone ?? '')}</td>
    <td>${c.confirmed ? 'Yes' : '<span style="color:#b45309">Pending</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted">No crew assigned yet.</td></tr>'}
</table>

<h2>Shot list · ${shots.length}</h2>
<table>
  <tr><th>#</th><th>Shot</th><th>Type</th><th>Move</th><th>Dur</th><th>Props</th></tr>
  ${shots.map((x) => `<tr>
    <td>${esc(x.sort_order)}</td><td>${esc(x.shot_name)}</td>
    <td>${esc(x.shot_type ?? '')}</td><td>${esc(x.camera_move ?? '')}</td>
    <td>${x.duration_secs ? `${x.duration_secs}s` : ''}</td>
    <td>${esc((x.props ?? []).join(', '))}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">No shot list attached.</td></tr>'}
</table>

<h2>Equipment · ${kit.length}</h2>
<table>
  <tr><th>Item</th><th>Category</th><th>Asset tag</th></tr>
  ${kit.map((k) => `<tr><td>${esc(k.item_name)}</td><td>${esc(k.category ?? '')}</td><td>${esc(k.asset_tag ?? '')}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">No equipment booked.</td></tr>'}
</table>

${s.brief ? `<div class="note"><strong>Brief</strong><br>${esc(s.brief)}</div>` : ''}

<p class="noprint muted" style="margin-top:20px">
  Generated from the live record — client, brand, crew call times, shot list and equipment are read
  at print time, never copied. Use your browser's Print → Save as PDF.
</p>
</body></html>`;
}
