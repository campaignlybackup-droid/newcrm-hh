'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, supabaseDynamic } from '@/lib/supabase/client';
import { Card, Spinner, Button, Avatar } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';

interface RecordAccessControlDrawerProps {
  tableName: string;
  recordId: string;
  recordTitle: string;
  onClose: () => void;
}

interface UserOption {
  id: string;
  full_name: string;
  role?: { name: string };
}

interface RecordAccessData {
  id: string;
  is_locked_to_founders: boolean;
  allowed_viewer_user_ids: string[];
  allowed_editor_user_ids: string[];
}

export function RecordAccessControlDrawer({
  tableName,
  recordId,
  recordTitle,
  onClose,
}: RecordAccessControlDrawerProps) {
  const queryClient = useQueryClient();

  const [isLockedToFounders, setIsLockedToFounders] = useState<boolean>(false);
  const [selectedViewers, setSelectedViewers] = useState<string[]>([]);
  const [selectedEditors, setSelectedEditors] = useState<string[]>([]);

  // Query 1: Fetch active team users
  const usersQuery = useQuery({
    queryKey: ['active_users_for_access'],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('users')
        .select('id, full_name, role:roles(name)')
        .is('deleted_at', null)
        .order('full_name');
      if (error) throw error;
      return (data ?? []) as unknown as UserOption[];
    },
  });

  // Query 2: Fetch current access control overrides for this record
  const accessQuery = useQuery({
    queryKey: ['record_access', tableName, recordId],
    queryFn: async () => {
      const { data, error } = await supabaseDynamic()
        .from('record_access_controls')
        .select('*')
        .eq('table_name', tableName)
        .eq('record_id', recordId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as RecordAccessData | null;
    },
  });

  useEffect(() => {
    if (accessQuery.data) {
      setIsLockedToFounders(accessQuery.data.is_locked_to_founders ?? false);
      setSelectedViewers(accessQuery.data.allowed_viewer_user_ids ?? []);
      setSelectedEditors(accessQuery.data.allowed_editor_user_ids ?? []);
    }
  }, [accessQuery.data]);

  // Mutation: Save record access controls
  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabaseDynamic().rpc('save_record_access_control', {
        p_table_name: tableName,
        p_record_id: recordId,
        p_is_locked_to_founders: isLockedToFounders,
        p_allowed_viewer_user_ids: selectedViewers,
        p_allowed_editor_user_ids: selectedEditors,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      pushToast(`Access permissions updated for "${recordTitle}"!`);
      queryClient.invalidateQueries({ queryKey: ['record_access', tableName, recordId] });
      queryClient.invalidateQueries({ queryKey: ['records'] });
      onClose();
    },
    onError: (err) => {
      pushToast(err instanceof Error ? err.message : 'Save failed', 'error');
    },
  });

  const toggleUser = (userId: string, list: string[], setList: (next: string[]) => void) => {
    if (list.includes(userId)) {
      setList(list.filter((id) => id !== userId));
    } else {
      setList([...list, userId]);
    }
  };

  const users = usersQuery.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <Card title={`🔒 Item Access & Edit Governance: "${recordTitle}"`} className="w-full max-w-lg bg-surface border-border shadow-2xl">
        <div className="space-y-4 pt-2 text-xs">
          <p className="text-muted">
            As Founder, set who is authorized to view this specific item and who is allowed to edit and manage its information.
          </p>

          {/* Founder-Only Lock Switch */}
          <div className="rounded-lg border border-border bg-raised p-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="font-semibold text-foreground flex items-center gap-1.5">
                <span>👑</span> Strict Founder-Only Item
              </h4>
              <p className="text-[11px] text-muted">
                If enabled, ONLY Founders can view or edit this item regardless of team role.
              </p>
            </div>
            <input
              type="checkbox"
              checked={isLockedToFounders}
              onChange={(e) => setIsLockedToFounders(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--accent))] cursor-pointer"
            />
          </div>

          {!isLockedToFounders && (
            <>
              {/* Allowed Viewers Picker */}
              <div>
                <label className="block text-muted font-medium mb-1.5">
                  👁️ Authorized Viewers (Who can VIEW this item):
                </label>
                <div className="scroll-thin max-h-36 overflow-y-auto rounded border border-border bg-raised p-2 space-y-1">
                  {usersQuery.isLoading && <Spinner />}
                  {users.map((u) => {
                    const isChecked = selectedViewers.includes(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex items-center justify-between rounded p-1 hover:bg-surface cursor-pointer text-xs"
                      >
                        <span className="font-medium text-foreground">
                          {u.full_name} <span className="text-muted font-normal">({u.role?.name ?? 'User'})</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleUser(u.id, selectedViewers, setSelectedViewers)}
                          className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Leave empty to inherit standard role visibility scope.
                </p>
              </div>

              {/* Allowed Editors Picker */}
              <div>
                <label className="block text-muted font-medium mb-1.5">
                  ✏️ Authorized Editors &amp; Managers (Who can EDIT this item):
                </label>
                <div className="scroll-thin max-h-36 overflow-y-auto rounded border border-border bg-raised p-2 space-y-1">
                  {usersQuery.isLoading && <Spinner />}
                  {users.map((u) => {
                    const isChecked = selectedEditors.includes(u.id);
                    return (
                      <label
                        key={u.id}
                        className="flex items-center justify-between rounded p-1 hover:bg-surface cursor-pointer text-xs"
                      >
                        <span className="font-medium text-foreground">
                          {u.full_name} <span className="text-muted font-normal">({u.role?.name ?? 'User'})</span>
                        </span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleUser(u.id, selectedEditors, setSelectedEditors)}
                          className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  Users selected here are granted permission to manage and edit this record.
                </p>
              </div>
            </>
          )}

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'Enforcing...' : 'Save & Enforce Permissions'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
