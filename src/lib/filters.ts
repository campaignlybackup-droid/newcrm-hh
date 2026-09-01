import type { ModuleDef } from '@/modules/types';

export type DatePreset =
  | 'any' | 'today' | 'tomorrow' | 'this_week' | 'next_7' | 'next_30'
  | 'overdue' | 'this_month' | 'last_30' | 'custom';

export interface FilterState {
  /** Which date column the range applies to. */
  dateField: string;
  preset: DatePreset;
  from?: string;
  to?: string;
  client_id?: string[];
  project_id?: string[];
  status?: string[];
  approval_status?: string[];
  assignee_id?: string[];
  reviewer_id?: string[];
  owner_id?: string[];
  department_id?: string[];
  priority?: string[];
  platform?: string[];
  content_type?: string[];
  type?: string[];
  stage?: string[];
  tag?: string[];
  q?: string;
  includeDeleted?: boolean;
  /** Lets paramsToFilters write array keys back generically. */
  [key: string]: unknown;
}

export const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'any', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'this_week', label: 'This week' },
  { key: 'next_7', label: 'Next 7 days' },
  { key: 'next_30', label: 'Next 30 days' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom range' },
];

const ARRAY_KEYS = [
  'client_id','project_id','status','approval_status','assignee_id','reviewer_id',
  'owner_id','department_id','priority','platform','content_type','type','stage','tag',
] as const;

/**
 * Resolves a preset into a concrete [from, to] pair IN THE VIEWER'S
 * TIMEZONE, then hands back plain YYYY-MM-DD strings. Timestamps are
 * stored in UTC and compared as instants, so the same preset gives the
 * right answer for a viewer in Auckland and one in Los Angeles.
 */
export function resolveRange(
  preset: DatePreset,
  timezone: string,
  custom?: { from?: string; to?: string },
): { from?: string; to?: string } {
  if (preset === 'any') return {};
  if (preset === 'custom') return { from: custom?.from, to: custom?.to };

  const now = new Date();
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const day = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const shift = (n: number) => {
    const d = new Date(localNow);
    d.setDate(d.getDate() + n);
    return d;
  };

  switch (preset) {
    case 'today':      return { from: day(localNow), to: day(localNow) };
    case 'tomorrow':   return { from: day(shift(1)), to: day(shift(1)) };
    case 'this_week': {
      const dow = (localNow.getDay() + 6) % 7; // Monday = 0
      return { from: day(shift(-dow)), to: day(shift(6 - dow)) };
    }
    case 'next_7':     return { from: day(localNow), to: day(shift(7)) };
    case 'next_30':    return { from: day(localNow), to: day(shift(30)) };
    case 'last_30':    return { from: day(shift(-30)), to: day(localNow) };
    case 'overdue':    return { to: day(shift(-1)) };
    case 'this_month': {
      const s = new Date(localNow.getFullYear(), localNow.getMonth(), 1);
      const e = new Date(localNow.getFullYear(), localNow.getMonth() + 1, 0);
      return { from: day(s), to: day(e) };
    }
    default: return {};
  }
}

export function defaultFilters(mod: ModuleDef): FilterState {
  return { dateField: mod.dateFields[0]?.key ?? 'created_at', preset: 'any' };
}

/** Filter state <-> URL, so a view is a shareable link (within permission limits). */
export function filtersToParams(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.dateField) p.set('df', f.dateField);
  if (f.preset && f.preset !== 'any') p.set('dp', f.preset);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.q) p.set('q', f.q);
  if (f.includeDeleted) p.set('deleted', '1');
  for (const k of ARRAY_KEYS) {
    const v = f[k];
    if (v?.length) p.set(k, v.join(','));
  }
  return p;
}

export function paramsToFilters(p: URLSearchParams, mod: ModuleDef): FilterState {
  const f: FilterState = {
    dateField: p.get('df') ?? mod.dateFields[0]?.key ?? 'created_at',
    preset: (p.get('dp') as DatePreset) ?? 'any',
    from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined,
    q: p.get('q') ?? undefined,
    includeDeleted: p.get('deleted') === '1',
  };
  for (const k of ARRAY_KEYS) {
    const v = p.get(k);
    if (v) f[k] = v.split(',').filter(Boolean);
  }
  return f;
}

export function activeFilterCount(f: FilterState): number {
  let n = 0;
  if (f.preset && f.preset !== 'any') n++;
  if (f.q) n++;
  for (const k of ARRAY_KEYS) if (f[k]?.length) n++;
  return n;
}
