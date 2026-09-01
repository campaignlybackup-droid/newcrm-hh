'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Spinner, Button, Empty, StatusChip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export default function NotificationsPage() {
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['notifications', 'all'],
    queryFn: async () => {
      const { data, error } = await supabase().from('notifications')
        .select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase().from('notifications')
        .update({ read_at: new Date().toISOString() }).in('id', ids);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  if (q.isLoading) return <Spinner />;
  const rows = q.data ?? [];
  const unread = rows.filter((r) => !r.read_at);

  return (
    <div className="space-y-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Notifications</h1>
          <p className="text-[13px] text-muted">{unread.length} unread</p>
        </div>
        {unread.length > 0 && (
          <Button onClick={() => markRead.mutate(unread.map((r) => String(r.id)))}>
            Mark all read
          </Button>
        )}
      </header>

      {!rows.length && <Empty title="Nothing yet"
        hint="Overdue escalations, approval requests, renewal alerts and the 9 AM digest land here." />}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((n) => {
          const isDigest = n.type === 'daily_digest';
          return (
            <li key={String(n.id)}
              className={cn('flex items-start gap-3 px-3 py-2.5', !n.read_at && 'bg-accent/5')}>
              <StatusChip value={String(n.priority)} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{String(n.title)}</p>
                {!isDigest && n.message != null && (
                  <p className="text-[12px] text-muted">{String(n.message)}</p>
                )}
                {isDigest && <DigestBody json={String(n.message ?? '{}')} />}
                <p className="mt-0.5 text-[11px] text-muted">
                  {new Date(String(n.created_at)).toLocaleString()} · {String(n.type).replace(/_/g, ' ')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {typeof n.url === 'string' && (
                  <Link href={n.url}><Button variant="ghost">Open</Button></Link>
                )}
                {!n.read_at && (
                  <Button variant="ghost" onClick={() => markRead.mutate([String(n.id)])}>Mark read</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DigestBody({ json }: { json: string }) {
  let d: Record<string, unknown[]> = {};
  try { d = JSON.parse(json); } catch { return null; }
  const buckets: [string, string][] = [
    ['tasks_due_today', 'due today'], ['tasks_overdue', 'overdue'],
    ['approvals_waiting_on_me', 'approvals on you'], ['shoots_today', 'shoots today'],
    ['posts_going_live', 'posts going live'], ['meetings_today', 'meetings'],
  ];
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
      {buckets.map(([k, label]) => {
        const n = Array.isArray(d[k]) ? d[k].length : 0;
        if (!n) return null;
        return <li key={k}><span className="font-medium text-fg">{n}</span> {label}</li>;
      })}
    </ul>
  );
}
