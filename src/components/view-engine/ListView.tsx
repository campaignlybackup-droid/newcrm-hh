'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  flexRender, getCoreRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from '@tanstack/react-table';
import { FieldEditor } from './FieldEditor';
import { Spinner, Empty } from '@/components/ui/primitives';
import { useUpdateRecord } from '@/lib/records';
import { pushToast } from '@/components/ui/Toaster';
import { can, type SessionContext } from '@/lib/session';
import { isEditable, type FieldDef, type ModuleDef } from '@/modules/types';
import { cn } from '@/lib/utils';

interface Props {
  mod: ModuleDef;
  rows: Record<string, unknown>[];
  loading: boolean;
  session?: SessionContext;
  columns: string[];
  sorting: SortingState;
  onSortingChange: (s: SortingState) => void;
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
}

export function ListView({
  mod, rows, loading, session, columns, sorting, onSortingChange, selected, onSelectedChange,
}: Props) {
  const update = useUpdateRecord();
  const [widths, setWidths] = useState<Record<string, number>>({});

  const visibleFields = useMemo(
    () => columns.map((k) => mod.fields.find((f) => f.key === k)).filter(Boolean) as FieldDef[],
    [columns, mod.fields],
  );

  /**
   * Whether a cell is editable is decided by exactly two things: the field
   * definition and the user's permission on this module. The detail page
   * asks the identical question, so the two surfaces cannot disagree.
   */
  const editableFor = (f: FieldDef) => {
    if (!isEditable(f)) {
      return { ok: false, why: f.inheritedFrom
        ? `Inherited from the ${f.inheritedFrom}. Change it there.`
        : 'Computed automatically — not directly editable.' };
    }
    const action = f.permissionAction ?? 'edit';
    if (!can(session, mod.key, action)) {
      return { ok: false, why: `You do not have ${action} permission on ${mod.label}.` };
    }
    return { ok: true, why: '' };
  };

  const safeRows = rows ?? [];
  const tableColumns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const select: ColumnDef<Record<string, unknown>> = {
      id: '__select',
      size: 34,
      header: () => (
        <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
          checked={safeRows.length > 0 && selected.size === safeRows.length}
          onChange={(e) => onSelectedChange(
            e.target.checked ? new Set(safeRows.map((r) => String(r.id))) : new Set())} />
      ),
      cell: ({ row }) => {
        const id = String(row.original.id);
        return (
          <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
            checked={selected.has(id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(id); else next.delete(id);
              onSelectedChange(next);
            }} />
        );
      },
    };

    const open: ColumnDef<Record<string, unknown>> = {
      id: '__open',
      size: 30,
      header: () => null,
      cell: ({ row }) => (
        <Link href={`/${mod.key}/${String(row.original.id)}`}
          className="text-muted hover:text-accent" title="Open detail page">↗</Link>
      ),
    };

    const data = visibleFields.map<ColumnDef<Record<string, unknown>>>((f) => ({
      id: f.key,
      accessorKey: f.key,
      size: widths[f.key] ?? f.width ?? 150,
      header: () => <span className="truncate">{f.label}</span>,
      cell: ({ row }) => {
        const guard = editableFor(f);
        const rec = row.original;
        return (
          <FieldEditor
            field={f}
            row={rec}
            value={rec[f.key]}
            variant="cell"
            disabled={!guard.ok}
            lockedReason={guard.why}
            onCommit={(next) =>
              update.mutate(
                { mod, id: String(rec.id), patch: { [f.key]: next }, previous: rec },
                { onError: (e) => pushToast(e instanceof Error ? e.message : 'Update failed', 'error') },
              )
            }
          />
        );
      },
    }));

    return [select, ...data, open];
  }, [visibleFields, rows, selected, widths, mod, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = useReactTable({
    data: safeRows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: (u) => onSortingChange(typeof u === 'function' ? u(sorting) : u),
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    getRowId: (r, i) => String(r?.id ?? `row_${i}`),
  });

  if (loading && !safeRows.length) return <Spinner label={`Loading ${mod.label.toLowerCase()}`} />;
  if (!safeRows.length) {
    return <Empty title={`No ${mod.label.toLowerCase()} match these filters`}
      hint="Adjust the date range or clear a filter. If you expected to see more, your access scope may be narrower than the data set." />;
  }

  return (
    <div className="scroll-thin overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-raised">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const field = mod.fields.find((f) => f.key === h.id);
                return (
                  <th key={h.id} style={{ width: h.getSize() }}
                    className="group relative border-b border-border px-2 py-2 text-left font-medium text-muted">
                    <span
                      className={cn('flex items-center gap-1', field && 'cursor-pointer select-none hover:text-fg')}
                      onClick={() => {
                        if (!field) return;
                        const cur = sorting[0];
                        onSortingChange(
                          cur?.id === h.id && !cur.desc ? [{ id: h.id, desc: true }] : [{ id: h.id, desc: false }],
                        );
                      }}
                      title={field?.help}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {sorting[0]?.id === h.id && <span className="text-accent">{sorting[0].desc ? '↓' : '↑'}</span>}
                      {field?.editable === false && <span className="text-[10px] text-muted" title="Computed">ƒ</span>}
                    </span>
                    {/* Drag to resize */}
                    <span
                      onMouseDown={(e) => {
                        const startX = e.clientX;
                        const startW = h.getSize();
                        const move = (ev: MouseEvent) =>
                          setWidths((w) => ({ ...w, [h.id]: Math.max(60, startW + ev.clientX - startX) }));
                        const up = () => {
                          window.removeEventListener('mousemove', move);
                          window.removeEventListener('mouseup', up);
                        };
                        window.addEventListener('mousemove', move);
                        window.addEventListener('mouseup', up);
                      }}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize opacity-0 group-hover:bg-accent/40 group-hover:opacity-100"
                    />
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}
              className={cn('border-b border-border/60 hover:bg-raised/50',
                selected.has(row.id) && 'bg-accent/5',
                row.original.deleted_at ? 'opacity-50 line-through' : '')}>
              {row.getVisibleCells().map((c) => (
                <td key={c.id} style={{ width: c.column.getSize() }} className="align-middle">
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
