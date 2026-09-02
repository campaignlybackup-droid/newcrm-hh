'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useUpdateRecord, useOptions } from '@/lib/records';
import { pushToast } from '@/components/ui/Toaster';
import { StatusChip, Avatar, Empty, Spinner } from '@/components/ui/primitives';
import { can, type SessionContext } from '@/lib/session';
import type { ModuleDef } from '@/modules/types';
import { cn } from '@/lib/utils';

interface Props {
  mod: ModuleDef;
  rows: Record<string, unknown>[];
  loading: boolean;
  session?: SessionContext;
  groupBy: string;
  onGroupByChange: (k: string) => void;
}

export function KanbanView({ mod, rows, loading, session, groupBy, onGroupByChange }: Props) {
  const update = useUpdateRecord();
  const [dragging, setDragging] = useState<string | null>(null);
  const field = mod.fields.find((f) => f.key === groupBy);
  const relOptions = useOptions(field?.relation);

  const safeRows = rows ?? [];

  const columns = useMemo(() => {
    if (field?.options?.length) return field.options.map((o) => ({ id: o, label: o }));
    if (field?.relation) {
      const present = new Set(safeRows.map((r) => String(r[groupBy] ?? '')));
      return [
        ...(relOptions.data ?? []).filter((o) => present.has(o.id)),
        { id: '', label: 'Unassigned' },
      ];
    }
    const distinct = [...new Set(safeRows.map((r) => String(r[groupBy] ?? '')))];
    return distinct.map((d) => ({ id: d, label: d || 'Unassigned' }));
  }, [field, safeRows, groupBy, relOptions.data]);

  const grouped = useMemo(() => {
    const m = new Map<string, Record<string, unknown>[]>();
    for (const c of columns) m.set(c.id, []);
    for (const r of safeRows) {
      const key = String(r[groupBy] ?? '');
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return m;
  }, [safeRows, columns, groupBy]);

  const canDrag = field ? can(session, mod.key, field.permissionAction ?? 'edit') && field.editable !== false : false;

  if (loading && !safeRows.length) return <Spinner />;
  if (!safeRows.length) return <Empty title={`No ${mod.label.toLowerCase()} match these filters`} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted">Group by</span>
        <select value={groupBy} onChange={(e) => onGroupByChange(e.target.value)}
          className="h-7 rounded-md border border-border bg-surface px-2 text-[13px]">
          {(mod.kanbanGroupOptions ?? [mod.kanbanGroupBy!]).map((k) => (
            <option key={k} value={k}>{mod.fields.find((f) => f.key === k)?.label ?? k}</option>
          ))}
        </select>
        {!canDrag && <span className="text-muted">· drag disabled (no permission on this field)</span>}
      </div>

      <div className="scroll-thin flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => {
          const items = grouped.get(col.id) ?? [];
          return (
            <div key={col.id || 'none'}
              onDragOver={(e) => { if (canDrag) e.preventDefault(); }}
              onDrop={() => {
                if (!canDrag || !dragging) return;
                const row = rows.find((r) => String(r.id) === dragging);
                if (!row || String(row[groupBy] ?? '') === col.id) return;
                update.mutate(
                  { mod, id: dragging, patch: { [groupBy]: col.id || null }, previous: row },
                  { onError: (e) => pushToast(e instanceof Error ? e.message : 'Move failed', 'error') },
                );
                setDragging(null);
              }}
              className="flex w-[280px] shrink-0 flex-col rounded-lg border border-border bg-raised/40">
              <header className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {field?.options ? <StatusChip value={col.label} /> : col.label}
                </span>
                <span className="text-[11px] tabular-nums text-muted">{items.length}</span>
              </header>
              <div className="scroll-thin flex max-h-[62vh] flex-col gap-2 overflow-y-auto p-2">
                {items.map((r) => {
                  const client = r.client as { brand_name?: string } | null;
                  const assignee = (r.assignee ?? r.owner) as { full_name?: string; avatar_url?: string | null } | null;
                  return (
                    <Link key={String(r.id)} href={`/${mod.key}/${String(r.id)}`}
                      draggable={canDrag}
                      onDragStart={() => setDragging(String(r.id))}
                      className={cn('rounded-md border border-border bg-surface p-2.5 text-[13px] hover:border-accent/50',
                        canDrag && 'cursor-grab active:cursor-grabbing')}>
                      <div className="line-clamp-2 font-medium">{String(r[mod.titleField] ?? 'Untitled')}</div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                        <span className="truncate">{client?.brand_name ?? ''}</span>
                        {assignee?.full_name && <Avatar name={assignee.full_name} url={assignee.avatar_url} size={18} />}
                      </div>
                      {typeof r.due_date === 'string' && (
                        <div className={cn('mt-1 text-[11px] tabular-nums',
                          new Date(r.due_date) < new Date() ? 'text-red' : 'text-muted')}>
                          due {r.due_date}
                        </div>
                      )}
                    </Link>
                  );
                })}
                {!items.length && <p className="px-1 py-3 text-center text-[12px] text-muted">Empty</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
