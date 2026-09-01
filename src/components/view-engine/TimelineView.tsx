'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Empty, StatusChip } from '@/components/ui/primitives';
import { useOptions } from '@/lib/records';
import type { ModuleDef } from '@/modules/types';
import { cn } from '@/lib/utils';

interface Props {
  mod: ModuleDef;
  rows: Record<string, unknown>[];
}

const DAY = 86_400_000;

/**
 * A dependency-aware Gantt. Rows are grouped by the module's timeline
 * groupBy (client, assignee, manager...), and each bar is positioned from
 * the record's own start/end columns — the same columns the dependency
 * engine shifts, so what you see here is what the database will cascade.
 */
export function TimelineView({ mod, rows }: Props) {
  const cfg = mod.timeline!;
  const [zoom, setZoom] = useState<'week' | 'month' | 'quarter'>('month');
  const groupField = mod.fields.find((f) => f.key === cfg.groupBy);
  const groupOptions = useOptions(groupField?.relation);

  const pxPerDay = zoom === 'week' ? 34 : zoom === 'month' ? 12 : 5;

  const { start, end, days } = useMemo(() => {
    const dates = rows.flatMap((r) => [r[cfg.start], r[cfg.end]])
      .filter(Boolean).map((d) => new Date(String(d)).getTime())
      .filter((n) => !Number.isNaN(n));
    const today = Date.now();
    const min = dates.length ? Math.min(...dates, today) : today;
    const max = dates.length ? Math.max(...dates, today) : today + 30 * DAY;
    const s = new Date(min - 3 * DAY);
    const e = new Date(max + 3 * DAY);
    return { start: s, end: e, days: Math.ceil((e.getTime() - s.getTime()) / DAY) };
  }, [rows, cfg]);

  const groups = useMemo(() => {
    const label = (id: string) => {
      if (!id) return 'Unassigned';
      const opt = groupOptions.data?.find((o) => o.id === id);
      if (opt) return opt.label;
      const row = rows.find((r) => String(r[cfg.groupBy!] ?? '') === id);
      const embed = row?.[cfg.groupBy!.replace(/_id$/, '')] as Record<string, unknown> | undefined;
      return String(embed?.brand_name ?? embed?.full_name ?? embed?.name ?? id.slice(0, 8));
    };
    const m = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const k = cfg.groupBy ? String(r[cfg.groupBy] ?? '') : '';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m].map(([id, items]) => ({ id, label: label(id), items }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, cfg, groupOptions.data]);

  if (!rows.length) return <Empty title={`No ${mod.label.toLowerCase()} to place on a timeline`} />;

  const offset = (d: unknown) => {
    if (!d) return null;
    const t = new Date(String(d)).getTime();
    if (Number.isNaN(t)) return null;
    return Math.round((t - start.getTime()) / DAY);
  };
  const todayOffset = Math.round((Date.now() - start.getTime()) / DAY);

  const months: { label: string; span: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const label = d.toLocaleString(undefined, { month: 'short', year: '2-digit' });
    const last = months[months.length - 1];
    if (last?.label === label) last.span++;
    else months.push({ label, span: 1 });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted">Zoom</span>
        {(['week', 'month', 'quarter'] as const).map((z) => (
          <button key={z} onClick={() => setZoom(z)}
            className={cn('rounded px-2 py-0.5 text-[12px]',
              zoom === z ? 'bg-accent text-white' : 'border border-border hover:bg-raised')}>
            {z}
          </button>
        ))}
      </div>

      <div className="scroll-thin overflow-auto rounded-lg border border-border bg-surface">
        <div className="flex">
          {/* Fixed label gutter */}
          <div className="sticky left-0 z-10 w-[220px] shrink-0 border-r border-border bg-surface">
            <div className="h-9 border-b border-border" />
            {groups.map((g) => (
              <div key={g.id || 'none'}>
                <div className="flex h-8 items-center border-b border-border bg-raised/50 px-3 text-[12px] font-medium">
                  {g.label}
                </div>
                {g.items.map((r) => (
                  <Link key={String(r.id)} href={`/${mod.key}/${String(r.id)}`}
                    className="flex h-8 items-center truncate border-b border-border/60 px-3 text-[12px] hover:bg-raised">
                    {String(r[mod.titleField] ?? '')}
                  </Link>
                ))}
              </div>
            ))}
          </div>

          {/* Scrollable canvas */}
          <div style={{ width: days * pxPerDay }} className="relative">
            <div className="flex h-9 border-b border-border">
              {months.map((m, i) => (
                <div key={i} style={{ width: m.span * pxPerDay }}
                  className="shrink-0 border-r border-border px-2 text-[11px] leading-9 text-muted">
                  {m.span * pxPerDay > 40 ? m.label : ''}
                </div>
              ))}
            </div>

            {todayOffset >= 0 && todayOffset <= days && (
              <div className="absolute bottom-0 top-9 z-10 w-px bg-red/70"
                style={{ left: todayOffset * pxPerDay }} title="Today" />
            )}

            {groups.map((g) => (
              <div key={g.id || 'none'}>
                <div className="h-8 border-b border-border bg-raised/50" />
                {g.items.map((r) => {
                  const s = offset(r[cfg.start]);
                  const e = offset(r[cfg.end]) ?? s;
                  const status = String(r.status ?? '');
                  const overdue = e != null && e < todayOffset &&
                    !['Delivered', 'Approved', 'Cancelled', 'Completed'].includes(status);
                  return (
                    <div key={String(r.id)} className="relative h-8 border-b border-border/60">
                      {s != null && (
                        <Link href={`/${mod.key}/${String(r.id)}`}
                          style={{ left: s * pxPerDay, width: Math.max(pxPerDay, ((e ?? s) - s + 1) * pxPerDay) }}
                          className={cn('absolute top-1.5 flex h-5 items-center rounded px-1.5 text-[10px] text-white',
                            overdue ? 'bg-red' : status === 'Blocked' ? 'bg-red'
                            : status === 'In Progress' ? 'bg-accent'
                            : ['Delivered','Approved','Completed'].includes(status) ? 'bg-green' : 'bg-muted')}
                          title={`${String(r[mod.titleField])} · ${r[cfg.start]} → ${r[cfg.end] ?? r[cfg.start]}`}>
                          <span className="truncate">{String(r[mod.titleField] ?? '')}</span>
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted">
        Bars read the same start and end columns the dependency engine shifts. Moving a date here or
        anywhere else cascades the chain and is written to the audit log.
      </p>
    </div>
  );
}
