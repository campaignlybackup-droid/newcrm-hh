'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Card, Stat, Spinner, StatusChip, HealthDot, Empty } from '@/components/ui/primitives';
import { TeamLoadHeatmap } from '@/components/dashboards/TeamLoadHeatmap';
import { MyQueue } from '@/components/dashboards/MyQueue';
import { cn } from '@/lib/utils';

/**
 * Role-based dashboards.
 *
 * Every panel below queries the same tables for everyone. What differs is
 * what comes back, because RLS filters it — a manager's "overdue" count is
 * their subtree's, a founder's is the whole agency's. Nothing here branches
 * on role to hide data; the role only decides which PANELS are worth showing.
 */
export default function DashboardPage() {
  const { data: session } = useSession();
  const level = session?.role.level ?? 99;

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => {
      const { data, error } = await supabase().rpc('dashboard_summary');
      if (error) throw error;
      return data as unknown as Record<string, number | unknown>;
    },
  });

  if (!session) return <Spinner />;
  const s = summary.data ?? {};

  const isLeadership = level <= 1;
  const isManagement = level <= 3;
  const isExecutor = level >= 4;

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">
          {greeting()}, {session.user.full_name.split(' ')[0]}
        </h1>
        <p className="text-[13px] text-muted">
          {session.role.name}
          {session.department.name ? ` · ${session.department.name}` : ''}
          {' · '}showing everything your access covers
        </p>
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="My tasks today" value={Number(s.my_tasks_today ?? 0)} />
        <Stat label="My overdue" value={Number(s.my_tasks_overdue ?? 0)}
          tone={Number(s.my_tasks_overdue ?? 0) > 0 ? 'bad' : undefined} />
        <Stat label="Approvals on me" value={Number(s.approvals_waiting_on_me ?? 0)}
          tone={Number(s.approvals_waiting_on_me ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Shoots next 7 days" value={Number(s.shoots_next_7 ?? 0)} />
      </div>

      {isManagement && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Deliverables due this week" value={Number(s.deliverables_due_this_week ?? 0)} />
          <Stat label="Overdue tasks" value={Number(s.overdue_tasks ?? 0)}
            tone={Number(s.overdue_tasks ?? 0) > 0 ? 'bad' : 'good'} />
          <Stat label="Posts going live (7d)" value={Number(s.posts_next_7 ?? 0)} />
          <Stat label="On-time delivery (90d)"
            value={s.on_time_delivery_pct != null ? `${s.on_time_delivery_pct}%` : '—'}
            tone={Number(s.on_time_delivery_pct ?? 0) >= 90 ? 'good' : 'warn'}
            hint="Delivered on or before the due date" />
        </div>
      )}

      {isLeadership && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Clients not green" value={Number(s.clients_at_risk ?? 0)}
            tone={Number(s.clients_at_risk ?? 0) > 0 ? 'warn' : 'good'} />
          <Stat label="Renewals in 60 days" value={Number(s.renewals_in_60 ?? 0)} hint="Alerts fire at 60/30/15/7" />
          <Stat label="Approvals pending" value={Number(s.approvals_pending ?? 0)} />
          <Stat label="Overdue by department"
            value={Array.isArray(s.overdue_by_department) ? (s.overdue_by_department as unknown[]).length : 0}
            hint="departments with slippage" />
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {isExecutor && <MyQueue />}
        {isManagement && <ClientHealthGrid />}
        {isManagement && <TeamLoadHeatmap />}
        {isManagement && <ApprovalsWaiting />}
        {isLeadership && <OverdueByDepartment rows={(s.overdue_by_department ?? []) as { department: string; overdue: number }[]} />}
        {isLeadership && <LeadPipeline rows={(s.lead_pipeline ?? []) as { stage: string; count: number; overdue_actions: number }[]} />}
        <ShootSchedule />
      </div>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function ClientHealthGrid() {
  const q = useQuery({
    queryKey: ['dashboard', 'client_health'],
    queryFn: async () => {
      const { data, error } = await supabase().from('v_client_health_grid')
        .select('*').order('health').limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card title="Client health" action={<Link href="/clients" className="text-[12px] text-accent">All clients</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <Empty title="No clients in your scope" />}
      <ul className="divide-y divide-border">
        {q.data?.map((c) => (
          <li key={String(c.client_id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <Link href={`/clients/${String(c.client_id)}`} className="truncate hover:text-accent">
              {String(c.brand_name)}
            </Link>
            <span className="flex shrink-0 items-center gap-3 text-[12px] text-muted">
              {Number(c.overdue_deliverables) > 0 && (
                <span className="text-red">{String(c.overdue_deliverables)} overdue</span>
              )}
              {Number(c.pending_approvals) > 0 && <span>{String(c.pending_approvals)} approvals</span>}
              {c.days_to_renewal != null && Number(c.days_to_renewal) <= 60 && (
                <span className="text-amber">renews in {String(c.days_to_renewal)}d</span>
              )}
              <HealthDot value={String(c.health)} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ApprovalsWaiting() {
  const q = useQuery({
    queryKey: ['dashboard', 'approvals'],
    queryFn: async () => {
      const { data, error } = await supabase().from('approvals')
        .select('*, client:clients(brand_name), approver:users!approvals_approver_id_fkey(full_name)')
        .eq('status', 'Pending').is('deleted_at', null)
        .order('due_at', { ascending: true }).limit(20);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card title="Approvals pending" action={<Link href="/approvals" className="text-[12px] text-accent">All</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="text-[13px] text-muted">Nothing waiting.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((a) => {
          const overdue = a.due_at != null && new Date(String(a.due_at)) < new Date();
          return (
            <li key={String(a.id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
              <span className="truncate">
                {String((a.client as { brand_name?: string })?.brand_name ?? '—')}
                <span className="text-muted"> · {String(a.level)} · round {String(a.round_no)}</span>
              </span>
              <span className={cn('shrink-0 text-[12px] tabular-nums', overdue ? 'text-red' : 'text-muted')}>
                {a.due_at ? new Date(String(a.due_at)).toLocaleDateString() : '—'}
                {overdue && ' · escalating'}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ShootSchedule() {
  const q = useQuery({
    queryKey: ['dashboard', 'shoots'],
    queryFn: async () => {
      const { data, error } = await supabase().from('shoots')
        .select('*, client:clients(brand_name)')
        .gte('shoot_date', new Date().toISOString().slice(0, 10))
        .neq('status', 'Cancelled').is('deleted_at', null)
        .order('shoot_date').limit(15);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card title="Upcoming shoots" action={<Link href="/shoots" className="text-[12px] text-accent">All</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="text-[13px] text-muted">No shoots scheduled.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((s) => (
          <li key={String(s.id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <Link href={`/shoots/${String(s.id)}`} className="truncate hover:text-accent">
              {String(s.title)}
              <span className="text-muted"> · {String((s.client as { brand_name?: string })?.brand_name ?? '')}</span>
            </Link>
            <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
              <span className="tabular-nums">{String(s.shoot_date)}</span>
              {s.call_time != null && <span className="tabular-nums">{String(s.call_time).slice(0, 5)}</span>}
              <StatusChip value={String(s.status)} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OverdueByDepartment({ rows }: { rows: { department: string; overdue: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.overdue));
  return (
    <Card title="Overdue by department">
      {!rows.length && <p className="text-[13px] text-muted">Nothing overdue.</p>}
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.department} className="text-[13px]">
            <div className="flex justify-between"><span>{r.department}</span>
              <span className="tabular-nums text-muted">{r.overdue}</span></div>
            <div className="mt-0.5 h-1.5 rounded bg-raised">
              <div className="h-1.5 rounded bg-red" style={{ width: `${(r.overdue / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LeadPipeline({ rows }: { rows: { stage: string; count: number; overdue_actions: number }[] }) {
  return (
    <Card title="Lead pipeline" action={<Link href="/leads" className="text-[12px] text-accent">All leads</Link>}>
      {!rows.length && <p className="text-[13px] text-muted">No open leads.</p>}
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.stage} className="flex items-center justify-between py-1.5 text-[13px]">
            <StatusChip value={r.stage} />
            <span className="flex items-center gap-3 text-[12px]">
              {r.overdue_actions > 0 && <span className="text-red">{r.overdue_actions} follow-ups overdue</span>}
              <span className="tabular-nums text-muted">{r.count}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
