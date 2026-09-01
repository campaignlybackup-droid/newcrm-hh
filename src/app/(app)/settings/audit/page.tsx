'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Spinner, ErrorBox, Button, Avatar } from '@/components/ui/primitives';
import { useOptions } from '@/lib/records';
import { exportRecords } from '@/lib/export';
import { cn } from '@/lib/utils';
import type { Enums } from '@/lib/database.types';

const ACTIONS = ['INSERT', 'UPDATE', 'SOFT_DELETE', 'RESTORE', 'DELETE'];

export default function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [days, setDays] = useState(7);

  const users = useOptions({ table: 'users', labelKey: 'full_name', orderBy: 'full_name' });

  const q = useQuery({
    queryKey: ['audit', entityType, action, actor, days],
    queryFn: async () => {
      let sel = supabase().from('v_activity_feed').select('*')
        .gte('changed_at', new Date(Date.now() - days * 86400000).toISOString())
        .order('changed_at', { ascending: false }).limit(500);
      if (entityType) sel = sel.eq('entity_type', entityType);
      if (action) sel = sel.eq('action', action as Enums['audit_action']);
      if (actor) sel = sel.eq('actor_id', actor);
      const { data, error } = await sel;
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <div className="space-y-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Audit Log</h1>
          <p className="text-[13px] text-muted">
            Every insert, update and delete, including bulk edits and automated changes. Append-only.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <select value={entityType} onChange={(e) => setEntityType(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            <option value="">All records</option>
            {['clients','projects','deliverables','tasks','shoots','content_calendar','approvals','users','leave_requests']
              .map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={action} onChange={(e) => setAction(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            <option value="">All actions</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={actor} onChange={(e) => setActor(e.target.value)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            <option value="">Anyone</option>
            {users.data?.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
            {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} day{d > 1 ? 's' : ''}</option>)}
          </select>
        </div>
      </header>

      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading && <Spinner />}

      <div className="scroll-thin overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-raised">
            <tr>
              <th className="border-b border-border px-3 py-2 text-left font-medium">When</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Who</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Record</th>
              <th className="border-b border-border px-3 py-2 text-left font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((r) => (
              <tr key={String(r.id)} className="hover:bg-raised/50">
                <td className="whitespace-nowrap border-b border-border px-3 py-1.5 tabular-nums text-muted">
                  {new Date(String(r.changed_at)).toLocaleString()}
                </td>
                <td className="border-b border-border px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    <Avatar name={String(r.actor_name)} size={18} />
                    <span className={cn(Boolean(r.is_system) && 'text-muted')}>{String(r.actor_name)}</span>
                  </span>
                </td>
                <td className="border-b border-border px-3 py-1.5 text-muted">
                  {String(r.entity_type)}
                </td>
                <td className="border-b border-border px-3 py-1.5">
                  <span className={cn('mr-2 rounded px-1.5 py-0.5 text-[10px]',
                    r.action === 'INSERT' ? 'bg-green/12 text-green'
                    : String(r.action).includes('DELETE') ? 'bg-red/12 text-red'
                    : 'bg-raised text-muted')}>{String(r.action)}</span>
                  {String(r.summary)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {q.data && (
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span>{q.data.length} entries (capped at 500)</span>
          <Button onClick={() => {
            const csv = ['When,Who,Record,Action,Field,Old,New']
              .concat(q.data!.map((r) => [
                r.changed_at, r.actor_name, r.entity_type, r.action, r.field_name ?? '',
                r.old_value ?? '', r.new_value ?? '',
              ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')))
              .join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
          }}>Export CSV</Button>
        </div>
      )}
    </div>
  );
}
