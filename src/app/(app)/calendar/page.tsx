'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { useOptions } from '@/lib/records';
import { Spinner, Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * ONE calendar with toggleable layers.
 *
 * Personal, manager and founder calendars are not three implementations —
 * they are this one view returning different rows because RLS filtered
 * v_calendar differently for each viewer.
 */
const LAYERS = [
  { key: 'task',        label: 'Tasks',        colour: 'rgb(var(--accent))' },
  { key: 'deliverable', label: 'Deliverables', colour: '#7c5cff' },
  { key: 'shoot',       label: 'Shoots',       colour: '#c2410c' },
  { key: 'post',        label: 'Posts',        colour: '#0891b2' },
  { key: 'meeting',     label: 'Meetings',     colour: '#0f766e' },
  { key: 'approval',    label: 'Approvals',    colour: 'rgb(var(--amber))' },
  { key: 'leave',       label: 'Leave',        colour: 'rgb(var(--muted))' },
  { key: 'renewal',     label: 'Renewals',     colour: 'rgb(var(--red))' },
] as const;

const MODULE_FOR: Record<string, string> = {
  task: 'tasks', deliverable: 'deliverables', shoot: 'shoots', post: 'content_calendar',
  meeting: 'meetings', approval: 'approvals', leave: 'leaves', renewal: 'clients',
};

export default function UnifiedCalendarPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [active, setActive] = useState<string[]>(LAYERS.map((l) => l.key));
  const [clientId, setClientId] = useState<string>('');
  const [personId, setPersonId] = useState<string>('');
  const [mineOnly, setMineOnly] = useState(false);

  const clients = useOptions({ table: 'clients', labelKey: 'brand_name', orderBy: 'brand_name' });
  const users = useOptions({ table: 'users', labelKey: 'full_name', orderBy: 'full_name' });
  const timezone = session?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const q = useQuery({
    queryKey: ['calendar', clientId, personId, mineOnly, session?.user.id],
    queryFn: async () => {
      let sel = supabase().from('v_calendar').select('*').limit(3000);
      if (clientId) sel = sel.eq('client_id', clientId);
      if (mineOnly && session?.user.id) sel = sel.eq('user_id', session.user.id);
      else if (personId) sel = sel.eq('user_id', personId);
      const { data, error } = await sel;
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const events = useMemo(() => (q.data ?? [])
    .filter((r) => active.includes(String(r.layer)))
    .map((r) => {
      const layer = LAYERS.find((l) => l.key === r.layer)!;
      const allDay = Boolean(r.all_day);
      return {
        id: `${r.layer}:${r.entity_id}`,
        title: String(r.title ?? ''),
        start: (r.start_at as string) ?? (r.start_date as string),
        end: (r.end_at as string) ?? (allDay && r.end_date ? addDay(String(r.end_date)) : undefined),
        allDay,
        backgroundColor: r.flagged ? 'rgb(var(--red))' : layer.colour,
        borderColor: r.flagged ? 'rgb(var(--red))' : layer.colour,
        textColor: '#fff',
        extendedProps: { layer: r.layer, entityId: r.entity_id, status: r.status },
      };
    }), [q.data, active]);

  return (
    <div className="space-y-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Calendar</h1>
          <p className="text-[13px] text-muted">
            {mineOnly ? 'My items only' : (session?.role.level ?? 9) <= 1 ? 'Everything' : 'My team and my clients'}
            {' · rendered in '}{timezone}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={mineOnly ? 'primary' : 'outline'} onClick={() => setMineOnly((m) => !m)}>
            My items
          </Button>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            <option value="">All clients</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <select value={personId} onChange={(e) => { setPersonId(e.target.value); setMineOnly(false); }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            <option value="">Everyone visible</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {LAYERS.map((l) => {
          const on = active.includes(l.key);
          return (
            <button key={l.key}
              onClick={() => setActive((a) => on ? a.filter((k) => k !== l.key) : [...a, l.key])}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]',
                on ? 'border-transparent text-white' : 'border-border text-muted')}
              style={on ? { backgroundColor: l.colour } : undefined}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? '#fff' : l.colour }} />
              {l.label}
            </button>
          );
        })}
      </div>

      {q.isLoading ? <Spinner /> : (
        <div className="rounded-lg border border-border bg-surface p-3">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: 'prev,next today', center: 'title',
              right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
            }}
            buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
            timeZone={timezone}
            firstDay={1}
            height="72vh"
            dayMaxEvents={4}
            events={events}
            eventClick={(info) => {
              const layer = String(info.event.extendedProps.layer);
              const id = String(info.event.extendedProps.entityId);
              router.push(`/${MODULE_FOR[layer] ?? 'tasks'}/${id}`);
            }}
          />
        </div>
      )}

      <p className="text-[11px] text-muted">
        Dragging an item to a new date triggers the dependency engine: downstream edits, reviews,
        approvals and posts shift by the same working-day delta, and every shift is written to the audit log.
      </p>
    </div>
  );
}

function addDay(d: string) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
}
