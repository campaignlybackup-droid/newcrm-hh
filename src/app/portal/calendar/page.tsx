'use client';

import { useQuery } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import listPlugin from '@fullcalendar/list';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Spinner } from '@/components/ui/primitives';

export default function PortalCalendar() {
  const { data: session } = useSession();
  const timezone = session?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const q = useQuery({
    queryKey: ['portal', 'calendar'],
    queryFn: async () => {
      const { data, error } = await supabase().from('v_portal_content_calendar')
        .select('*').order('post_date');
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  if (q.isLoading) return <Spinner />;

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <FullCalendar
        plugins={[dayGridPlugin, listPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,listMonth' }}
        buttonText={{ today: 'Today', month: 'Month', list: 'List' }}
        timeZone={timezone}
        firstDay={1}
        height="72vh"
        events={(q.data ?? []).map((p) => ({
          id: String(p.id),
          title: `${String(p.platform)} · ${String(p.content_type)}${p.title ? ` — ${String(p.title)}` : ''}`,
          start: (p.post_at_utc as string) ?? (p.post_date as string),
          allDay: !p.post_time,
          backgroundColor: p.approval_status === 'Approved' ? 'rgb(var(--green))' : 'rgb(var(--accent))',
          borderColor: 'transparent',
          textColor: '#fff',
        }))}
      />
      <p className="mt-2 text-[11px] text-muted">
        Times are shown in {timezone}.
      </p>
    </div>
  );
}
