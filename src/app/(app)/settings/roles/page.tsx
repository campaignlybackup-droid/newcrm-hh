'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Spinner, ErrorBox, Button } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import { ACCESS_SCOPE } from '@/modules/enums';
import { cn } from '@/lib/utils';
import type { TablesUpdate } from '@/lib/database.types';

const ACTIONS = ['can_view','can_create','can_edit','can_delete','can_assign','can_approve','can_export'] as const;
const ACTION_LABEL: Record<string, string> = {
  can_view: 'View', can_create: 'Create', can_edit: 'Edit', can_delete: 'Delete',
  can_assign: 'Assign', can_approve: 'Approve', can_export: 'Export',
};

/**
 * The Founder-only permission matrix — a live editable grid.
 *
 * Writing here changes what the DATABASE allows, not what the UI shows:
 * these rows are what auth_scope() and auth_can() read inside every RLS
 * policy. This page is genuinely the control surface, not a mirror of one.
 */
export default function RolesPage() {
  const qc = useQueryClient();
  const { data: session } = useSession();
  const [roleFilter, setRoleFilter] = useState<string>('');

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      const { data, error } = await supabase().from('roles')
        .select('id,name,code,level,default_scope,is_external').order('sort_order');
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; code: string; level: number; default_scope: string; is_external: boolean }[];
    },
  });

  const modules = useQuery({
    queryKey: ['modules'],
    queryFn: async () => {
      const { data, error } = await supabase().from('modules').select('key,label').order('sort_order');
      if (error) throw error;
      return (data ?? []) as { key: string; label: string }[];
    },
  });

  const perms = useQuery({
    queryKey: ['role_permissions'],
    queryFn: async () => {
      const { data, error } = await supabase().from('role_permissions').select('*');
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const save = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TablesUpdate<'role_permissions'> }) => {
      const { error } = await supabase().from('role_permissions').update(patch).eq('id', id);
      if (error) throw error;
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['role_permissions'] });
      const prev = qc.getQueryData(['role_permissions']);
      qc.setQueryData<Record<string, unknown>[]>(['role_permissions'], (old) =>
        old?.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(['role_permissions'], ctx?.prev);
      pushToast(e instanceof Error ? e.message : 'Could not save', 'error');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['role_permissions'] });
      qc.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const byRoleModule = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const p of perms.data ?? []) m.set(`${p.role_id}|${p.module}`, p);
    return m;
  }, [perms.data]);

  if ((session?.role.level ?? 99) > 1) {
    return <div className="p-8"><ErrorBox error="Roles & Permissions is Founder-only." /></div>;
  }
  if (roles.isLoading || modules.isLoading || perms.isLoading) return <Spinner />;

  const shownRoles = (roles.data ?? []).filter((r) => !roleFilter || r.id === roleFilter);

  return (
    <div className="space-y-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Roles &amp; Permissions</h1>
          <p className="text-[13px] text-muted">
            The matrix the database reads. Changes take effect on each user&rsquo;s next request —
            no deploy, no code change.
          </p>
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
          <option value="">All roles</option>
          {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </header>

      <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-amber">
        Founder and Co-Founder always resolve to full access regardless of what this grid says — that
        short-circuit exists so a mis-edit here cannot lock everyone out of the system.
      </div>

      <div className="scroll-thin overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-raised">
            <tr>
              <th className="border-b border-border px-2 py-2 text-left font-medium">Role</th>
              <th className="border-b border-border px-2 py-2 text-left font-medium">Module</th>
              <th className="border-b border-border px-2 py-2 text-left font-medium">Scope</th>
              {ACTIONS.map((a) => (
                <th key={a} className="border-b border-border px-2 py-2 font-medium">{ACTION_LABEL[a]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRoles.map((role) =>
              (modules.data ?? []).map((mod, i) => {
                const p = byRoleModule.get(`${role.id}|${mod.key}`);
                if (!p) return null;
                return (
                  <tr key={`${role.id}-${mod.key}`} className="hover:bg-raised/50">
                    {i === 0 && (
                      <td rowSpan={modules.data!.length}
                        className="border-b border-r border-border px-2 align-top">
                        <div className="sticky top-12 py-1">
                          <div className="font-medium">{role.name}</div>
                          <div className="text-[11px] text-muted">
                            level {role.level}{role.is_external ? ' · external' : ''}
                          </div>
                        </div>
                      </td>
                    )}
                    <td className="border-b border-border px-2 py-1">{mod.label}</td>
                    <td className="border-b border-border px-2 py-1">
                      <select value={String(p.scope)} disabled={role.level <= 1}
                        onChange={(e) => save.mutate({ id: String(p.id), patch: { scope: e.target.value as TablesUpdate<'role_permissions'>['scope'] } })}
                        className="h-6 rounded border border-border bg-surface px-1 text-[11px] disabled:opacity-50">
                        {ACCESS_SCOPE.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    {ACTIONS.map((a) => {
                      const checked = Boolean(p[a]);
                      // Edit rights are a subset of view rights, in the UI
                      // and — authoritatively — in auth_can().
                      const impliedOff = a !== 'can_view' && !p.can_view;
                      return (
                        <td key={a} className="border-b border-border px-2 py-1 text-center">
                          <input type="checkbox"
                            checked={checked && !impliedOff}
                            disabled={role.level <= 1 || impliedOff}
                            title={impliedOff ? 'Requires View on this module' : undefined}
                            onChange={(e) => save.mutate({ id: String(p.id), patch: { [a]: e.target.checked } })}
                            className={cn('h-3.5 w-3.5 accent-[rgb(var(--accent))]',
                              (role.level <= 1 || impliedOff) && 'opacity-30')} />
                        </td>
                      );
                    })}
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted">
        Per-person exceptions live in <code>user_permission_overrides</code> and take precedence over the
        row above for that individual.
      </p>
    </div>
  );
}
