'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, Stat, StatusChip, Spinner, Empty } from '@/components/ui/primitives';

export default function PortalHome() {
  const q = useQuery({
    queryKey: ['portal', 'overview'],
    queryFn: async () => {
      const [deliverables, approvals, schedule, posts] = await Promise.all([
        supabase().from('v_portal_deliverables').select('*').order('due_date').limit(100),
        supabase().from('v_portal_approvals').select('*').eq('status', 'Pending').order('due_at'),
        supabase().from('v_portal_schedule').select('*').gte('on_date', new Date().toISOString().slice(0, 10)).order('on_date').limit(10),
        supabase().from('v_portal_content_calendar').select('*').gte('post_date', new Date().toISOString().slice(0, 10)).order('post_date').limit(10),
      ]);
      return {
        deliverables: (deliverables.data ?? []) as Record<string, unknown>[],
        approvals: (approvals.data ?? []) as Record<string, unknown>[],
        schedule: (schedule.data ?? []) as Record<string, unknown>[],
        posts: (posts.data ?? []) as Record<string, unknown>[],
      };
    },
  });

  if (q.isLoading) return <Spinner />;
  const d = q.data!;
  const open = d.deliverables.filter((x) => !['Delivered', 'Approved', 'Cancelled'].includes(String(x.status)));

  return (
    <div className="space-y-4">
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="In progress" value={open.length} />
        <Stat label="Waiting on your approval" value={d.approvals.length}
          tone={d.approvals.length > 0 ? 'warn' : undefined} />
        <Stat label="Posts scheduled" value={d.posts.length} />
        <Stat label="Upcoming sessions" value={d.schedule.length} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Waiting on you"
          action={<Link href="/portal/approvals" className="text-[12px] text-accent">Review</Link>}>
          {!d.approvals.length && <p className="text-[13px] text-muted">Nothing needs your approval right now.</p>}
          <ul className="divide-y divide-border">
            {d.approvals.map((a) => (
              <li key={String(a.id)} className="flex items-center justify-between py-1.5 text-[13px]">
                <span>Round {String(a.round_no)} · {String(a.entity_type).replace('_', ' ')}</span>
                <span className="text-[12px] text-muted">
                  due {a.due_at ? new Date(String(a.due_at)).toLocaleDateString() : '—'}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Next up"
          action={<Link href="/portal/schedule" className="text-[12px] text-accent">Full schedule</Link>}>
          {!d.schedule.length && <p className="text-[13px] text-muted">Nothing scheduled.</p>}
          <ul className="divide-y divide-border">
            {d.schedule.map((s) => (
              <li key={String(s.id)} className="flex items-center justify-between py-1.5 text-[13px]">
                <span className="truncate">{String(s.title)}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-muted">{String(s.on_date)}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Deliverables" className="lg:col-span-2"
          action={<Link href="/portal/deliverables" className="text-[12px] text-accent">All</Link>}>
          {!open.length && <Empty title="Nothing in progress" />}
          <ul className="divide-y divide-border">
            {open.slice(0, 8).map((x) => (
              <li key={String(x.id)} className="flex items-center justify-between py-1.5 text-[13px]">
                <span className="truncate">{String(x.title)}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusChip value={String(x.status)} />
                  <span className="tabular-nums text-[12px] text-muted">{String(x.due_date ?? '')}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
