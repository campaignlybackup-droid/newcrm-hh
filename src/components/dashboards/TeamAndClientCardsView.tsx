'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner, StatusChip, HealthDot, Avatar, Button } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import { cn } from '@/lib/utils';

interface TeamMemberRow {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  status: string;
  timezone: string;
  weekly_capacity_hours: number;
  role: { name: string; code: string; level: number } | null;
  department: { name: string } | null;
  manager: { id: string; full_name: string } | null;
  clients: { client_id: string; brand_name: string; role_on_account: string }[];
  active_tasks_count: number;
  overdue_tasks_count: number;
  last_activity: { action: string; entity_type: string; changed_at: string; details?: string } | null;
}

interface ClientRow {
  id: string;
  brand_name: string;
  legal_name: string;
  client_code: string;
  industry: string | null;
  city: string | null;
  timezone: string;
  status: string;
  health: string;
  priority: string;
  contract_start_date: string | null;
  contract_end_date: string | null;
  renewal_date: string | null;
  service_tags: string[] | null;
  account_manager: { id: string; full_name: string; avatar_url: string | null } | null;
  team_members: { user_id: string; full_name: string; role_on_account: string; avatar_url: string | null }[];
  active_deliverables_count: number;
  pending_approvals_count: number;
  last_activity: { action: string; entity_type: string; changed_at: string } | null;
}

