'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, supabaseDynamic } from '@/lib/supabase/client';
import { modulePatchSchema, type ModuleDef } from '@/modules/types';
import { resolveRange, type FilterState } from '@/lib/filters';
import { pushUndo } from '@/components/ui/Toaster';

const PAGE = 100;

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function applyFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  mod: ModuleDef,
  f: FilterState,
  timezone: string,
) {
  if (mod.softDelete && !f.includeDeleted) q = q.is('deleted_at', null);

  const range = resolveRange(f.preset, timezone, { from: f.from, to: f.to });
  if (range.from) q = q.gte(f.dateField, range.from);
  if (range.to) {
    // A timestamptz column needs the end of the chosen day, not its start.
    const isInstant = f.dateField.endsWith('_at') || f.dateField.endsWith('_at_utc');
    q = isInstant ? q.lt(f.dateField, `${range.to}T23:59:59.999Z`) : q.lte(f.dateField, range.to);
  }

  const arrayFilters: [keyof FilterState, string][] = [
    ['client_id', 'client_id'], ['project_id', 'project_id'], ['status', 'status'],
    ['approval_status', 'approval_status'], ['assignee_id', 'assignee_id'],
    ['reviewer_id', 'reviewer_id'], ['owner_id', 'owner_id'],
    ['priority', 'priority'], ['platform', 'platform'],
    ['content_type', 'content_type'], ['type', 'type'], ['stage', 'stage'],
  ];
  for (const [key, col] of arrayFilters) {
    const vals = f[key] as string[] | undefined;
    if (vals?.length && mod.fields.some((fd) => fd.key === col)) q = q.in(col, vals);
  }

  if (f.q && mod.searchFields.length) {
    const term = f.q.replace(/[%,()]/g, ' ').trim();
    if (term) q = q.or(mod.searchFields.map((s) => `${s}.ilike.%${term}%`).join(','));
  }
  return q;
}

export interface ListArgs {
  mod: ModuleDef;
  filters: FilterState;
  sort: { key: string; desc: boolean }[];
  page?: number;
  pageSize?: number;
  timezone: string;
}

export function recordsKey(a: ListArgs) {
  return ['records', a.mod.key, a.filters, a.sort, a.page ?? 0, a.pageSize ?? PAGE];
}

/**
 * One query per list view. The joins are embedded in mod.select so the
 * client, assignee and parent titles arrive with the rows — never as a
 * follow-up request per row.
 */
export function useRecords(a: ListArgs) {
  return useQuery({
    queryKey: recordsKey(a),
    queryFn: async () => {
      const page = a.page ?? 0;
      const size = a.pageSize ?? PAGE;
      let q = supabaseDynamic().from(a.mod.table).select(a.mod.select, { count: 'exact' });
      q = applyFilters(q, a.mod, a.filters, a.timezone);
      for (const s of a.sort.length ? a.sort : a.mod.defaultSort) {
        q = q.order(s.key, { ascending: !s.desc, nullsFirst: false });
      }
      const { data, error, count } = await q.range(page * size, page * size + size - 1);
      if (error) throw error;
      return { rows: (data ?? []) as Record<string, unknown>[], count: count ?? 0 };
    },
    placeholderData: (prev) => prev,
  });
}

export function useRecord(mod: ModuleDef, id: string | undefined) {
  return useQuery({
    queryKey: ['record', mod.key, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabaseDynamic()
        .from(mod.table).select(mod.select).eq('id', id!).single();
      if (error) throw error;
      return data as Record<string, unknown>;
    },
  });
}

export interface PickerOption { id: string; label: string }

/** Options for a user/client/relation picker. Cached, so pickers never N+1. */
export function useOptions(rel?: { table: string; labelKey: string; orderBy?: string; filter?: Record<string, unknown> }) {
  return useQuery<PickerOption[]>({
    queryKey: ['options', rel?.table, rel?.labelKey, rel?.filter],
    enabled: Boolean(rel),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      let q = supabaseDynamic().from(rel!.table).select(`id, ${rel!.labelKey}`);
      if (rel!.filter) for (const [k, v] of Object.entries(rel!.filter)) q = q.eq(k, v);
      q = q.order(rel!.orderBy ?? rel!.labelKey, { ascending: true }).limit(500);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r: Record<string, unknown>): PickerOption => ({
        id: String(r.id),
        label: String(r[rel!.labelKey] ?? '—'),
      }));
    },
  });
}

/* ------------------------------------------------------------------ */
/* Writing — one mutation surface for list cells AND detail fields      */
/* ------------------------------------------------------------------ */

