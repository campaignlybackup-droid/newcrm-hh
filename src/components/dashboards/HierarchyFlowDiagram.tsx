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
  role?: { name: string; code: string; level: number };
  department?: { name: string };
}

export function HierarchyFlowDiagram() {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<UserNode | null>(null);
  const [newManagerId, setNewManagerId] = useState<string>('');

  const usersQuery = useQuery({
    queryKey: ['hierarchy_nodes'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('users')
        .select('id, full_name, email, avatar_url, manager_id, path, role:roles(name, code, level), department:departments(name)')
        .is('deleted_at', null)
        .order('path', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as UserNode[];
    },
  });

  const updateManagerMutation = useMutation({
    mutationFn: async ({ userId, managerId }: { userId: string; managerId: string | null }) => {
      const { error } = await supabase()
        .from('users')
        .update({ manager_id: managerId })
        .eq('id', userId);
      if (error) throw error;
    },
    onSuccess: () => {
      pushToast('Reporting manager updated! Tree recalculated.');
      setSelectedUser(null);
      queryClient.invalidateQueries({ queryKey: ['hierarchy_nodes'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Failed to update manager', 'error');
    },
  });

  if (usersQuery.isLoading) return <Spinner label="Building hierarchy workflow..." />;
  const users = usersQuery.data ?? [];

  // Group by level / manager
  const roots = users.filter((u) => !u.manager_id);
  const getSubordinates = (parentId: string) => users.filter((u) => u.manager_id === parentId);

  return (
    <div className="space-y-4 col-span-full">
      {/* n8n-style Header */}
      <div className="rounded-lg border border-accent/20 bg-accent/5 p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-accent flex items-center gap-2">
            <span>⚡</span> Organization Hierarchy Node Graph
          </h2>
          <p className="mt-1 text-xs text-muted">
            Interactive reporting tree. Click any node to reassign reporting lines or inspect reporting depth.
          </p>
        </div>
        <span className="rounded bg-raised px-2 py-1 text-[11px] font-mono text-muted">
          {users.length} Active Team Members
        </span>
      </div>

      {/* Node Flow Diagram Canvas */}
      <div className="scroll-thin overflow-x-auto rounded-lg border border-border bg-surface p-6">
        <div className="min-w-[800px] space-y-8">
          {roots.map((root) => (
            <TreeNode
              key={root.id}
              node={root}
              getSubordinates={getSubordinates}
              onSelectNode={(node) => {
                setSelectedUser(node);
                setNewManagerId(node.manager_id ?? '');
              }}
            />
          ))}
        </div>
      </div>

      {/* Reassign Manager Modal / Drawer */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <Card title={`Reassign Reporting Line: ${selectedUser.full_name}`} className="w-full max-w-md bg-surface border-border shadow-xl">
            <div className="space-y-4 pt-2 text-xs">
              <div>
                <p className="text-muted">Current Role:</p>
                <p className="font-medium text-foreground">{selectedUser.role?.name} ({selectedUser.department?.name ?? 'General'})</p>
              </div>

              <div>
                <label className="block text-muted mb-1 font-medium">Select New Reporting Manager:</label>
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
                    })
                  }
                >
                  {updateManagerMutation.isPending ? 'Updating...' : 'Save Reporting Line'}
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

  return (
    <div className="flex flex-col items-center">
      {/* Node Card (n8n node style) */}
      <div
        onClick={() => onSelectNode(node)}
        className="group relative cursor-pointer rounded-lg border border-border bg-raised p-3 shadow-sm transition-all hover:border-accent hover:shadow-md hover:-translate-y-0.5 min-w-[220px]"
      >
        <div className="flex items-center gap-2.5">
          <Avatar name={node.full_name} url={node.avatar_url} size={32} />
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-xs font-semibold text-foreground group-hover:text-accent">
              {node.full_name}
            </h4>
            <p className="truncate text-[11px] text-muted">{node.role?.name ?? 'Team Member'}</p>
          </div>
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-border/60 pt-2 text-[10px] text-muted">
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono">
            {node.department?.name ?? 'Agency'}
          </span>
          {subs.length > 0 && (
            <span className="font-medium text-accent">
              {subs.length} direct report{subs.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Connecting Vector Lines & Subordinate Branches */}
      {subs.length > 0 && (
        <div className="flex flex-col items-center w-full">
          {/* Vertical Connecting Line Down */}
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
