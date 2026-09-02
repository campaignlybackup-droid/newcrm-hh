'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Card, StatusChip, Spinner, Empty, Avatar, Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

interface ClientProjectSuiteProps {
  clientId: string;
  clientName: string;
}

type SuiteTab = 'overview' | 'deliverables_tasks' | 'shoots' | 'social_calendar' | 'meetings';

export function ClientProjectSuite({ clientId, clientName }: ClientProjectSuiteProps) {
  const [activeTab, setActiveTab] = useState<SuiteTab>('overview');

  // Query 1: Client Projects & Deliverables
  const projectsQuery = useQuery({
    queryKey: ['client_suite_projects', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('projects')
        .select('*, deliverables(*), tasks(*)')
        .eq('client_id', clientId)
        .is('deleted_at', null);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 2: Client Tasks (Direct & Deliverable Tasks)
  const tasksQuery = useQuery({
    queryKey: ['client_suite_tasks', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('tasks')
        .select('*, assignee:users!tasks_assignee_id_fkey(full_name, avatar_url)')
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('due_date', { ascending: true })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 3: Client Shoots
  const shootsQuery = useQuery({
    queryKey: ['client_suite_shoots', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('shoots')
        .select('*')
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('shoot_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 4: Client Social Content Calendar
  const calendarQuery = useQuery({
    queryKey: ['client_suite_calendar', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('content_calendar')
        .select('*')
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('post_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  // Query 5: Meetings & Contacts
  const meetingsQuery = useQuery({
    queryKey: ['client_suite_meetings', clientId],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('meetings')
        .select('*')
        .eq('client_id', clientId)
        .is('deleted_at', null)
        .order('starts_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <span>🚀</span> {clientName} — Unified Project Workspace
          </h2>
          <p className="text-xs text-muted">
            All project deliverables, task schedules, shoot productions, and social publishing streams for this client.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex flex-wrap rounded-md border border-border bg-raised p-0.5 text-xs">
          <button
            onClick={() => setActiveTab('overview')}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'overview' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('deliverables_tasks')}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'deliverables_tasks' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
          >
            Tasks &amp; Deliverables
          </button>
          <button
            onClick={() => setActiveTab('shoots')}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'shoots' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
          >
            Shoots ({shootsQuery.data?.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('social_calendar')}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'social_calendar' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
          >
            Social Stream ({calendarQuery.data?.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('meetings')}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', activeTab === 'meetings' ? 'bg-surface text-foreground shadow-xs' : 'text-muted hover:text-foreground')}
          >
            Meetings
          </button>
        </div>
      </div>

      {/* Tab 1: Overview */}
      {activeTab === 'overview' && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Projects & Retainer Containers">
            {projectsQuery.isLoading && <Spinner />}
            {projectsQuery.data && !projectsQuery.data.length && <Empty title="No projects found" />}
            <ul className="divide-y divide-border">
              {projectsQuery.data?.map((p) => (
                <li key={String(p.id)} className="py-2 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/projects/${String(p.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      {String(p.name)}
                    </Link>
                    <StatusChip value={String(p.status ?? 'Active')} />
                  </div>
                  <p className="text-[11px] text-muted font-mono mt-0.5">Code: {String(p.code)}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Upcoming Deliverables">
            {tasksQuery.isLoading && <Spinner />}
            <ul className="divide-y divide-border">
              {tasksQuery.data?.slice(0, 5).map((t) => (
                <li key={String(t.id)} className="py-2 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/tasks/${String(t.id)}`} className="font-medium text-foreground hover:text-accent truncate">
                      {String(t.title)}
                    </Link>
                    <StatusChip value={String(t.status)} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Assignee: {String((t.assignee as { full_name?: string })?.full_name ?? 'Unassigned')}</span>
                    <span className="font-mono tabular-nums">{String(t.due_date ?? 'No date')}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Production & Publishing Summary">
            <div className="space-y-3 p-1 text-xs">
              <div className="flex justify-between items-center border-b border-border pb-2">
                <span className="text-muted">Total Shoots Scheduled:</span>
                <span className="font-mono font-semibold">{shootsQuery.data?.length ?? 0}</span>
              </div>
              <div className="flex justify-between items-center border-b border-border pb-2">
                <span className="text-muted">Social Calendar Posts:</span>
                <span className="font-mono font-semibold">{calendarQuery.data?.length ?? 0}</span>
              </div>
              <div className="flex justify-between items-center border-b border-border pb-2">
                <span className="text-muted">Client Meetings Logged:</span>
                <span className="font-mono font-semibold">{meetingsQuery.data?.length ?? 0}</span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-muted">Active Tasks Count:</span>
                <span className="font-mono font-semibold text-accent">{tasksQuery.data?.length ?? 0}</span>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Tab 2: Deliverables & Tasks */}
      {activeTab === 'deliverables_tasks' && (
        <Card title={`All Tasks & Deliverables for ${clientName}`}>
          {tasksQuery.isLoading && <Spinner />}
          {tasksQuery.data && !tasksQuery.data.length && <Empty title="No tasks created for this client yet" />}
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="py-2 px-2">Task Title</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Assignee</th>
                  <th className="py-2 px-2">Priority</th>
                  <th className="py-2 px-2">Due Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tasksQuery.data?.map((t) => (
                  <tr key={String(t.id)} className="hover:bg-raised/50">
                    <td className="py-2 px-2">
                      <Link href={`/tasks/${String(t.id)}`} className="font-medium text-foreground hover:text-accent">
                        {String(t.title)}
                      </Link>
                    </td>
                    <td className="py-2 px-2"><StatusChip value={String(t.status)} /></td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5">
                        <Avatar name={String((t.assignee as { full_name?: string })?.full_name ?? '—')} size={18} />
                        <span>{String((t.assignee as { full_name?: string })?.full_name ?? 'Unassigned')}</span>
                      </div>
                    </td>
                    <td className="py-2 px-2"><StatusChip value={String(t.priority ?? 'Medium')} /></td>
                    <td className="py-2 px-2 font-mono tabular-nums text-muted">{String(t.due_date ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Tab 3: Shoots */}
      {activeTab === 'shoots' && (
        <Card title={`Shoots Production for ${clientName}`}>
          {shootsQuery.isLoading && <Spinner />}
          {shootsQuery.data && !shootsQuery.data.length && <Empty title="No shoots scheduled for this client" />}
          <ul className="divide-y divide-border">
            {shootsQuery.data?.map((s) => (
              <li key={String(s.id)} className="py-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/shoots/${String(s.id)}`} className="font-medium text-foreground hover:text-accent">
                    🎬 {String(s.title)}
                  </Link>
                  <StatusChip value={String(s.status)} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted font-mono">
                  <span>Shoot Date: {String(s.shoot_date)}</span>
                  {s.call_time != null && <span>Call Time: {String(s.call_time).slice(0, 5)}</span>}
                  {s.location != null && <span>Location: {String(s.location)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Tab 4: Social Content Calendar */}
      {activeTab === 'social_calendar' && (
        <Card title={`Social Media Publishing Stream for ${clientName}`}>
          {calendarQuery.isLoading && <Spinner />}
          {calendarQuery.data && !calendarQuery.data.length && <Empty title="No social calendar posts scheduled" />}
          <ul className="divide-y divide-border">
            {calendarQuery.data?.map((c) => (
              <li key={String(c.id)} className="py-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    📱 {String(c.title)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {c.platform != null && <StatusChip value={String(c.platform)} />}
                    <StatusChip value={String(c.status ?? 'Draft')} />
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
                  <span className="font-mono">Post Date: {String(c.post_date ?? 'Unscheduled')}</span>
                  {c.caption != null && <span className="truncate max-w-[300px]">Caption: {String(c.caption)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Tab 5: Meetings */}
      {activeTab === 'meetings' && (
        <Card title={`Client Meetings & Reviews for ${clientName}`}>
          {meetingsQuery.isLoading && <Spinner />}
          {meetingsQuery.data && !meetingsQuery.data.length && <Empty title="No client meetings logged" />}
          <ul className="divide-y divide-border">
            {meetingsQuery.data?.map((m) => (
              <li key={String(m.id)} className="py-2.5 text-[13px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    🤝 {String(m.title)}
                  </span>
                  <span className="text-[11px] font-mono text-muted">
                    {m.starts_at ? new Date(String(m.starts_at)).toLocaleString() : '—'}
                  </span>
                </div>
                {m.agenda != null && <p className="mt-1 text-[11px] text-muted">{String(m.agenda)}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
