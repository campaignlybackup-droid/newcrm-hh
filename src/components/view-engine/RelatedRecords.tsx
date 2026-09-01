'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabaseDynamic } from '@/lib/supabase/client';
import { Card, StatusChip, Spinner, Empty } from '@/components/ui/primitives';
import type { ModuleDef } from '@/modules/types';

/**
 * Child records, read live rather than duplicated. The client fields shown
 * beside them come from the client row itself — this panel is one of the
 * six-plus places the same single client record renders.
 */
const CHILDREN: Record<string, { table: string; fk: string; title: string; label: string; module: string; extra?: string }[]> = {
  clients: [
    { table: 'projects',        fk: 'client_id', title: 'name',  label: 'Projects',     module: 'projects' },
    { table: 'deliverables',    fk: 'client_id', title: 'title', label: 'Deliverables', module: 'deliverables' },
    { table: 'shoots',          fk: 'client_id', title: 'title', label: 'Shoots',       module: 'shoots' },
    { table: 'content_calendar',fk: 'client_id', title: 'title', label: 'Posts',        module: 'content_calendar' },
    { table: 'meetings',        fk: 'client_id', title: 'title', label: 'Meetings',     module: 'meetings' },
    { table: 'client_contacts', fk: 'client_id', title: 'name',  label: 'Contacts',     module: 'clients' },
  ],
  projects: [
    { table: 'deliverables', fk: 'project_id', title: 'title', label: 'Deliverables', module: 'deliverables' },
    { table: 'tasks',        fk: 'project_id', title: 'title', label: 'Tasks',        module: 'tasks' },
  ],
  deliverables: [
    { table: 'tasks',     fk: 'deliverable_id', title: 'title',      label: 'Tasks',     module: 'tasks' },
    { table: 'assets',    fk: 'deliverable_id', title: 'name',       label: 'Assets',    module: 'assets' },
    { table: 'revisions', fk: 'deliverable_id', title: 'notes',      label: 'Revisions', module: 'deliverables' },
  ],
  tasks: [
    { table: 'checklist_items', fk: 'task_id', title: 'label', label: 'Checklist', module: 'tasks' },
    { table: 'assets',          fk: 'task_id', title: 'name',  label: 'Assets',    module: 'assets' },
  ],
  shoots: [
    { table: 'shoot_crew',         fk: 'shoot_id', title: 'role_on_shoot', label: 'Crew',      module: 'shoots' },
    { table: 'equipment_bookings', fk: 'shoot_id', title: 'purpose',       label: 'Equipment', module: 'equipment' },
  ],
  meetings: [
    { table: 'action_items', fk: 'meeting_id', title: 'description', label: 'Action items', module: 'tasks' },
  ],
};

export function RelatedRecords({ mod, row }: { mod: ModuleDef; row: Record<string, unknown> }) {
  const groups = CHILDREN[mod.key] ?? [];
  if (!groups.length) {
    return <Empty title="No related records for this module" />;
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {groups.map((g) => (
        <ChildList key={g.table} group={g} parentId={String(row.id)} />
      ))}
    </div>
  );
}

function ChildList({ group, parentId }: {
  group: { table: string; fk: string; title: string; label: string; module: string };
  parentId: string;
}) {
  const q = useQuery({
    queryKey: ['related', group.table, group.fk, parentId],
    queryFn: async () => {
      const { data, error } = await supabaseDynamic()
        .from(group.table).select('*').eq(group.fk, parentId).limit(50);
      if (error) throw error;
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  return (
    <Card title={`${group.label}${q.data ? ` · ${q.data.length}` : ''}`}>
      {q.isLoading && <Spinner />}
      {q.error && <p className="text-[13px] text-muted">Not visible to you.</p>}
      {q.data && !q.data.length && <p className="text-[13px] text-muted">None yet.</p>}
      <ul className="divide-y divide-border">
        {q.data?.map((r) => (
          <li key={String(r.id)} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <Link href={`/${group.module}/${String(r.id)}`} className="truncate hover:text-accent">
              {String(r[group.title] ?? '—')}
            </Link>
            <span className="flex shrink-0 items-center gap-2">
              {typeof r.due_date === 'string' && <span className="tabular-nums text-muted">{r.due_date}</span>}
              {typeof r.status === 'string' && <StatusChip value={r.status} />}
              {typeof r.is_done === 'boolean' && <StatusChip value={r.is_done ? 'Approved' : 'Not Started'} />}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
