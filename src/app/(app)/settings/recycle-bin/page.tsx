'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Spinner, ErrorBox, Button, Empty } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import { useState } from 'react';

/**
 * Founder-only Recycle Bin.
 *
 * Restore is non-destructive because soft delete never removed the row:
 * every foreign key still resolves, so a restored client comes back with
 * its projects, deliverables and tasks intact.
 */
export default function RecycleBinPage() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const bin = useQuery({
    queryKey: ['recycle_bin'],
    queryFn: async () => {
      const { data, error } = await supabase().rpc('recycle_bin', { p_limit: 300 });
      if (error) throw error;
      return (data ?? []) as unknown as {
        entity_type: string; entity_id: string; label: string;
        deleted_at: string; deleted_by_name: string | null;
      }[];
    },
  });

  const restore = useMutation({
    mutationFn: async (r: { entity_type: string; entity_id: string }) => {
      const { error } = await supabase().rpc('restore_record', {
        p_entity_type: r.entity_type, p_id: r.entity_id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recycle_bin'] });
      qc.invalidateQueries({ queryKey: ['records'] });
      pushToast('Restored with all relations intact');
    },
    onError: (e) => pushToast(e instanceof Error ? e.message : 'Restore failed', 'error'),
  });

  const purge = useMutation({
    mutationFn: async (r: { entity_type: string; entity_id: string; confirmation: string }) => {
      const { error } = await supabase().rpc('hard_delete', {
        p_entity_type: r.entity_type, p_id: r.entity_id, p_confirmation: r.confirmation,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setConfirmFor(null); setTyped('');
      qc.invalidateQueries({ queryKey: ['recycle_bin'] });
      pushToast('Permanently deleted');
    },
    onError: (e) => pushToast(e instanceof Error ? e.message : 'Delete failed', 'error'),
  });

  if ((session?.role.level ?? 99) > 1) {
    return <div className="p-8"><ErrorBox error="The Recycle Bin is Founder-only." /></div>;
  }
  if (bin.isLoading) return <Spinner />;
  if (bin.error) return <div className="p-4"><ErrorBox error={bin.error} /></div>;

  const rows = bin.data ?? [];

  return (
    <div className="space-y-3 p-4">
      <header>
        <h1 className="text-lg font-semibold">Recycle Bin</h1>
        <p className="text-[13px] text-muted">
          {rows.length} deleted record{rows.length === 1 ? '' : 's'}. Nothing here was physically removed,
          so restoring brings back every relation.
        </p>
      </header>

      {!rows.length && <Empty title="Nothing deleted" hint="Deleted records appear here until a Founder purges them." />}

      <div className="scroll-thin overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-raised">
            <tr>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Record</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Type</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Deleted</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">By</th>
              <th className="border-b border-border px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.entity_type}-${r.entity_id}`} className="hover:bg-raised/50">
                <td className="border-b border-border px-3 py-1.5">{r.label ?? r.entity_id.slice(0, 8)}</td>
                <td className="border-b border-border px-3 py-1.5 text-muted">{r.entity_type}</td>
                <td className="border-b border-border px-3 py-1.5 tabular-nums text-muted">
                  {new Date(r.deleted_at).toLocaleString()}
                </td>
                <td className="border-b border-border px-3 py-1.5 text-muted">{r.deleted_by_name ?? 'System'}</td>
                <td className="border-b border-border px-3 py-1.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button onClick={() => restore.mutate(r)}>Restore</Button>
                    <Button variant="danger" onClick={() => { setConfirmFor(r.entity_id); setTyped(''); }}>
                      Delete forever
                    </Button>
                  </div>
                  {confirmFor === r.entity_id && (
                    <div className="mt-2 rounded-md border border-red/40 bg-red/5 p-2 text-left">
                      <p className="text-[12px]">
                        This cannot be undone. Type <code className="font-mono">DELETE {r.entity_type}</code> to confirm.
                      </p>
                      <div className="mt-1.5 flex gap-1.5">
                        <input value={typed} onChange={(e) => setTyped(e.target.value)}
                          className="h-7 flex-1 rounded border border-border bg-surface px-2 text-[12px]" />
                        <Button variant="danger" disabled={typed !== `DELETE ${r.entity_type}`}
                          onClick={() => purge.mutate({ ...r, confirmation: typed })}>
                          Confirm
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmFor(null)}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
