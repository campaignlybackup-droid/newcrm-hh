'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, StatusChip, Spinner, Empty } from '@/components/ui/primitives';

export default function PortalSchedule() {
  const q = useQuery({
    queryKey: ['portal', 'schedule'],
    queryFn: async () => {
      const { data, error } = await supabase().from('v_portal_schedule')
        .select('*').order('on_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];
  if (!rows.length) return <Empty title="Nothing scheduled" />;

  return (
    <Card title="Shoots and meetings">
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={`${r.layer}-${r.id}`} className="flex items-center justify-between gap-3 py-2 text-[13px]">
            <span className="min-w-0">
              <span className="truncate font-medium">{String(r.title)}</span>
              <span className="ml-2 text-[11px] uppercase tracking-wide text-muted">{String(r.layer)}</span>
              {r.detail != null && <p className="truncate text-[12px] text-muted">{String(r.detail)}</p>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums text-muted">{String(r.on_date)}</span>
              {r.at_time != null && <span className="tabular-nums text-muted">{String(r.at_time).slice(0, 5)}</span>}
              <StatusChip value={String(r.status)} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
