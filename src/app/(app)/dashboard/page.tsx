'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Card, Stat, Spinner, StatusChip, HealthDot, Empty } from '@/components/ui/primitives';
import { TeamLoadHeatmap } from '@/components/dashboards/TeamLoadHeatmap';
import { MyQueue } from '@/components/dashboards/MyQueue';
import { EditorQueue } from '@/components/dashboards/EditorQueue';
import { SocialMediaStream } from '@/components/dashboards/SocialMediaStream';
import { cn } from '@/lib/utils';

type ViewTab = 'auto' | 'overview' | 'editor' | 'social' | 'management';

export default function DashboardPage() {
  const { data: session, isLoading: sessionLoading, error: sessionError } = useSession();
  const [activeTab, setActiveTab] = useState<ViewTab>('auto');
  const level = session?.role?.level ?? 99;
  const roleCode = session?.role?.code ?? '';

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    enabled: Boolean(session?.authenticated),
    queryFn: async () => {
      const { data, error } = await supabase().rpc('dashboard_summary');
      if (error) throw error;
      return data as unknown as Record<string, number | unknown>;
    },
  });

  if (sessionLoading) return <Spinner label="Loading context…" />;

  if (sessionError || !session || !session.authenticated) {
    return (
      <div className="p-6">
        <Card title="Database Setup Required">
          <div className="space-y-3 p-2 text-xs text-muted">
            <p className="text-sm font-medium text-foreground">
              Connected to Supabase, but the database tables (`public.users`, `public.roles`, etc.) have not been created yet on your cloud project.
            </p>
            <p>
              Run this single command in your computer terminal to build all 64 tables and RLS security rules:
            </p>
            <pre className="rounded bg-raised p-3 font-mono text-[11px] text-accent select-all">
              npx supabase login{'\n'}
              npx supabase link --project-ref bsqzzlbpavmdkwstjbyq{'\n'}
              npx supabase db push
            </pre>
            {sessionError && <p className="text-red font-mono">{String(sessionError)}</p>}
          </div>
        </Card>
      </div>
    );
  }
  const s = summary.data ?? {};

  const isLeadership = level <= 1;
  const isManagement = level <= 3;
  const isExecutor = level >= 4;

  const isEditorRole = ['EDIT_LEAD', 'VIDEO_EDITOR', 'GRAPHIC_DESIGNER', 'MOTION_DESIGNER', 'DOP', 'CAMERA_ASSISTANT'].includes(roleCode);
  const isSocialRole = ['CONTENT_LEAD', 'SOCIAL_EXECUTIVE', 'SOCIAL_MANAGER'].includes(roleCode);

  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h1 className="text-lg font-semibold">
            {greeting()}, {session.user.full_name.split(' ')[0]}
          </h1>
          <p className="text-[13px] text-muted">
            {session.role.name}
            {session.department.name ? ` · ${session.department.name}` : ''}
            {' · '}showing role-tailored workspace
          </p>
        </div>

        {/* View Switcher for Leadership / Management */}
        {(isLeadership || isManagement) && (
          <div className="flex rounded-md border border-border bg-raised p-0.5 text-xs">
            <button
              onClick={() => setActiveTab('auto')}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'auto' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
            >
              Default
            </button>
            <button
              onClick={() => setActiveTab('overview')}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'overview' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
            >
              Leadership
            </button>
            <button
              onClick={() => setActiveTab('editor')}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'editor' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
            >
              Editing Suite
            </button>
            <button
              onClick={() => setActiveTab('social')}
              className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'social' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
            >
              Social Hub
            </button>
          </div>
        )}
      </header>

      {/* Top Stat Summary Grid */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="My tasks today" value={Number(s.my_tasks_today ?? 0)} />
        <Stat label="My overdue" value={Number(s.my_tasks_overdue ?? 0)}
          tone={Number(s.my_tasks_overdue ?? 0) > 0 ? 'bad' : undefined} />
        <Stat label="Approvals on me" value={Number(s.approvals_waiting_on_me ?? 0)}
          tone={Number(s.approvals_waiting_on_me ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Shoots next 7 days" value={Number(s.shoots_next_7 ?? 0)} />
      </div>

      {isManagement && (activeTab === 'auto' || activeTab === 'management' || activeTab === 'overview') && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Deliverables due this week" value={Number(s.deliverables_due_this_week ?? 0)} />
          <Stat label="Overdue tasks" value={Number(s.overdue_tasks ?? 0)}
            tone={Number(s.overdue_tasks ?? 0) > 0 ? 'bad' : 'good'} />
          <Stat label="Posts going live (7d)" value={Number(s.posts_next_7 ?? 0)} />
          <Stat label="On-time delivery (90d)"
            value={s.on_time_delivery_pct != null ? `${s.on_time_delivery_pct}%` : '—'}
            tone={Number(s.on_time_delivery_pct ?? 0) >= 90 ? 'good' : 'warn'}
            hint="Delivered on or before due date" />
        </div>
      )}

      {isLeadership && (activeTab === 'auto' || activeTab === 'overview') && (
        <>
          <FounderQuickNavigator />
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Clients not green" value={Number(s.clients_at_risk ?? 0)}
              tone={Number(s.clients_at_risk ?? 0) > 0 ? 'warn' : 'good'} />
            <Stat label="Renewals in 60 days" value={Number(s.renewals_in_60 ?? 0)} hint="Alerts fire at 60/30/15/7" />
            <Stat label="Approvals pending" value={Number(s.approvals_pending ?? 0)} />
            <Stat label="Overdue by department"
              value={Array.isArray(s.overdue_by_department) ? (s.overdue_by_department as unknown[]).length : 0}
              hint="departments with slippage" />
          </div>
        </>
      )}

      {/* Main Workspace Panels Grid */}
      <div className="grid gap-3 lg:grid-cols-2">
        {/* Render Workspace Based on Role Code or Selected Tab */}
        {(activeTab === 'editor' || (activeTab === 'auto' && isEditorRole)) && (
          <EditorQueue />
        )}

        {(activeTab === 'social' || (activeTab === 'auto' && isSocialRole)) && (
          <SocialMediaStream />
        )}

        {(activeTab === 'auto' && isExecutor && !isEditorRole && !isSocialRole) && (
          <MyQueue />
        )}

        {(activeTab === 'overview' || (activeTab === 'auto' && isLeadership)) && (
          <>
            <ClientHealthGrid />
            <TeamLoadHeatmap />
            <ApprovalsWaiting />
            <OverdueByDepartment rows={(s.overdue_by_department ?? []) as { department: string; overdue: number }[]} />
            <LeadPipeline rows={(s.lead_pipeline ?? []) as { stage: string; count: number; overdue_actions: number }[]} />
            <ShootSchedule />
          </>
        )}

        {(activeTab === 'auto' && isManagement && !isLeadership && !isEditorRole && !isSocialRole) && (
          <>
            <MyQueue />
            <ClientHealthGrid />
            <TeamLoadHeatmap />
            <ApprovalsWaiting />
            <ShootSchedule />
          </>
        )}
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
    <Card title="Client health" action={<Link href="/clients" className="text-[12px] text-accent hover:underline">All clients</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <Empty title="No clients in your scope" />}
      <ul className="divide-y divide-border">
        {q.data?.map((c) => (
          <li key={String(c.client_id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <Link href={`/clients/${String(c.client_id)}`} className="truncate hover:text-accent font-medium">
              {String(c.brand_name)}
            </Link>
            <span className="flex shrink-0 items-center gap-3 text-[12px] text-muted">
              {Number(c.overdue_deliverables) > 0 && (
                <span className="text-red font-medium">{String(c.overdue_deliverables)} overdue</span>
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
    <Card title="Approvals pending" action={<Link href="/approvals" className="text-[12px] text-accent hover:underline">All</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="text-[13px] text-muted py-2">Nothing waiting for approval.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((a) => {
          const overdue = a.due_at != null && new Date(String(a.due_at)) < new Date();
          return (
            <li key={String(a.id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
              <span className="truncate">
                {String((a.client as { brand_name?: string })?.brand_name ?? '—')}
                <span className="text-muted"> · level {String(a.level)} · round {String(a.round_no)}</span>
              </span>
              <span className={cn('shrink-0 text-[12px] tabular-nums', overdue ? 'text-red font-semibold' : 'text-muted')}>
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
    <Card title="Upcoming shoots" action={<Link href="/shoots" className="text-[12px] text-accent hover:underline">All</Link>}>
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <p className="text-[13px] text-muted py-2">No shoots scheduled.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((s) => (
          <li key={String(s.id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <Link href={`/shoots/${String(s.id)}`} className="truncate hover:text-accent font-medium">
              {String(s.title)}
              <span className="text-muted font-normal"> · {String((s.client as { brand_name?: string })?.brand_name ?? '')}</span>
            </Link>
            <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
              <span className="tabular-nums font-mono">{String(s.shoot_date)}</span>
              {s.call_time != null && <span className="tabular-nums font-mono">{String(s.call_time).slice(0, 5)}</span>}
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
      {!rows.length && <p className="text-[13px] text-muted py-2">Nothing overdue.</p>}
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
    <Card title="Lead pipeline" action={<Link href="/leads" className="text-[12px] text-accent hover:underline">All leads</Link>}>
      {!rows.length && <p className="text-[13px] text-muted py-2">No open leads.</p>}
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.stage} className="flex items-center justify-between py-1.5 text-[13px]">
            <StatusChip value={r.stage} />
            <span className="flex items-center gap-3 text-[12px]">
              {r.overdue_actions > 0 && <span className="text-red font-medium">{r.overdue_actions} follow-ups overdue</span>}
              <span className="tabular-nums text-muted">{r.count}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FounderQuickNavigator() {
  const links = [
    { label: 'Clients Master', href: '/clients', icon: '🏢' },
    { label: 'Leads & CRM', href: '/leads', icon: '🎯' },
    { label: 'Projects', href: '/projects', icon: '📁' },
    { label: 'Deliverables', href: '/deliverables', icon: '📦' },
    { label: 'All Tasks', href: '/tasks', icon: '⚡' },
    { label: 'Shoots & Crew', href: '/shoots', icon: '🎬' },
    { label: 'Content Calendar', href: '/content_calendar', icon: '📱' },
    { label: 'Approvals', href: '/approvals', icon: '✅' },
    { label: 'Asset Library', href: '/assets', icon: '🗂️' },
    { label: 'Team Availability', href: '/leave_requests', icon: '👥' },
    { label: 'Roles & Matrix', href: '/settings/roles', icon: '🛡️' },
    { label: 'Recycle Bin', href: '/settings/recycle-bin', icon: '🗑️' },
    { label: 'Audit Logs', href: '/settings/audit', icon: '📜' },
  ];

  return (
    <div className="rounded-lg border border-border bg-surface p-3.5 shadow-xs">
      <div className="flex items-center justify-between border-b border-border/60 pb-2 mb-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted flex items-center gap-1.5">
          <span>👑</span> Founder Operations Quick Access
        </span>
        <span className="text-[11px] text-muted">1-click access to every agency module & control</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent hover:bg-surface"
          >
            <span>{l.icon}</span>
            <span>{l.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
