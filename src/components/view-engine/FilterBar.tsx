'use client';

import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';
import { useOptions } from '@/lib/records';
import { DATE_PRESETS, activeFilterCount, type FilterState } from '@/lib/filters';
import type { ModuleDef } from '@/modules/types';
import { cn } from '@/lib/utils';

interface Props {
  mod: ModuleDef;
  value: FilterState;
  onChange: (f: FilterState) => void;
}

/**
 * Present on every module. The date-field picker is the important part:
 * the user chooses WHICH date the range applies to (due, start, post,
 * shoot, renewal, created), rather than the module deciding for them.
 */
export function FilterBar({ mod, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  const n = activeFilterCount(value);

  const clients = useOptions(mod.clientScoped ? { table: 'clients', labelKey: 'brand_name', orderBy: 'brand_name' } : undefined);
  const users = useOptions({ table: 'users', labelKey: 'full_name', orderBy: 'full_name' });

  const statusField = mod.fields.find((f) => f.key === 'status');
  const approvalField = mod.fields.find((f) => f.key === 'approval_status');
  const priorityField = mod.fields.find((f) => f.key === 'priority');
  const platformField = mod.fields.find((f) => f.key === 'platform');
  const stageField = mod.fields.find((f) => f.key === 'stage');
  const assigneeKey = mod.fields.find((f) => ['assignee_id', 'owner_id'].includes(f.key))?.key;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={`Search ${mod.label.toLowerCase()}…`}
          value={value.q ?? ''}
          onChange={(e) => set({ q: e.target.value || undefined })}
          className="h-8 w-56"
        />

        {/* Which date column the range filters on. */}
        <select value={value.dateField} onChange={(e) => set({ dateField: e.target.value })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
          title="Which date does the range apply to?">
          {mod.dateFields.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>

        <select value={value.preset} onChange={(e) => set({ preset: e.target.value as FilterState['preset'] })}
          className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]">
          {DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>

        {value.preset === 'custom' && (
          <>
            <Input type="date" value={value.from ?? ''} onChange={(e) => set({ from: e.target.value })} className="h-8 w-36" />
            <span className="text-muted">→</span>
            <Input type="date" value={value.to ?? ''} onChange={(e) => set({ to: e.target.value })} className="h-8 w-36" />
          </>
        )}

        <Button variant={open ? 'primary' : 'outline'} onClick={() => setOpen((o) => !o)}>
          Filters{n > 0 && <span className="ml-1 rounded bg-accent/20 px-1 text-[11px]">{n}</span>}
        </Button>

        {n > 0 && (
          <Button variant="ghost" onClick={() => onChange({ dateField: value.dateField, preset: 'any' })}>
            Clear
          </Button>
        )}
      </div>

      {open && (
        <div className="grid gap-3 rounded-lg border border-border bg-raised/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {mod.clientScoped && (
            <Multi label="Client" options={clients.data ?? []}
              selected={value.client_id ?? []} onChange={(v) => set({ client_id: v })} />
          )}
          {statusField?.options && (
            <Multi label="Status" options={statusField.options.map((o) => ({ id: o, label: o }))}
              selected={value.status ?? []} onChange={(v) => set({ status: v })} />
          )}
          {approvalField?.options && (
            <Multi label="Approval" options={approvalField.options.map((o) => ({ id: o, label: o }))}
              selected={value.approval_status ?? []} onChange={(v) => set({ approval_status: v })} />
          )}
          {stageField?.options && (
            <Multi label="Stage" options={stageField.options.map((o) => ({ id: o, label: o }))}
              selected={value.stage ?? []} onChange={(v) => set({ stage: v })} />
          )}
          {priorityField?.options && (
            <Multi label="Priority" options={priorityField.options.map((o) => ({ id: o, label: o }))}
              selected={value.priority ?? []} onChange={(v) => set({ priority: v })} />
          )}
          {platformField?.options && (
            <Multi label="Platform" options={platformField.options.map((o) => ({ id: o, label: o }))}
              selected={value.platform ?? []} onChange={(v) => set({ platform: v })} />
          )}
          {assigneeKey && (
            <Multi label={assigneeKey === 'assignee_id' ? 'Assignee' : 'Owner'}
              options={users.data ?? []}
              selected={(assigneeKey === 'assignee_id' ? value.assignee_id : value.owner_id) ?? []}
              onChange={(v) => set(assigneeKey === 'assignee_id' ? { assignee_id: v } : { owner_id: v })} />
          )}
          {mod.softDelete && (
            <label className="flex items-end gap-2 text-[13px]">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                checked={Boolean(value.includeDeleted)}
                onChange={(e) => set({ includeDeleted: e.target.checked })} />
              Include deleted (Founder only)
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function Multi({ label, options, selected, onChange }: {
  label: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="scroll-thin max-h-28 space-y-0.5 overflow-y-auto rounded border border-border bg-surface p-1.5">
        {options.length === 0 && <p className="px-1 text-[12px] text-muted">None available</p>}
        {options.map((o) => (
          <label key={o.id} className={cn('flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[12px] hover:bg-raised')}>
            <input type="checkbox" className="h-3 w-3 accent-[rgb(var(--accent))]"
              checked={selected.includes(o.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((s) => s !== o.id))} />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