export interface PatchArgs {
  mod: ModuleDef;
  id: string;
  patch: Record<string, unknown>;
  /** Row as it was, so an optimistic update can be rolled back and undone. */
  previous?: Record<string, unknown>;
}

/**
 * The single write path. An inline cell edit and a detail-page field edit
 * both call this, so they validate identically (modulePatchSchema) and
 * are gated identically (RLS on the same UPDATE). There is no second,
 * looser mutation anywhere in the app.
 */
export function useUpdateRecord() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ mod, id, patch }: PatchArgs) => {
      const parsed = modulePatchSchema(mod).safeParse(patch);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      const { data, error } = await supabaseDynamic()
        .from(mod.table).update(parsed.data).eq('id', id).select(mod.select).single();
      if (error) throw error;
      return data as Record<string, unknown>;
    },

    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['records', vars.mod.key] });
      const snapshots = qc.getQueriesData({ queryKey: ['records', vars.mod.key] });
      // Optimistic: paint the new value immediately.
      qc.setQueriesData<{ rows: Record<string, unknown>[]; count: number }>(
        { queryKey: ['records', vars.mod.key] },
        (old) => old && {
          ...old,
          rows: old.rows.map((r) => (r.id === vars.id ? { ...r, ...vars.patch } : r)),
        },
      );
      qc.setQueryData<Record<string, unknown>>(
        ['record', vars.mod.key, vars.id],
        (old) => old && { ...old, ...vars.patch },
      );
      return { snapshots };
    },

    onError: (_err, vars, ctx) => {
      // Roll the optimistic paint back to exactly what was there before.
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      qc.invalidateQueries({ queryKey: ['record', vars.mod.key, vars.id] });
    },

    onSuccess: (_data, vars) => {
      if (vars.previous) {
        const undoPatch: Record<string, unknown> = {};
        for (const k of Object.keys(vars.patch)) undoPatch[k] = vars.previous[k] ?? null;
        pushUndo({
          message: `Updated ${vars.mod.singular.toLowerCase()}`,
          undo: async () => {
            await supabaseDynamic().from(vars.mod.table).update(undoPatch).eq('id', vars.id);
            qc.invalidateQueries({ queryKey: ['records', vars.mod.key] });
            qc.invalidateQueries({ queryKey: ['record', vars.mod.key, vars.id] });
          },
        });
      }
    },

    onSettled: (_d, _e, vars) => {
      // A write can cascade (rollups, dependency dates), so refetch broadly.
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['record', vars.mod.key, vars.id] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useCreateRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ mod, values }: { mod: ModuleDef; values: Record<string, unknown> }) => {
      const { data, error } = await supabaseDynamic()
        .from(mod.table).insert(values).select(mod.select).single();
      if (error) throw error;
      return data as Record<string, unknown>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['records'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Bulk status change / reassignment from the list-view selection bar. */
export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ mod, ids, patch }: { mod: ModuleDef; ids: string[]; patch: Record<string, unknown> }) => {
      const parsed = modulePatchSchema(mod).safeParse(patch);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
      const { data, error } = await supabaseDynamic()
        .from(mod.table).update(parsed.data).in('id', ids).select('id');
      if (error) throw error;
      // RLS silently drops rows the user may not edit; report the real number.
      return { requested: ids.length, applied: (data ?? []).length };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['records'] }),
  });
}

/** Soft delete — the row stays recoverable from the Recycle Bin. */
export function useSoftDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ mod, ids }: { mod: ModuleDef; ids: string[] }) => {
      for (const id of ids) {
        const { error } = await supabase().rpc('soft_delete', {
          p_entity_type: mod.table, p_id: id,
        });
        if (error) throw error;
      }
      return ids.length;
    },
    onSuccess: (_n, vars) => {
      qc.invalidateQueries({ queryKey: ['records'] });
      pushUndo({
        message: `Moved ${vars.ids.length} ${vars.mod.label.toLowerCase()} to the Recycle Bin`,
        undo: async () => {
          for (const id of vars.ids) {
            await supabase().rpc('restore_record', { p_entity_type: vars.mod.table, p_id: id });
          }
          qc.invalidateQueries({ queryKey: ['records'] });
        },
      });
    },
  });
}

export function useHistory(entityType: string, entityId: string | undefined) {
  return useQuery({
    queryKey: ['history', entityType, entityId],
    enabled: Boolean(entityId),
    queryFn: async () => {
      const { data, error } = await supabase().rpc('record_history', {
        p_entity_type: entityType, p_entity_id: entityId!, p_limit: 200,
      });
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: number; action: string; field_name: string | null; old_value: string | null;
        new_value: string | null; changed_at: string; actor_name: string;
        is_system: boolean; summary: string;
      }[];
    },
  });
}
