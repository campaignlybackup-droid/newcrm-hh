'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner, StatusChip, Empty } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export function EditorQueue() {
  // Query 1: Active Editing Tasks
  const tasksQuery = useQuery({
    queryKey: ['editor_dashboard', 'tasks'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('tasks')
        .select('*, client:clients(brand_name), deliverable:deliverables(title)')
        .is('deleted_at', null)
        .neq('status', 'Delivered')
        .order('due_date', { ascending: true })
        .limit(15);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 2: Revisions Waiting on Changes
  const revisionsQuery = useQuery({
    queryKey: ['editor_dashboard', 'revisions'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('revisions')
        .select('*, deliverable:deliverables(title, client:clients(brand_name))')
        .is('deleted_at', null)
        .is('closed_at', null)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <div className="space-y-4 col-span-full lg:col-span-2">
      {/* Editor Queue Banner */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-4">
        <h2 className="text-sm font-semibold text-accent flex items-center gap-2">
          <span>🎬</span> Video Editing & Motion Graphics Suite
        </h2>
        <p className="mt-1 text-xs text-muted">
          Your active editing queue, open revision rounds, and deliverable specs sorted by priority.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Active Tasks Panel */}
        <Card
          title="Active Editing Tasks"
          action={<Link href="/tasks" className="text-[12px] text-accent hover:underline">All Tasks</Link>}
        >
          {tasksQuery.isLoading && <Spinner />}
          {tasksQuery.data && !tasksQuery.data.length && <Empty title="No active edit tasks assigned" />}
          <ul className="divide-y divide-border">
            {tasksQuery.data?.map((t) => {
              const overdue = t.due_date != null && new Date(String(t.due_date)) < new Date();
              return (
                <li key={String(t.id)} className="py-2 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/tasks/${String(t.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      {String(t.title ?? 'Untitled Task')}
                    </Link>
                    <StatusChip value={String(t.status ?? 'Not Started')} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                    <span>
                      {String((t.client as { brand_name?: string })?.brand_name ?? '—')}
                      {Boolean(t.deliverable) && ` · ${String((t.deliverable as { title?: string })?.title ?? '')}`}
                    </span>
                    <span className={cn('tabular-nums font-mono', overdue ? 'text-red font-semibold' : '')}>
                      Due: {String(t.due_date ?? 'No date')}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Revisions & Feedback Panel */}
        <Card
          title="Revisions & Feedback Rounds"
          action={<Link href="/revisions" className="text-[12px] text-accent hover:underline">All Revisions</Link>}
        >
          {revisionsQuery.isLoading && <Spinner />}
          {revisionsQuery.data && !revisionsQuery.data.length && (
            <p className="text-[13px] text-muted py-2">No pending revision rounds.</p>
          )}
          <ul className="divide-y divide-border">
            {revisionsQuery.data?.map((r) => {
              const deliverable = r.deliverable as { title?: string; client?: { brand_name?: string } } | null;
              return (
                <li key={String(r.id)} className="py-2 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/revisions/${String(r.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      Round #{String(r.round_no ?? 1)} · {String(deliverable?.title ?? 'Deliverable')}
                    </Link>
                    {Boolean(r.is_out_of_scope) && (
                      <span className="rounded bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber font-medium">
                        Out of Scope
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted line-clamp-2">
                    {r.notes != null ? String(r.notes) : 'No notes provided.'}
                  </p>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
