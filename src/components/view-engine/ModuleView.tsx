'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ListView } from './ListView';
import { KanbanView } from './KanbanView';
import { CalendarView } from './CalendarView';
import { TimelineView } from './TimelineView';
import { FilterBar } from './FilterBar';
import { SavedViews, type SavedView } from './SavedViews';
import { BulkBar } from './BulkBar';
import { BulkUploaderModal } from './BulkUploaderModal';
import { Button, ErrorBox } from '@/components/ui/primitives';
import { useRecords } from '@/lib/records';
import { useSession, can } from '@/lib/session';
import { defaultFilters, filtersToParams, paramsToFilters, type FilterState } from '@/lib/filters';
import { exportRecords } from '@/lib/export';
import { pushToast } from '@/components/ui/Toaster';
import type { ModuleDef, ViewMode } from '@/modules/types';
import { cn } from '@/lib/utils';

const VIEW_LABEL: Record<ViewMode, string> = {
  list: 'List', kanban: 'Kanban', calendar: 'Calendar', timeline: 'Timeline',
};

/**
 * The shared view engine. Every module renders through this one component,
 * so all four view modes, the filters, saved views, inline editing, bulk
 * actions and export behave identically everywhere — a new module is a
 * registry entry, not a new screen.
 */
export function ModuleView({ mod }: { mod: ModuleDef }) {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session } = useSession();

  const [viewMode, setViewMode] = useState<ViewMode>(
    (params.get('view') as ViewMode) ?? mod.defaultView,
  );
  const [filters, setFilters] = useState<FilterState>(() => paramsToFilters(params, mod));
  const [sorting, setSorting] = useState(mod.defaultSort.map((s) => ({ id: s.key, desc: s.desc })));
  const [groupBy, setGroupBy] = useState(mod.kanbanGroupBy ?? 'status');
  const [columns, setColumns] = useState<string[]>(
    mod.fields.filter((f) => f.inList !== false).map((f) => f.key),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeView, setActiveView] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [showColumns, setShowColumns] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);

  const timezone = session?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const isInitialMount = useRef(true);

  // Keep the URL in step so a filtered view is a shareable link. What the
  // recipient sees is still bounded by their own permissions.
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const p = filtersToParams(filters);
    p.set('view', viewMode);
    router.replace(`?${p.toString()}`, { scroll: false });
  }, [filters, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useRecords({
    mod,
    filters,
    sort: sorting.map((s) => ({ key: s.id, desc: s.desc })),
    page,
    pageSize: viewMode === 'list' ? 100 : 500,
    timezone,
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.count ?? 0;

  const applyView = (v: SavedView) => {
    setActiveView(v.id);
    setFilters(v.filters);
    setViewMode(v.view_mode);
    if (v.columns?.length) setColumns(v.columns);
    if (v.sort?.length) setSorting(v.sort.map((s) => ({ id: s.key, desc: s.desc })));
    if (v.group_by) setGroupBy(v.group_by);
  };

  const availableViews = useMemo(
    () => mod.views.filter((v) =>
      (v !== 'calendar' || mod.calendar) && (v !== 'timeline' || mod.timeline) &&
      (v !== 'kanban' || mod.kanbanGroupBy)),
    [mod],
  );

  if (!can(session, mod.key, 'view')) {
    return (
      <div className="p-8">
        <ErrorBox error={`You do not have access to ${mod.label}. If that is unexpected, ask a Founder to review your role in Settings → Roles & Permissions.`} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">{mod.label}</h1>
          <span className="text-[13px] tabular-nums text-muted">{total.toLocaleString()}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex rounded-md border border-border p-0.5">
            {availableViews.map((v) => (
              <button key={v} onClick={() => setViewMode(v)}
                className={cn('rounded px-2 py-1 text-[12px]',
                  viewMode === v ? 'bg-accent text-white' : 'text-muted hover:bg-raised')}>
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>

          {viewMode === 'list' && (
            <Button variant="outline" onClick={() => setShowColumns((s) => !s)}>Columns</Button>
          )}

          {can(session, mod.key, 'export') && (
            <>
              <Button variant="outline" onClick={() => exportRecords(mod, rows, 'csv')}>CSV</Button>
              <Button variant="outline" onClick={() => exportRecords(mod, rows, 'xlsx')}>Excel</Button>
            </>
          )}

          {can(session, mod.key, 'create') && (
            <>
              <Button variant="outline" onClick={() => setImportModalOpen(true)}>Import</Button>
              <Link href={`/${mod.key}/new`}>
                <Button variant="primary">New {mod.singular.toLowerCase()}</Button>
              </Link>
            </>
          )}
        </div>
      </header>

      {importModalOpen && (
        <BulkUploaderModal mod={mod} onClose={() => setImportModalOpen(false)} />
      )}

      <SavedViews
        mod={mod}
        current={{ filters, columns, sort: sorting.map((s) => ({ key: s.id, desc: s.desc })), viewMode, groupBy }}
        activeId={activeView}
        onApply={applyView}
        onClear={() => { setActiveView(null); setFilters(defaultFilters(mod)); }}
      />

      <FilterBar mod={mod} value={filters} onChange={(f) => { setFilters(f); setPage(0); }} />

      {showColumns && viewMode === 'list' && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-raised/40 p-2.5">
          {mod.fields.map((f) => (
            <label key={f.key} className="flex items-center gap-1.5 text-[12px]">
              <input type="checkbox" className="h-3 w-3 accent-[rgb(var(--accent))]"
                checked={columns.includes(f.key)}
                onChange={(e) => setColumns((c) =>
                  e.target.checked ? [...c, f.key] : c.filter((k) => k !== f.key))} />
              {f.label}
            </label>
          ))}
        </div>
      )}

      {query.error && <ErrorBox error={query.error} />}

      <div className="min-h-0 flex-1">
        {viewMode === 'list' && (
          <ListView
            mod={mod} rows={rows} loading={query.isLoading} session={session}
            columns={columns} sorting={sorting} onSortingChange={setSorting}
            selected={selected} onSelectedChange={setSelected}
          />
        )}
        {viewMode === 'kanban' && (
          <KanbanView mod={mod} rows={rows} loading={query.isLoading} session={session}
            groupBy={groupBy} onGroupByChange={setGroupBy} />
        )}
        {viewMode === 'calendar' && mod.calendar && (
          <CalendarView mod={mod} rows={rows} session={session} timezone={timezone} />
        )}
        {viewMode === 'timeline' && mod.timeline && <TimelineView mod={mod} rows={rows} />}
      </div>

      {viewMode === 'list' && total > 100 && (
        <div className="flex items-center justify-between text-[13px] text-muted">
          <span>Showing {page * 100 + 1}–{Math.min((page + 1) * 100, total)} of {total.toLocaleString()}</span>
          <div className="flex gap-1.5">
            <Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button disabled={(page + 1) * 100 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <BulkBar
          mod={mod} session={session} ids={[...selected]} rows={rows}
          onDone={() => { setSelected(new Set()); pushToast('Bulk change applied'); }}
          onCancel={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}
