'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, StatusChip, Spinner, Empty } from '@/components/ui/primitives';

export default function PortalDeliverables() {
  const q = useQuery({
    queryKey: ['portal', 'deliverables'],
    queryFn: async () => {
      const { data, error } = await supabase().from('v_portal_deliverables')
        .select('*').order('due_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];
  if (!rows.length) return <Empty title="No deliverables yet" />;

  return (
    <Card title={`Deliverables · ${rows.length}`}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="pb-2">Deliverable</th><th className="pb-2">Type</th>
            <th className="pb-2">Due</th><th className="pb-2">Status</th><th className="pb-2">Approval</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-t border-border">
              <td className="py-1.5">{String(r.title)}</td>
              <td className="py-1.5 text-muted">{String(r.type)}</td>
              <td className="py-1.5 tabular-nums">{String(r.due_date ?? '—')}</td>
              <td className="py-1.5"><StatusChip value={String(r.status)} /></td>
              <td className="py-1.5"><StatusChip value={String(r.approval_status)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
