'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FieldEditor } from './FieldEditor';
import { Button, Card, Spinner, ErrorBox, StatusChip, Avatar } from '@/components/ui/primitives';
import { useRecord, useUpdateRecord, useHistory, useSoftDelete } from '@/lib/records';
import { useSession, can } from '@/lib/session';
import { pushToast } from '@/components/ui/Toaster';
import { RelatedRecords } from './RelatedRecords';
import { Comments } from './Comments';
import { ClientContextBanner } from './ClientContextBanner';
import { isEditable, sections, type FieldDef, type ModuleDef } from '@/modules/types';
import { cn } from '@/lib/utils';

type Tab = 'details' | 'related' | 'comments' | 'history';

/**
 * The detail page.
 *
 * It renders the SAME FieldEditor with the SAME editability rule as the
 * list view, and commits through the SAME useUpdateRecord mutation. That
 * is the whole reason the two surfaces cannot drift apart in validation
 * or permissions.
 */
export function DetailView({ mod, id }: { mod: ModuleDef; id: string }) {
  const { data: session } = useSession();
  const record = useRecord(mod, id);
  const update = useUpdateRecord();
  const del = useSoftDelete();
  const [tab, setTab] = useState<Tab>('details');

  if (record.isLoading) return <Spinner label={`Loading ${mod.singular.toLowerCase()}`} />;
  if (record.error) return <div className="p-4"><ErrorBox error={record.error} /></div>;
  if (!record.data) {
    return (
      <div className="p-8">
        <ErrorBox error={`This ${mod.singular.toLowerCase()} is not visible to you, or does not exist.`} />
      </div>
    );
  }

  const row = record.data;

  // Identical guard to ListView.editableFor — deliberately the same rule.
  const guardFor = (f: FieldDef) => {
    if (!isEditable(f)) {
      return { ok: false, why: f.inheritedFrom
        ? `Inherited from the ${f.inheritedFrom} — change it there and it updates everywhere.`
        : 'Computed automatically from other records.' };
    }
    const action = f.permissionAction ?? 'edit';
    if (!can(session, mod.key, action)) {
      return { ok: false, why: `You do not have ${action} permission on ${mod.label}.` };
    }
    return { ok: true, why: '' };
  };

  const client = row.client as { id?: string; brand_name?: string } | null;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <nav className="flex items-center gap-1.5 text-[12px] text-muted">
            <Link href={`/${mod.key}`} className="hover:text-accent">{mod.label}</Link>
            <span>/</span>
            <span className="truncate">{String(row[mod.titleField] ?? mod.singular)}</span>
          </nav>
          <h1 className="mt-0.5 truncate text-lg font-semibold">
            {String(row[mod.titleField] ?? 'Untitled')}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            {client?.brand_name && (
              <Link href={`/clients/${client.id}`} className="hover:text-accent">{client.brand_name}</Link>
            )}
            {typeof row.status === 'string' && <StatusChip value={row.status} />}
            {typeof row.approval_status === 'string' && <StatusChip value={row.approval_status} />}
            {row.deleted_at != null && (
              <span className="rounded bg-red/10 px-1.5 py-0.5 text-red">In Recycle Bin</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {can(session, mod.key, 'delete') && mod.softDelete && !row.deleted_at && (
            <Button variant="danger"
              onClick={() => del.mutate({ mod, ids: [id] }, {
                onSuccess: () => pushToast('Moved to the Recycle Bin — recoverable by a Founder'),
              })}>
              Delete
            </Button>
          )}
        </div>
      </header>

      {Boolean(row.client_id || client?.id) && mod.key !== 'clients' && (
        <ClientContextBanner clientId={String(row.client_id ?? client?.id)} />
      )}

      <nav className="flex gap-1 border-b border-border">
        {(['details', 'related', 'comments', 'history'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 px-3 py-1.5 text-[13px] capitalize',
              tab === t ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg')}>
            {t === 'history' ? 'History' : t}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'details' && (
          <div className="grid gap-3 lg:grid-cols-2">
            {sections(mod).map((s) => (
              <Card key={s.name} title={s.name}>
                <dl className="space-y-2.5">
                  {s.fields.map((f) => {
                    const guard = guardFor(f);
                    return (
                      <div key={f.key} className="grid grid-cols-[150px_1fr] items-start gap-3">
                        <dt className="pt-1 text-[12px] text-muted" title={f.help}>
                          {f.label}
                          {f.required && <span className="text-red"> *</span>}
                          {!guard.ok && <span className="ml-1 text-[10px]" title={guard.why}>🔒</span>}
                        </dt>
                        <dd>
                          <FieldEditor
                            field={f}
                            row={row}
                            value={row[f.key]}
                            variant="form"
                            disabled={!guard.ok}
                            lockedReason={guard.why}
                            onCommit={(next) =>
                              update.mutate(
                                { mod, id, patch: { [f.key]: next }, previous: row },
                                { onError: (e) => pushToast(e instanceof Error ? e.message : 'Update failed', 'error') },
                              )
                            }
                          />
                          {f.help && <p className="mt-0.5 text-[11px] text-muted">{f.help}</p>}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </Card>
            ))}
          </div>
        )}

        {tab === 'related' && <RelatedRecords mod={mod} row={row} />}
        {tab === 'comments' && <Comments entityType={mod.table} entityId={id} clientId={(row.client_id as string) ?? null} />}
        {tab === 'history' && <HistoryTab entityType={mod.table} entityId={id} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
function HistoryTab({ entityType, entityId }: { entityType: string; entityId: string }) {
  const history = useHistory(entityType, entityId);
  if (history.isLoading) return <Spinner />;
  if (history.error) return <ErrorBox error={history.error} />;
  const rows = history.data ?? [];

  return (
    <Card title={`History · ${rows.length} change${rows.length === 1 ? '' : 's'}`}>
      {!rows.length && <p className="text-[13px] text-muted">No recorded changes yet.</p>}
      <ol className="space-y-2">
        {rows.map((h) => (
          <li key={h.id} className="flex gap-3 border-l-2 border-border pl-3 text-[13px]">
            <Avatar name={h.actor_name} size={20} />
            <div className="min-w-0 flex-1">
              <p>
                <span className="font-medium">{h.is_system ? 'System' : h.actor_name}</span>{' '}
                <span className="text-muted">{h.summary}</span>
              </p>
              <p className="text-[11px] text-muted">{new Date(h.changed_at).toLocaleString()}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted">
        Every insert, update and delete is recorded by a database trigger, including bulk edits and
        automated changes. The log is append-only — it cannot be rewritten from the application.
      </p>
    </Card>
  );
}
