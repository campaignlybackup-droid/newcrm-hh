'use client';

import { useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import { useUpdateRecord } from '@/lib/records';
import { pushToast } from '@/components/ui/Toaster';
import { can, type SessionContext } from '@/lib/session';
import type { ModuleDef } from '@/modules/types';

interface Props {
  mod: ModuleDef;
  rows: Record<string, unknown>[];
  session?: SessionContext;
  timezone: string;
}

const TONE: Record<string, string> = {
  Blocked: 'rgb(var(--red))', 'Changes Requested': 'rgb(var(--amber))',
  Approved: 'rgb(var(--green))', Delivered: 'rgb(var(--green))',
  'In Progress': 'rgb(var(--accent))', 'In Review': 'rgb(var(--accent))',
};

export function CalendarView({ mod, rows, session, timezone }: Props) {
  const router = useRouter();
  const update = useUpdateRecord();
  const ref = useRef<FullCalendar>(null);
  const cfg = mod.calendar!;

  const editable = can(session, mod.key, 'edit');
  const safeRows = rows ?? [];

  const events = useMemo(
    () => safeRows.map((r) => {
      const start = r[cfg.start] as string | null;
      const end = cfg.end ? (r[cfg.end] as string | null) : null;
      const status = String(r.status ?? r.approval_status ?? '');
      return {
        id: String(r.id),
        title: String(r[mod.titleField] ?? mod.singular),
        start: start ?? undefined,
        // FullCalendar treats an all-day end as exclusive.
        end: end && cfg.allDay ? addDay(end) : end ?? undefined,
        allDay: cfg.allDay ?? false,
        backgroundColor: TONE[status] ?? 'rgb(var(--raised))',
        borderColor: TONE[status] ?? 'rgb(var(--border))',
        textColor: TONE[status] ? '#fff' : 'rgb(var(--fg))',
        extendedProps: { client: (r.client as { brand_name?: string } | null)?.brand_name, status },
      };
    }).filter((e) => e.start),
    [rows, cfg, mod],
  );

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <FullCalendar
        ref={ref}
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: 'prev,next today',
          center: 'title',
          right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
        }}
        buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
        timeZone={timezone}
        height="72vh"
        events={events}
        editable={editable}
        eventStartEditable={editable}
        eventDurationEditable={false}
        dayMaxEvents={4}
        firstDay={1}
        eventClick={(info) => {
          info.jsEvent.preventDefault();
          router.push(`/${mod.key}/${info.event.id}`);
        }}
        eventDrop={(info) => {
          const next = info.event.start;
          if (!next) return info.revert();
          const value = cfg.allDay
            ? next.toISOString().slice(0, 10)
            : next.toISOString();
          const row = rows.find((r) => String(r.id) === info.event.id);
          update.mutate(
            { mod, id: info.event.id, patch: { [cfg.start]: value }, previous: row },
            {
              onError: (e) => {
                info.revert();
                pushToast(e instanceof Error ? e.message : 'Reschedule failed', 'error');
              },
              // A shoot or task move fires the dependency engine server-side;
              // the invalidation in useUpdateRecord pulls the shifted chain back.
              onSuccess: () => pushToast('Rescheduled — dependent dates were shifted and logged'),
            },
          );
        }}
        eventContent={(arg) => (
          <div className="truncate px-1 py-0.5 text-[11px] leading-tight">
            <span className="font-medium">{arg.event.title}</span>
            {arg.event.extendedProps.client && (
              <span className="opacity-80"> · {String(arg.event.extendedProps.client)}</span>
            )}
          </div>
        )}
      />
    </div>
  );
}

function addDay(d: string) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + 1);
  return dt.toISOString().slice(0, 10);
}
