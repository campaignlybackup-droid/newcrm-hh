'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, StatusChip, Spinner } from '@/components/ui/primitives';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * The executor's dashboard: their task queue by due date, with the brief
 * and brand kit one click away. Someone at this level sees no client list
 * — this is their whole surface, so it has to carry everything they need.
 */
export function MyQueue() {
  const { data: session } = useSession();

  const q = useQuery({
    queryKey: ['dashboard', 'my_queue', session?.user.id],
    enabled: Boolean(session?.user.id),
    queryFn: async () => {
      const { data, error } = await supabase().from('tasks')
        .select('*, client:clients(id,brand_name), deliverable:deliverables(id,title,brief)')
        .eq('assignee_id', session!.user.id)
        .is('deleted_at', null)
        .not('status', 'in', '("Delivered","Approved","Cancelled")')
        .order('due_date', { ascending: true }).limit(40);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Card title="My task queue" action={<Link href="/tasks" className="text-[12px] text-accent">All my tasks</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="text-[13px] text-muted">Nothing open. </p>}
      <ul className="divide-y divide-border">
        {q.data?.map((t) => {
          const due = t.due_date as string | null;
          const overdue = due != null && due < today;
          const dueToday = due === today;
          const client = t.client as { id?: string; brand_name?: string } | null;
          const deliverable = t.deliverable as { id?: string; title?: string } | null;
          return (
            <li key={String(t.id)} className="py-1.5 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/tasks/${String(t.id)}`} className="truncate font-medium hover:text-accent">
                  {String(t.title)}
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  {t.is_blocked === true && <StatusChip value="Blocked" />}
                  <StatusChip value={String(t.status)} />
                  <span className={cn('tabular-nums text-[12px]',
                    overdue ? 'font-medium text-red' : dueToday ? 'text-amber' : 'text-muted')}>
                    {due ?? 'no date'}
                  </span>
                </span>
              </div>
              <p className="truncate text-[11px] text-muted">
                {client?.brand_name}
                {deliverable?.title && ` · ${deliverable.title}`}
                {client?.id && (
                  <>
                    {' · '}
                    <Link href={`/clients/${client.id}`} className="hover:text-accent">brand kit</Link>
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
