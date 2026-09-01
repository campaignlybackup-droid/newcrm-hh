'use client';

import { useEffect, useRef, useState } from 'react';
import { useOptions } from '@/lib/records';
import { StatusChip, UserCell, Avatar } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import type { FieldDef } from '@/modules/types';

/**
 * THE shared field control.
 *
 * The list view renders it with variant="cell" and the detail page with
 * variant="form". Same component, same options source, same coercion,
 * same disabled logic — which is why a field cannot be editable in one
 * surface and not the other, and why both produce a patch that the same
 * Zod schema validates.
 */
export interface FieldEditorProps {
  field: FieldDef;
  row: Record<string, unknown>;
  /** Raw column value (not the embedded relation object). */
  value: unknown;
  variant: 'cell' | 'form';
  disabled?: boolean;
  /** Reason the control is locked, surfaced as a tooltip. */
  lockedReason?: string;
  onCommit: (next: unknown) => void;
}

function embedded(row: Record<string, unknown>, field: FieldDef) {
  const k = field.key.replace(/_id$/, '');
  const v = row[k];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

export function FieldEditor(props: FieldEditorProps) {
  const { field, row, value, variant, disabled, lockedReason, onCommit } = props;
  const [editing, setEditing] = useState(variant === 'form');
  const isCell = variant === 'cell';

  if (disabled) {
    return (
      <div
        className={cn('truncate text-[13px]', isCell ? 'px-2 py-1' : 'py-1', 'text-muted')}
        title={lockedReason ?? 'Read-only'}
      >
        <ReadOnly field={field} row={row} value={value} />
      </div>
    );
  }

  // In the list, a cell shows a rendered value until it is clicked. That
  // keeps 50 rows cheap while still being one keystroke from editable.
  if (isCell && !editing && !['boolean', 'select'].includes(field.type)) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        onFocus={() => setEditing(true)}
        className="group/cell flex w-full items-center justify-between gap-1 truncate rounded px-2 py-1 text-left text-[13px] hover:bg-raised focus:bg-raised focus:outline-none"
        title="Click cell to edit inline"
      >
        <span className="truncate"><ReadOnly field={field} row={row} value={value} /></span>
        <span className="opacity-0 group-hover/cell:opacity-60 text-[10px] text-muted font-mono shrink-0">✎</span>
      </button>
    );
  }

  return (
    <Control
      {...props}
      autoFocus={isCell}
      onDone={() => { if (isCell) setEditing(false); }}
      onCommit={onCommit}
    />
  );
}

