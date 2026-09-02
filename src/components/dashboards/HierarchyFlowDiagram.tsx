'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Card, Spinner, Avatar, Button, StatusChip } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';

interface UserNode {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  manager_id: string | null;
  path: string;
  role?: { id: string; name: string; code: string; level: number; default_scope: string };
  department?: { name: string };
  tasks_count?: number;
}

export function HierarchyFlowDiagram() {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<UserNode | null>(null);
  const [newManagerId, setNewManagerId] = useState<string>('');
  const [newScope, setNewScope] = useState<string>('OWN');

  const usersQuery = useQuery({
    queryKey: ['hierarchy_nodes'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('users')
        .select('id, full_name, email, avatar_url, manager_id, path, role:roles(id, name, code, level, default_scope), department:departments(name), tasks:tasks!tasks_assignee_id_fkey(count)')
        .is('deleted_at', null)
        .order('path', { ascending: true });
      if (error) throw error;

      return (data ?? []).map((u: Record<string, unknown>) => ({
        ...u,
        tasks_count: Array.isArray(u.tasks) && u.tasks[0] ? (u.tasks[0] as { count?: number }).count ?? 0 : 0,
      })) as unknown as UserNode[];
    },
  });

  const updateManagerMutation = useMutation({
    mutationFn: async ({ userId, managerId, roleId, scope }: { userId: string; managerId: string | null; roleId?: string; scope?: string }) => {
      // 1. Update manager line
      const { error: mgrErr } = await supabase()
        .from('users')
        .update({ manager_id: managerId })
        .eq('id', userId);
      if (mgrErr) throw mgrErr;

      // 2. Update role scope if provided
      if (roleId && scope) {
        const { error: roleErr } = await supabase()
          .from('roles')
          .update({ default_scope: scope as 'ALL' | 'TEAM' | 'SUBTREE' | 'OWN' | 'NONE' })
          .eq('id', roleId);
        if (roleErr) throw roleErr;
      }
    },
    onSuccess: () => {
      pushToast('Reporting hierarchy and data sharing scope updated!');
      setSelectedUser(null);
      queryClient.invalidateQueries({ queryKey: ['hierarchy_nodes'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
      queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Failed to update hierarchy', 'error');
    },
  });

  if (usersQuery.isLoading) return <Spinner label="Building organizational workflow & data sharing tree..." />;
  const users = usersQuery.data ?? [];

  // Group by level / manager
  const roots = users.filter((u) => !u.manager_id);
  const getSubordinates = (parentId: string) => users.filter((u) => u.manager_id === parentId);

  return (
    <div className="space-y-4 col-span-full">
      {/* Workflow & Data Sharing Header */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-accent flex items-center gap-2">
            <span>⚡</span> Founder Interactive Work Flow &amp; Data Sharing Diagram
          </h2>
          <p className="mt-1 text-xs text-muted">
            Shows how work details &amp; client information flow between team levels (<span className="text-accent font-medium">ALL</span> → <span className="text-foreground font-medium">TEAM/SUBTREE</span> → <span className="text-muted font-medium">OWN</span>). Click any node to edit reporting lines or data access scope.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-raised px-2 py-1 font-mono text-muted">
            {users.length} Active Members
          </span>
        </div>
      </div>

      {/* Node Flow Diagram Canvas */}
      <div className="scroll-thin overflow-x-auto rounded-lg border border-border bg-surface p-6">
        <div className="min-w-[850px] space-y-8">
          {roots.map((root) => (
            <TreeNode
              key={root.id}
              node={root}
              getSubordinates={getSubordinates}
              onSelectNode={(node) => {
                setSelectedUser(node);
                setNewManagerId(node.manager_id ?? '');
                setNewScope(node.role?.default_scope ?? 'OWN');
              }}
            />
          ))}
        </div>
      </div>

      {/* Reassign Manager & Edit Data Sharing Scope Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <Card title={`Edit Team Member & Data Flow: ${selectedUser.full_name}`} className="w-full max-w-md bg-surface border-border shadow-xl">
            <div className="space-y-4 pt-2 text-xs">
              <div>
                <p className="text-muted">Current Role &amp; Department:</p>
                <p className="font-medium text-foreground">{selectedUser.role?.name} ({selectedUser.department?.name ?? 'General'})</p>
              </div>

              <div>
                <label className="block text-muted mb-1 font-medium">Reporting Manager Line:</label>
                <select
                  value={newManagerId}
                  onChange={(e) => setNewManagerId(e.target.value)}
                  className="w-full rounded border border-border bg-raised p-2 text-xs text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="">No Manager (Root Founder)</option>
                  {users
                    .filter((u) => u.id !== selectedUser.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name} ({u.role?.name ?? 'User'})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-muted mb-1 font-medium">Work Data Visibility Scope:</label>
                <select
                  value={newScope}
                  onChange={(e) => setNewScope(e.target.value)}
                  className="w-full rounded border border-border bg-raised p-2 text-xs text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="ALL">ALL (Global access across all accounts)</option>
                  <option value="TEAM">TEAM (Access to team members' deliverables)</option>
                  <option value="SUBTREE">SUBTREE (Access to subordinate reporting tree)</option>
                  <option value="OWN">OWN (Assigned tasks and notes only)</option>
                </select>
                <p className="mt-1 text-[11px] text-muted">
                  Controls how client information and task details are shared down to this role.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <Button variant="ghost" size="sm" onClick={() => setSelectedUser(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={updateManagerMutation.isPending}
                  onClick={() =>
                    updateManagerMutation.mutate({
                      userId: selectedUser.id,
                      managerId: newManagerId || null,
                      roleId: selectedUser.role?.id,
                      scope: newScope,
                    })
                  }
                >
                  {updateManagerMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  getSubordinates,
  onSelectNode,
}: {
  node: UserNode;
  getSubordinates: (id: string) => UserNode[];
  onSelectNode: (node: UserNode) => void;
}) {
  const subs = getSubordinates(node.id);
  const scope = node.role?.default_scope ?? 'OWN';

  return (
    <div className="flex flex-col items-center">
      {/* Node Card (n8n workflow style) */}
      <div
        onClick={() => onSelectNode(node)}
        className="group relative cursor-pointer rounded-lg border border-border bg-raised p-3 shadow-sm transition-all hover:border-accent hover:shadow-md hover:-translate-y-0.5 min-w-[240px]"
      >
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2">
            <Avatar name={node.full_name} url={node.avatar_url} size={30} />
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-xs font-semibold text-foreground group-hover:text-accent">
                {node.full_name}
              </h4>
              <p className="truncate text-[11px] text-muted">{node.role?.name ?? 'Team Member'}</p>
            </div>
          </div>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase ${
              scope === 'ALL'
                ? 'bg-accent/20 text-accent'
                : scope === 'TEAM' || scope === 'SUBTREE'
                ? 'bg-amber/20 text-amber'
                : 'bg-raised text-muted'
            }`}
          >
            Scope: {scope}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2 text-[10px] text-muted">
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono">
            {node.department?.name ?? 'Agency'}
          </span>
          <span className="font-mono text-muted">
            {node.tasks_count ?? 0} active task{(node.tasks_count ?? 0) === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Connecting Vector Lines & Subordinate Branches */}
      {subs.length > 0 && (
        <div className="flex flex-col items-center w-full">
          {/* Vertical Connecting Flow Line Down */}
          <div className="h-6 w-0.5 bg-accent/40" />

          {/* Subordinates Row */}
          <div className="relative flex flex-wrap justify-center gap-6 pt-2">
            {subs.map((sub) => (
              <TreeNode
                key={sub.id}
                node={sub}
                getSubordinates={getSubordinates}
                onSelectNode={onSelectNode}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