export function TeamAndClientCardsView() {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<'team' | 'clients'>('team');
  const [search, setSearch] = useState('');

  // Editing state for Founder Nimit
  const [editingMember, setEditingMember] = useState<TeamMemberRow | null>(null);
  const [editingClient, setEditingClient] = useState<ClientRow | null>(null);

  // Form states for Team Member Edit Modal
  const [newManagerId, setNewManagerId] = useState<string>('');
  const [newClientAssign, setNewClientAssign] = useState<{ clientId: string; roleOnAccount: string }>({ clientId: '', roleOnAccount: 'Team Member' });

  // Form states for Client Edit Modal
  const [newAccountManagerId, setNewAccountManagerId] = useState<string>('');
  const [newMemberAssign, setNewMemberAssign] = useState<{ userId: string; roleOnAccount: string }>({ userId: '', roleOnAccount: 'Executive' });

  // 1. Fetch All Team Members with rich details
  const teamQuery = useQuery({
    queryKey: ['founder_team_cards'],
    queryFn: async () => {
      const { data: users, error: uErr } = await supabase()
        .from('users')
        .select(`
          id, full_name, email, phone, status, timezone, weekly_capacity_hours,
          role:roles(name, code, level),
          department:departments(name),
          manager:users!users_manager_id_fkey(id, full_name)
        `)
        .is('deleted_at', null)
        .order('full_name');

      if (uErr) throw uErr;

      const { data: clientMembers } = await supabase()
        .from('client_team_members')
        .select('user_id, client_id, role_on_account, client:clients(id, brand_name)');

      const { data: tasks } = await supabase()
        .from('tasks')
        .select('assignee_id, status, due_date')
        .is('deleted_at', null);

      const { data: logs } = await supabase()
        .from('activity_log')
        .select('actor_id, action, entity_type, changed_at')
        .order('changed_at', { ascending: false })
        .limit(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (users ?? []).map((u: any) => {
        const uId = String(u.id);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assignedClients = (clientMembers ?? [])
          .filter((cm: any) => String(cm.user_id) === uId && cm.client)
          .map((cm: any) => ({
            client_id: String(cm.client.id),
            brand_name: String(cm.client.brand_name),
            role_on_account: String(cm.role_on_account ?? 'Member'),
          }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userTasks = (tasks ?? []).filter((t: any) => String(t.assignee_id) === uId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const activeTasks = userTasks.filter((t: any) => !['Delivered', 'Approved', 'Cancelled', 'Done'].includes(String(t.status)));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const overdueTasks = activeTasks.filter((t: any) => t.due_date && new Date(String(t.due_date)) < new Date());

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userLog = (logs ?? []).find((l: any) => String(l.actor_id) === uId);

        const mgr = Array.isArray(u.manager) ? u.manager[0] : u.manager;
        const rCode = Array.isArray(u.role) ? u.role[0] : u.role;
        const dDept = Array.isArray(u.department) ? u.department[0] : u.department;

        return {
          id: uId,
          full_name: String(u.full_name ?? 'Unnamed'),
          email: String(u.email ?? ''),
          phone: u.phone ? String(u.phone) : null,
          status: String(u.status ?? 'Active'),
          timezone: String(u.timezone ?? 'Asia/Dubai'),
          weekly_capacity_hours: Number(u.weekly_capacity_hours ?? 40),
          role: rCode ? { name: String(rCode.name), code: String(rCode.code), level: Number(rCode.level) } : null,
          department: dDept ? { name: String(dDept.name) } : null,
          manager: mgr ? { id: String(mgr.id), full_name: String(mgr.full_name) } : null,
          clients: assignedClients,
          active_tasks_count: activeTasks.length,
          overdue_tasks_count: overdueTasks.length,
          last_activity: userLog
            ? {
                action: String(userLog.action ?? 'Activity'),
                entity_type: String(userLog.entity_type ?? 'Record'),
                changed_at: String(userLog.changed_at),
              }
            : null,
        } as TeamMemberRow;
      });
    },
  });

  // 2. Fetch All Clients with rich details
  const clientsQuery = useQuery({
    queryKey: ['founder_client_cards'],
    queryFn: async () => {
      const { data: clients, error: cErr } = await supabase()
        .from('clients')
        .select(`
          id, brand_name, legal_name, client_code, industry, city, timezone,
          status, health, priority, contract_start_date, contract_end_date, renewal_date, service_tags,
          account_manager:users!clients_account_manager_id_fkey(id, full_name, avatar_url)
        `)
        .is('deleted_at', null)
        .order('brand_name');

      if (cErr) throw cErr;

      const { data: teamRoster } = await supabase()
        .from('client_team_members')
        .select('client_id, user_id, role_on_account, user:users!client_team_members_user_id_fkey(id, full_name, avatar_url)');

      const { data: deliverables } = await supabase()
        .from('deliverables')
        .select('client_id, status')
        .is('deleted_at', null);

      const { data: logs } = await supabase()
        .from('activity_log')
        .select('client_id, action, entity_type, changed_at')
        .order('changed_at', { ascending: false })
        .limit(300);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (clients ?? []).map((c: any) => {
        const cId = String(c.id);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const roster = (teamRoster ?? [])
          .filter((tm: any) => String(tm.client_id) === cId && tm.user)
          .map((tm: any) => {
            const uObj = Array.isArray(tm.user) ? tm.user[0] : tm.user;
            return {
              user_id: String(uObj.id),
              full_name: String(uObj.full_name),
              role_on_account: String(tm.role_on_account ?? 'Team Member'),
              avatar_url: uObj.avatar_url ? String(uObj.avatar_url) : null,
            };
          });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const activeDelivs = (deliverables ?? []).filter((d: any) => String(d.client_id) === cId && !['Delivered', 'Approved'].includes(String(d.status)));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pendingAppr = (deliverables ?? []).filter((d: any) => String(d.client_id) === cId && String(d.status).includes('Review'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clientLog = (logs ?? []).find((l: any) => String(l.client_id) === cId);

        const amObj = Array.isArray(c.account_manager) ? c.account_manager[0] : c.account_manager;

        return {
          id: cId,
          brand_name: String(c.brand_name ?? 'Unnamed Client'),
          legal_name: String(c.legal_name ?? ''),
          client_code: String(c.client_code ?? 'CL-00'),
          industry: c.industry ? String(c.industry) : null,
          city: c.city ? String(c.city) : null,
          timezone: String(c.timezone ?? 'Asia/Dubai'),
          status: String(c.status ?? 'Active'),
          health: String(c.health ?? 'Green'),
          priority: String(c.priority ?? 'Medium'),
          contract_start_date: c.contract_start_date ? String(c.contract_start_date) : null,
          contract_end_date: c.contract_end_date ? String(c.contract_end_date) : null,
          renewal_date: c.renewal_date ? String(c.renewal_date) : null,
          service_tags: Array.isArray(c.service_tags) ? (c.service_tags as string[]) : null,
          account_manager: amObj
            ? {
                id: String(amObj.id),
                full_name: String(amObj.full_name),
                avatar_url: amObj.avatar_url ? String(amObj.avatar_url) : null,
              }
            : null,
          team_members: roster,
          active_deliverables_count: activeDelivs.length,
          pending_approvals_count: pendingAppr.length,
          last_activity: clientLog
            ? {
                action: String(clientLog.action ?? 'Activity'),
                entity_type: String(clientLog.entity_type ?? 'Record'),
                changed_at: String(clientLog.changed_at),
              }
            : null,
        } as ClientRow;
      });
    },
  });

  // 3. Mutations for Founder Nimit
  const updateMemberMutation = useMutation({
    mutationFn: async ({ memberId, managerId }: { memberId: string; managerId: string | null }) => {
      const { error } = await supabase()
        .from('users')
        .update({ manager_id: managerId })
        .eq('id', memberId);
      if (error) throw error;
    },
    onSuccess: () => {
      pushToast('Team member manager updated');
      queryClient.invalidateQueries({ queryKey: ['founder_team_cards'] });
      setEditingMember(null);
    },
    onError: (err) => pushToast(err instanceof Error ? err.message : 'Update failed', 'error'),
  });

  const assignClientMutation = useMutation({
    mutationFn: async ({ memberId, clientId, roleOnAccount }: { memberId: string; clientId: string; roleOnAccount: string }) => {
      const { error } = await supabase()
        .from('client_team_members')
        .upsert({ client_id: clientId, user_id: memberId, role_on_account: roleOnAccount });
      if (error) throw error;
    },
    onSuccess: () => {
      pushToast('Client assigned to team member');
      queryClient.invalidateQueries({ queryKey: ['founder_team_cards'] });
      queryClient.invalidateQueries({ queryKey: ['founder_client_cards'] });
    },
    onError: (err) => pushToast(err instanceof Error ? err.message : 'Assignment failed', 'error'),
  });

  const updateClientAccountManagerMutation = useMutation({
    mutationFn: async ({ clientId, accountManagerId }: { clientId: string; accountManagerId: string }) => {
      const { error } = await supabase()
        .from('clients')
        .update({ account_manager_id: accountManagerId })
        .eq('id', clientId);
      if (error) throw error;
    },
    onSuccess: () => {
      pushToast('Account Manager updated');
      queryClient.invalidateQueries({ queryKey: ['founder_client_cards'] });
      queryClient.invalidateQueries({ queryKey: ['founder_team_cards'] });
      setEditingClient(null);
    },
    onError: (err) => pushToast(err instanceof Error ? err.message : 'Update failed', 'error'),
  });

  const isLoading = teamQuery.isLoading || clientsQuery.isLoading;

  const teamList = (teamQuery.data ?? []).filter((m) =>
    search ? m.full_name.toLowerCase().includes(search.toLowerCase()) || m.email.toLowerCase().includes(search.toLowerCase()) || (m.role?.name ?? '').toLowerCase().includes(search.toLowerCase()) : true,
  );

  const clientList = (clientsQuery.data ?? []).filter((c) =>
    search ? c.brand_name.toLowerCase().includes(search.toLowerCase()) || c.legal_name.toLowerCase().includes(search.toLowerCase()) || (c.account_manager?.full_name ?? '').toLowerCase().includes(search.toLowerCase()) : true,
  );

  return (
    <Card className="col-span-full border border-border shadow-md">
      {/* Top Header & View Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <span>👑</span> Founder Operations: Team &amp; Client Command Hub
          </h2>
          <p className="text-[12px] text-muted">
            Comprehensive 360° view of team activity logs, assigned client accounts, and live workload controls.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Search team or clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-border bg-raised/50 px-2.5 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />

          <div className="flex rounded-md border border-border bg-raised p-0.5 text-xs">
            <button
              onClick={() => setSubTab('team')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                subTab === 'team' ? 'bg-accent text-white shadow-xs' : 'text-muted hover:text-foreground',
              )}
            >
              👥 Team Cards ({teamQuery.data?.length ?? 0})
            </button>
            <button
              onClick={() => setSubTab('clients')}
              className={cn(
                'rounded px-3 py-1 font-medium transition-colors',
                subTab === 'clients' ? 'bg-accent text-white shadow-xs' : 'text-muted hover:text-foreground',
              )}
            >
              🏢 Client Cards ({clientsQuery.data?.length ?? 0})
            </button>
          </div>
        </div>
      </div>

      {isLoading && <div className="p-8 flex justify-center"><Spinner label="Loading operational cards..." /></div>}

      {/* SUBTAB 1: TEAM MEMBER CARDS */}
      {subTab === 'team' && !isLoading && (
        <div className="grid gap-3.5 pt-3 sm:grid-cols-2 lg:grid-cols-3">
          {teamList.map((m) => (
            <div
              key={m.id}
              className="flex flex-col justify-between rounded-xl border border-border bg-surface p-4 shadow-xs transition-all hover:border-accent/50 hover:shadow-sm"
            >
              <div className="space-y-3">
                {/* Header Profile Info */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={m.full_name} size={28} />
                    <div>
                      <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                        {m.full_name}
                      </h3>
                      <p className="text-[11px] text-muted truncate">{m.email}</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent border border-accent/20">
                    {m.role?.name ?? 'Member'}
                  </span>
                </div>

                {/* Meta details */}
                <div className="grid grid-cols-2 gap-2 text-[11px] bg-raised/40 p-2 rounded-lg border border-border/40">
                  <div>
                    <span className="text-muted">Department:</span>{' '}
                    <span className="font-medium text-foreground">{m.department?.name ?? 'General'}</span>
                  </div>
                  <div>
                    <span className="text-muted">Reports To:</span>{' '}
                    <span className="font-medium text-foreground">{m.manager?.full_name ?? 'Nimit (Founder)'}</span>
                  </div>
                  <div>
                    <span className="text-muted">Active Tasks:</span>{' '}
                    <span className={cn('font-semibold', m.overdue_tasks_count > 0 ? 'text-red' : 'text-foreground')}>
                      {m.active_tasks_count} ({m.overdue_tasks_count} overdue)
                    </span>
                  </div>
                  <div>
                    <span className="text-muted">Capacity:</span>{' '}
                    <span className="font-medium text-foreground">{m.weekly_capacity_hours}h / week</span>
                  </div>
                </div>

                {/* Clients Working On */}
                <div>
                  <h4 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1.5 flex items-center justify-between">
                    <span>Working On ({m.clients.length} Clients)</span>
                  </h4>
                  {m.clients.length === 0 ? (
                    <p className="text-[11px] text-muted italic">No clients assigned</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {m.clients.map((c) => (
                        <Link
                          key={c.client_id}
                          href={`/clients/${c.client_id}`}
                          className="inline-flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent/10 hover:text-accent transition-colors border border-border/50"
                        >
                          <span className="font-semibold">{c.brand_name}</span>
                          <span className="text-[10px] text-muted">({c.role_on_account})</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>

                {/* Last Activity Log */}
                <div className="border-t border-border/60 pt-2 text-[11px]">
                  <span className="text-muted">Last Activity: </span>
                  {m.last_activity ? (
                    <span className="text-foreground font-medium">
                      {m.last_activity.action} on {m.last_activity.entity_type} · {formatRelativeTime(m.last_activity.changed_at)}
                    </span>
                  ) : (
                    <span className="text-muted italic">No recent log recorded</span>
                  )}
                </div>
              </div>

              {/* Founder Controls Footer */}
              <div className="mt-3.5 border-t border-border pt-2.5 flex items-center justify-between">
                <StatusChip value={m.status} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingMember(m);
                    setNewManagerId(m.manager?.id ?? '');
                  }}
                >
                  ✏️ Edit &amp; Assign
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SUBTAB 2: CLIENT CARDS */}
      {subTab === 'clients' && !isLoading && (
        <div className="grid gap-3.5 pt-3 sm:grid-cols-2 lg:grid-cols-3">
          {clientList.map((c) => (
            <div
              key={c.id}
              className="flex flex-col justify-between rounded-xl border border-border bg-surface p-4 shadow-xs transition-all hover:border-accent/50 hover:shadow-sm"
            >
              <div className="space-y-3">
                {/* Header Info */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <Link href={`/clients/${c.id}`} className="text-sm font-bold text-foreground hover:text-accent flex items-center gap-1.5">
                      {c.brand_name}
                      <HealthDot value={c.health} />
                    </Link>
                    <p className="text-[11px] text-muted">{c.legal_name} · {c.client_code}</p>
                  </div>
                  <StatusChip value={c.status} />
                </div>

                {/* Key Metrics */}
                <div className="grid grid-cols-2 gap-2 text-[11px] bg-raised/40 p-2 rounded-lg border border-border/40">
                  <div>
                    <span className="text-muted">Account Manager:</span>{' '}
                    <span className="font-semibold text-foreground">{c.account_manager?.full_name ?? 'Unassigned'}</span>
                  </div>
                  <div>
                    <span className="text-muted">Industry / City:</span>{' '}
                    <span className="font-medium text-foreground">{c.industry ?? 'General'} ({c.city ?? 'Dubai'})</span>
                  </div>
                  <div>
                    <span className="text-muted">Deliverables Active:</span>{' '}
                    <span className="font-semibold text-accent">{c.active_deliverables_count} in progress</span>
                  </div>
                  <div>
                    <span className="text-muted">Approvals Pending:</span>{' '}
                    <span className={cn('font-semibold', c.pending_approvals_count > 0 ? 'text-amber' : 'text-foreground')}>
                      {c.pending_approvals_count}
                    </span>
                  </div>
                </div>

                {/* Team Working On Client */}
                <div>
                  <h4 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-1.5">
                    Assigned Roster ({c.team_members.length} Members)
                  </h4>
                  {c.team_members.length === 0 ? (
                    <p className="text-[11px] text-muted italic">No team members assigned</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {c.team_members.map((tm) => (
                        <span
                          key={tm.user_id}
                          className="inline-flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] font-medium text-foreground border border-border/50"
                        >
                          <Avatar name={tm.full_name} size={18} />
                          <span>{tm.full_name}</span>
                          <span className="text-[10px] text-muted">({tm.role_on_account})</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Service Tags */}
                {c.service_tags && c.service_tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.service_tags.map((st) => (
                      <span key={st} className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        #{st}
                      </span>
                    ))}
                  </div>
                )}

                {/* Last Activity Log */}
                <div className="border-t border-border/60 pt-2 text-[11px]">
                  <span className="text-muted">Last Activity: </span>
                  {c.last_activity ? (
                    <span className="text-foreground font-medium">
                      {c.last_activity.action} on {c.last_activity.entity_type} · {formatRelativeTime(c.last_activity.changed_at)}
                    </span>
                  ) : (
                    <span className="text-muted italic">No recent log recorded</span>
                  )}
                </div>
              </div>

              {/* Founder Controls Footer */}
              <div className="mt-3.5 border-t border-border pt-2.5 flex items-center justify-between">
                <span className="text-[11px] text-muted">Priority: <strong className="text-foreground">{c.priority}</strong></span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingClient(c);
                    setNewAccountManagerId(c.account_manager?.id ?? '');
                  }}
                >
                  ⚙️ Manage Account
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* EDIT MODAL FOR TEAM MEMBER */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="text-base font-bold text-foreground">
                Edit &amp; Assign — {editingMember.full_name}
              </h3>
              <button onClick={() => setEditingMember(null)} className="text-muted hover:text-foreground">✕</button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-muted mb-1">Reports To (Manager):</label>
                <select
                  value={newManagerId}
                  onChange={(e) => setNewManagerId(e.target.value)}
                  className="w-full rounded-md border border-border bg-raised p-2 text-foreground"
                >
                  <option value="">Nimit (Founder / Direct)</option>
                  {(teamQuery.data ?? [])
                    .filter((u) => u.id !== editingMember.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>{u.full_name} ({u.role?.name ?? 'User'})</option>
                    ))}
                </select>
              </div>

              <div className="border-t border-border pt-3">
                <label className="block font-medium text-muted mb-1">Assign to Client Account:</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={newClientAssign.clientId}
                    onChange={(e) => setNewClientAssign({ ...newClientAssign, clientId: e.target.value })}
                    className="rounded-md border border-border bg-raised p-2 text-foreground"
                  >
                    <option value="">Select Client...</option>
                    {(clientsQuery.data ?? []).map((cl) => (
                      <option key={cl.id} value={cl.id}>{cl.brand_name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Role (e.g. Lead, Editor)"
                    value={newClientAssign.roleOnAccount}
                    onChange={(e) => setNewClientAssign({ ...newClientAssign, roleOnAccount: e.target.value })}
                    className="rounded-md border border-border bg-raised p-2 text-foreground"
                  />
                </div>
                {newClientAssign.clientId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => {
                      assignClientMutation.mutate({
                        memberId: editingMember.id,
                        clientId: newClientAssign.clientId,
                        roleOnAccount: newClientAssign.roleOnAccount,
                      });
                    }}
                  >
                    + Assign Client to {editingMember.full_name}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={() => setEditingMember(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  updateMemberMutation.mutate({
                    memberId: editingMember.id,
                    managerId: newManagerId || null,
                  });
                }}
              >
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODAL FOR CLIENT */}
      {editingClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="text-base font-bold text-foreground">
                Manage Roster — {editingClient.brand_name}
              </h3>
              <button onClick={() => setEditingClient(null)} className="text-muted hover:text-foreground">✕</button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-muted mb-1">Account Manager:</label>
                <select
                  value={newAccountManagerId}
                  onChange={(e) => setNewAccountManagerId(e.target.value)}
                  className="w-full rounded-md border border-border bg-raised p-2 text-foreground"
                >
                  <option value="">Select Account Manager...</option>
                  {(teamQuery.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name} ({u.role?.name ?? 'User'})</option>
                  ))}
                </select>
              </div>

              <div className="border-t border-border pt-3">
                <label className="block font-medium text-muted mb-1">Add Team Member to Roster:</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={newMemberAssign.userId}
                    onChange={(e) => setNewMemberAssign({ ...newMemberAssign, userId: e.target.value })}
                    className="rounded-md border border-border bg-raised p-2 text-foreground"
                  >
                    <option value="">Select Team Member...</option>
                    {(teamQuery.data ?? []).map((u) => (
                      <option key={u.id} value={u.id}>{u.full_name}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="Role (e.g. DOP, Editor)"
                    value={newMemberAssign.roleOnAccount}
                    onChange={(e) => setNewMemberAssign({ ...newMemberAssign, roleOnAccount: e.target.value })}
                    className="rounded-md border border-border bg-raised p-2 text-foreground"
                  />
                </div>
                {newMemberAssign.userId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 w-full"
                    onClick={() => {
                      assignClientMutation.mutate({
                        memberId: newMemberAssign.userId,
                        clientId: editingClient.id,
                        roleOnAccount: newMemberAssign.roleOnAccount,
                      });
                    }}
                  >
                    + Add to Roster
                  </Button>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={() => setEditingClient(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (newAccountManagerId) {
                    updateClientAccountManagerMutation.mutate({
                      clientId: editingClient.id,
                      accountManagerId: newAccountManagerId,
                    });
                  } else {
                    setEditingClient(null);
                  }
                }}
              >
                Save Account Changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function formatRelativeTime(dateStr: string): string {
  try {
    const diff = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return 'recently';
  }
}
