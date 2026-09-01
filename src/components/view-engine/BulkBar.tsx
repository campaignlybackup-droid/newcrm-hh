'use client';

import { useState } from 'react';
import { Button, Select } from '@/components/ui/primitives';
import { useBulkUpdate, useSoftDelete, useOptions } from '@/lib/records';
import { supabase } from '@/lib/supabase/client';
import { pushToast } from '@/components/ui/Toaster';
import { can, type SessionContext } from '@/lib/session';
import type { ModuleDef } from '@/modules/types';

/**
 * Multi-record status change, reassignment and date shift.
 *
 * A bulk write is the same UPDATE as a single one, so RLS silently drops
 * rows the user may not touch. We report the applied count rather than the
 * requested count, so a partial result is visible instead of implied.
 */
export function BulkBar({ mod, session, ids, rows, onDone, onCancel }: {
  mod: ModuleDef;
  session?: SessionContext;
  ids: string[];
  rows: Record<string, unknown>[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const bulk = useBulkUpdate();
  const del = useSoftDelete();
  const users = useOptions({ table: 'users', labelKey: 'full_name', orderBy: 'full_name' });
  const [shift, setShift] = useState(1);

  const statusField = mod.fields.find((f) => f.key === 'status');
  const assigneeKey = mod.fields.find((f) => ['assignee_id', 'owner_id'].includes(f.key))?.key;
  const hasDates = mod.key === 'tasks';

  const run = (patch: Record<string, unknown>) =>
    bulk.mutate({ mod, ids, patch }, {
      onSuccess: (r) => {
        if (r.applied < r.requested) {
          pushToast(`${r.applied} of ${r.requested} updated — the rest are outside your edit permission`, 'error');
        }
        onDone();
      },
      onError: (e) => pushToast(e instanceof Error ? e.message : 'Bulk update failed', 'error'),
    });

  return (
    <div className="sticky bottom-3 z-20 mx-auto flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 shadow-lg">
      <span className="text-[13px] font-medium">{ids.length} selected</span>

      {statusField?.options && can(session, mod.key, 'edit') && (
        <Select className="w-40" defaultValue=""
          onChange={(e) => e.target.value && run({ status: e.target.value })}>
          <option value="">Set status…</option>
          {statusField.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      )}

      {assigneeKey && can(session, mod.key, 'assign') && (
        <Select className="w-44" defaultValue=""
          onChange={(e) => e.target.value && run({ [assigneeKey]: e.target.value })}>
          <option value="">Reassign to…</option>
          {users.data?.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </Select>
      )}

      {hasDates && can(session, mod.key, 'edit') && (
        <span className="flex items-center gap-1.5 text-[13px]">
          <input type="number" value={shift} onChange={(e) => setShift(Number(e.target.value))}
            className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-[13px]" />
          <span className="text-muted">working days</span>
          <Button onClick={async () => {
            const { error } = await supabase().rpc('shift_task_dates', { p_task_ids: ids, p_days: shift });
            if (error) pushToast(error.message, 'error');
            else { pushToast(`Shifted ${ids.length} tasks — dependent dates cascaded`); onDone(); }
          }}>Shift dates</Button>
        </span>
      )}

      {can(session, mod.key, 'delete') && mod.softDelete && (
        <Button variant="danger"
          onClick={() => del.mutate({ mod, ids }, { onSuccess: onDone })}>
          Delete
        </Button>
      )}

      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      <span className="text-[11px] text-muted">
        Rows outside your permission are skipped, not silently applied.
      </span>
    </div>
  );
}
