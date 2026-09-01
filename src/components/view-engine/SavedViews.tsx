'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { Button } from '@/components/ui/primitives';
import { pushToast } from '@/components/ui/Toaster';
import type { FilterState } from '@/lib/filters';
import type { ModuleDef, ViewMode } from '@/modules/types';
import { cn } from '@/lib/utils';

export interface SavedView {
  id: string;
  name: string;
  module: string;
  view_mode: ViewMode;
  filters: FilterState;
  columns: string[];
  sort: { key: string; desc: boolean }[];
  group_by: string | null;
  is_pinned: boolean;
  is_shared: boolean;
  is_default: boolean;
}

export function useSavedViews(module: string) {
  return useQuery({
    queryKey: ['saved_views', module],
    queryFn: async () => {
      const { data, error } = await supabase()
        .from('saved_views').select('*').eq('module', module).order('sort_order');
      if (error) throw error;
      return (data ?? []) as unknown as SavedView[];
    },
  });
}

interface Props {
  mod: ModuleDef;
  current: { filters: FilterState; columns: string[]; sort: { key: string; desc: boolean }[]; viewMode: ViewMode; groupBy?: string };
  activeId: string | null;
  onApply: (v: SavedView) => void;
  onClear: () => void;
}

export function SavedViews({ mod, current, activeId, onApply, onClear }: Props) {
  const qc = useQueryClient();
  const views = useSavedViews(mod.key);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const { data: me } = await supabase().rpc('my_context');
      const userId = (me as unknown as { user?: { id?: string } } | null)?.user?.id;
      if (!userId) throw new Error('Not signed in');
      const { error } = await supabase().from('saved_views').insert({
        user_id: userId,
        module: mod.key,
        name,
        view_mode: current.viewMode,
        filters: current.filters as never,
        columns: current.columns as never,
        sort: current.sort as never,
        group_by: current.groupBy ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNaming(false); setName('');
      qc.invalidateQueries({ queryKey: ['saved_views', mod.key] });
      pushToast('View saved');
    },
    onError: (e) => pushToast(e instanceof Error ? e.message : 'Could not save view', 'error'),
  });

  const pin = useMutation({
    mutationFn: async (v: SavedView) => {
      const { error } = await supabase().from('saved_views')
        .update({ is_pinned: !v.is_pinned }).eq('id', v.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved_views', mod.key] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase().from('saved_views').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved_views', mod.key] }),
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button onClick={onClear}
        className={cn('rounded px-2 py-1 text-[12px]', !activeId ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised')}>
        All {mod.label.toLowerCase()}
      </button>

      {views.data?.map((v) => (
        <span key={v.id} className="group inline-flex items-center">
          <button onClick={() => onApply(v)}
            className={cn('rounded-l px-2 py-1 text-[12px]',
              activeId === v.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised')}>
            {v.is_pinned && '📌 '}{v.name}
          </button>
          <button onClick={() => pin.mutate(v)} title={v.is_pinned ? 'Unpin' : 'Pin to sidebar'}
            className="hidden px-1 text-[11px] text-muted hover:text-accent group-hover:inline">⌁</button>
          <button onClick={() => remove.mutate(v.id)} title="Delete view"
            className="hidden rounded-r px-1 text-[11px] text-muted hover:text-red group-hover:inline">✕</button>
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            onKeyDown={(e) => { if (e.key === 'Enter' && name) save.mutate(); if (e.key === 'Escape') setNaming(false); }}
            className="h-7 w-36 rounded border border-border bg-surface px-2 text-[12px]" />
          <Button variant="primary" disabled={!name} onClick={() => save.mutate()}>Save</Button>
          <Button variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </span>
      ) : (
        <Button variant="ghost" onClick={() => setNaming(true)} title="Save the current filters, columns and sort">
          + Save view
        </Button>
      )}
    </div>
  );
}