/* ------------------------------------------------------------------ */
function ReadOnly({ field, row, value }: { field: FieldDef; row: Record<string, unknown>; value: unknown }) {
  const rel = embedded(row, field);

  if (field.type === 'user') {
    return <UserCell user={rel as { full_name?: string; avatar_url?: string | null } | null} />;
  }
  if (field.type === 'client' || field.type === 'relation') {
    const label = rel?.brand_name ?? rel?.name ?? rel?.title ?? null;
    return <span className="truncate">{(label as string) ?? (value ? '—' : <span className="text-muted">—</span>)}</span>;
  }
  if (field.type === 'select') return <StatusChip value={value as string} />;
  if (field.type === 'boolean') {
    return <span className={cn('text-[13px]', value ? 'text-fg' : 'text-muted')}>{value ? 'Yes' : 'No'}</span>;
  }
  if (field.type === 'tags' || field.type === 'multiselect') {
    const arr = (value as string[] | null) ?? [];
    if (!arr.length) return <span className="text-muted">—</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {arr.slice(0, 3).map((t) => (
          <span key={t} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">{t}</span>
        ))}
        {arr.length > 3 && <span className="text-[11px] text-muted">+{arr.length - 3}</span>}
      </span>
    );
  }
  if (field.type === 'url' && value) {
    return (
      <a href={String(value)} target="_blank" rel="noreferrer"
         className="truncate text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
        {String(value).replace(/^https?:\/\//, '')}
      </a>
    );
  }
  if (field.type === 'datetime' && value) {
    return <span className="tabular-nums">{new Date(String(value)).toLocaleString()}</span>;
  }
  if (field.type === 'date' && value) {
    return <span className="tabular-nums">{String(value)}</span>;
  }
  if (value == null || value === '') return <span className="text-muted">—</span>;
  return <span className="truncate">{String(value)}</span>;
}

/* ------------------------------------------------------------------ */
function Control({
  field, row, value, variant, autoFocus, onCommit, onDone,
}: FieldEditorProps & { autoFocus?: boolean; onDone?: () => void }) {
  const [draft, setDraft] = useState<unknown>(value ?? '');
  const ref = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(null);
  const isCell = variant === 'cell';
  const relQuery = useOptions(field.relation);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const base = cn(
    'w-full rounded border bg-surface text-[13px] outline-none',
    'focus:ring-2 focus:ring-accent/50 border-border',
    isCell ? 'h-7 px-1.5' : 'h-8 px-2',
  );

  const commit = (v: unknown) => {
    const normalised = v === '' ? null : v;
    if (normalised !== (value ?? null)) onCommit(normalised);
    onDone?.();
  };

  const keyHandler = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setDraft(value ?? ''); onDone?.(); }
    // Tab commits and moves on — the list is navigable entirely by keyboard.
    if (e.key === 'Enter' && field.type !== 'longtext') { e.preventDefault(); commit(draft); }
  };

  switch (field.type) {
    case 'select':
      return (
        <select ref={ref as React.RefObject<HTMLSelectElement>} className={base}
          value={(draft as string) ?? ''} onKeyDown={keyHandler}
          onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}>
          <option value="">—</option>
          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );

    case 'user':
    case 'client':
    case 'relation':
      return (
        <select ref={ref as React.RefObject<HTMLSelectElement>} className={base}
          value={(draft as string) ?? ''} onKeyDown={keyHandler}
          onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}>
          <option value="">Unassigned</option>
          {relQuery.data?.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      );

    case 'boolean':
      return (
        <label className={cn('flex items-center', isCell ? 'px-2 py-1' : 'py-1')}>
          <input type="checkbox" checked={Boolean(draft)}
            onChange={(e) => { setDraft(e.target.checked); commit(e.target.checked); }}
            className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
        </label>
      );

    case 'longtext':
      return (
        <textarea ref={ref as React.RefObject<HTMLTextAreaElement>}
          className={cn(base, 'h-auto min-h-[80px] resize-y py-1.5 leading-relaxed')}
          value={(draft as string) ?? ''} onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(draft)} />
      );

    case 'tags':
    case 'multiselect':
      return (
        <input ref={ref as React.RefObject<HTMLInputElement>} className={base}
          value={Array.isArray(draft) ? (draft as string[]).join(', ') : String(draft ?? '')}
          placeholder="comma separated"
          onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
          onBlur={() => commit(Array.isArray(draft) ? draft : [])} />
      );

    case 'number':
      return (
        <input ref={ref as React.RefObject<HTMLInputElement>} type="number" className={cn(base, 'tabular-nums')}
          value={(draft as string) ?? ''} onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft === '' ? null : Number(draft))} />
      );

    case 'date':
    case 'time':
      return (
        <input ref={ref as React.RefObject<HTMLInputElement>} type={field.type} className={base}
          value={(draft as string)?.slice(0, field.type === 'time' ? 5 : 10) ?? ''}
          onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(draft)} />
      );

    case 'datetime': {
      const local = draft ? new Date(String(draft)) : null;
      const asInput = local && !Number.isNaN(local.getTime())
        ? new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
        : '';
      return (
        <input ref={ref as React.RefObject<HTMLInputElement>} type="datetime-local" className={base}
          value={asInput} onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value ? new Date(e.target.value).toISOString() : '')}
          onBlur={() => commit(draft)} />
      );
    }

    default:
      return (
        <input ref={ref as React.RefObject<HTMLInputElement>}
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
          className={base} value={(draft as string) ?? ''} onKeyDown={keyHandler}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(draft)} />
      );
  }
}

export { ReadOnly as FieldValue };
