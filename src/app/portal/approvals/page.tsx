'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, Button, StatusChip, Spinner, Empty } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import type { Enums } from '@/lib/database.types';

/**
 * The client's approval queue with a comment box.
 *
 * Approving writes straight to public.approvals under the client_portal
 * role — the same trigger chain then opens the next stage or raises a
 * revision round. The client never sees who worked on it.
 */
export default function PortalApprovals() {
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  const q = useQuery({
    queryKey: ['portal', 'approvals'],
    queryFn: async () => {
      const { data, error } = await supabase().from('v_portal_approvals')
        .select('*').order('due_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const decide = useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: Enums['approval_state']; note?: string }) => {
      const { error } = await supabase().from('approvals')
        .update({ status, feedback: note || null }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['portal'] });
      pushToast('Thanks — your decision has been recorded.');
    },
    onError: (e) => pushToast(e instanceof Error ? e.message : 'Could not save', 'error'),
  });

  if (q.isLoading) return <Spinner />;
  const pending = (q.data ?? []).filter((a) => a.status === 'Pending');
  const past = (q.data ?? []).filter((a) => a.status !== 'Pending');

  return (
    <div className="space-y-3">
      <Card title={`Waiting on you · ${pending.length}`}>
        {!pending.length && <Empty title="Nothing to approve" hint="You are all caught up." />}
        <ul className="space-y-3">
          {pending.map((a) => (
            <li key={String(a.id)} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-medium">
                  {String(a.entity_type).replace('_', ' ')} · round {String(a.round_no)}
                </span>
                <span className="text-[12px] text-muted">
                  due {a.due_at ? new Date(String(a.due_at)).toLocaleDateString() : '—'}
                </span>
              </div>
              <textarea
                placeholder="Optional comments — what would you like changed?"
                value={feedback[String(a.id)] ?? ''}
                onChange={(e) => setFeedback((f) => ({ ...f, [String(a.id)]: e.target.value }))}
                className="mt-2 min-h-[64px] w-full rounded-md border border-border bg-surface p-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/50" />
              <div className="mt-2 flex justify-end gap-1.5">
                <Button variant="outline"
                  onClick={() => decide.mutate({
                    id: String(a.id), status: 'Changes Requested', note: feedback[String(a.id)],
                  })}>
                  Request changes
                </Button>
                <Button variant="primary"
                  onClick={() => decide.mutate({
                    id: String(a.id), status: 'Approved', note: feedback[String(a.id)],
                  })}>
                  Approve
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {past.length > 0 && (
        <Card title="Decided">
          <ul className="divide-y divide-border">
            {past.map((a) => (
              <li key={String(a.id)} className="flex items-center justify-between py-1.5 text-[13px]">
                <span>{String(a.entity_type).replace('_', ' ')} · round {String(a.round_no)}</span>
                <span className="flex items-center gap-2">
                  <StatusChip value={String(a.status)} />
                  <span className="text-[12px] text-muted">
                    {a.decided_at ? new Date(String(a.decided_at)).toLocaleDateString() : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
