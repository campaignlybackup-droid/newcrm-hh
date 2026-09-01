/**
 * Two-way Google Calendar sync, per user.
 *
 * Outbound: the user's visible calendar items become Google events.
 * Inbound: Google's incremental sync token tells us what changed; a moved
 * event writes back through the normal UPDATE path, so the dependency
 * engine and the audit trigger both fire exactly as they would in the UI.
 *
 * Tokens are stored per user in users.google_sync_token. OAuth refresh
 * tokens live in Supabase Vault, never in a business table.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, requireAuth } from '../_shared/cors.ts';

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = requireAuth(req);
    const { direction = 'both' } = await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: `Bearer ${auth.token}` } } },
    );

    const { data: ctx } = await supabase.rpc('my_context');
    const me = (ctx as unknown as { user?: { id: string; timezone: string } })?.user;
    if (!me) return new Response('Unauthorized', { status: 401, headers: corsHeaders });

    const accessToken = await googleAccessToken(me.id);
    if (!accessToken) {
      return new Response(JSON.stringify({ skipped: 'Google not connected for this user' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: user } = await supabase
      .from('users').select('google_calendar_id, google_sync_token').eq('id', me.id).single();
    const calendarId = user?.google_calendar_id ?? 'primary';

    let pushed = 0, pulled = 0;

    // ---- Outbound -----------------------------------------------------
    if (direction === 'both' || direction === 'out') {
      // Only my own items, and only the layers worth putting on a personal
      // calendar. RLS has already limited this to what I may see.
      const { data: items } = await supabase
        .from('v_calendar').select('*').eq('user_id', me.id)
        .in('layer', ['task', 'shoot', 'meeting', 'deliverable'])
        .gte('start_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
        .limit(500);

      for (const it of (items ?? []) as Record<string, unknown>[]) {
        const body = {
          summary: `${String(it.layer).toUpperCase()} · ${String(it.title)}`,
          start: it.start_at
            ? { dateTime: String(it.start_at), timeZone: me.timezone }
            : { date: String(it.start_date) },
          end: it.end_at
            ? { dateTime: String(it.end_at), timeZone: me.timezone }
            : { date: String(it.end_date ?? it.start_date) },
          // The round-trip identity: this is how an inbound change finds
          // the record it belongs to.
          extendedProperties: {
            private: { crm_entity_type: String(it.entity_type), crm_entity_id: String(it.entity_id) },
          },
        };
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          { method: 'POST', headers: gHeaders(accessToken), body: JSON.stringify(body) },
        );
        if (res.ok) pushed++;
      }
    }

    // ---- Inbound ------------------------------------------------------
    let nextSyncToken: string | null = null;
    if (direction === 'both' || direction === 'in') {
      const params = new URLSearchParams({ maxResults: '250', singleEvents: 'true' });
      if (user?.google_sync_token) params.set('syncToken', user.google_sync_token);
      else params.set('timeMin', new Date(Date.now() - 30 * 86400000).toISOString());

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        { headers: gHeaders(accessToken) },
      );
      if (res.ok) {
        const page = await res.json();
        nextSyncToken = page.nextSyncToken ?? null;

        for (const ev of (page.items ?? []) as GEvent[]) {
          const priv = ev.extendedProperties?.private;
          const type = priv?.crm_entity_type;
          const id = priv?.crm_entity_id;
          if (!type || !id || ev.status === 'cancelled') continue;

          const startDate = ev.start?.date ?? ev.start?.dateTime?.slice(0, 10);
          if (!startDate) continue;

          // Written as a normal UPDATE under the user's own token: RLS
          // decides whether they may move it, and moving it cascades.
          const column =
            type === 'tasks' ? 'due_date' :
            type === 'shoots' ? 'shoot_date' :
            type === 'deliverables' ? 'due_date' : null;

          if (column) {
            const { error } = await supabase.from(type).update({ [column]: startDate }).eq('id', id);
            if (!error) pulled++;
          } else if (type === 'meetings' && ev.start?.dateTime) {
            const { error } = await supabase.from('meetings')
              .update({ starts_at: ev.start.dateTime }).eq('id', id);
            if (!error) pulled++;
          }
        }
      }
    }

    if (nextSyncToken) {
      await supabase.from('users').update({ google_sync_token: nextSyncToken }).eq('id', me.id);
    }

    return new Response(JSON.stringify({ pushed, pulled, calendarId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});

const gHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * Exchanges the user's stored refresh token for an access token.
 * Refresh tokens are read from Supabase Vault — never from a business
 * table, and never returned to the browser.
 */
async function googleAccessToken(userId: string): Promise<string | null> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data } = await admin.rpc('vault_read_google_refresh_token', { p_user_id: userId })
    .catch(() => ({ data: null }));
  const refresh = data as string | null;
  if (!refresh) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}
