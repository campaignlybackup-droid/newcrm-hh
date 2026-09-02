'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FieldEditor } from './FieldEditor';
import { Button, Card, ErrorBox } from '@/components/ui/primitives';
import { useCreateRecord } from '@/lib/records';
import { useSession, can } from '@/lib/session';
import { supabase } from '@/lib/supabase/client';
import { pushToast } from '@/components/ui/Toaster';
import { isEditable, moduleSchema, sections, type ModuleDef } from '@/modules/types';

/**
 * Create form, rendered from the same field definitions as the list and
 * detail surfaces and validated with the same schema.
 */
export function CreateView({ mod }: { mod: ModuleDef }) {
  const router = useRouter();
  const { data: session } = useSession();
  const create = useCreateRecord();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  if (!can(session, mod.key, 'create')) {
    return <div className="p-8"><ErrorBox error={`You do not have permission to create a ${mod.singular.toLowerCase()}.`} /></div>;
  }

  /** Warn before insert on a similar client or a duplicate contact email. */
  const checkDuplicates = async () => {
    if (mod.key !== 'clients') return;
    try {
      const { data } = await supabase().rpc('fn_check_duplicate_client', {
        p_legal_name: (values.legal_name as string) ?? '',
        p_brand_name: (values.brand_name as string) ?? '',
        p_contact_email: null,
      });
      const r = data as { has_warning?: boolean; similar_clients?: { brand_name: string }[] } | null;
      if (r?.has_warning) {
        setDupWarning(
          `Similar client${(r.similar_clients?.length ?? 0) > 1 ? 's' : ''} already exist: ` +
          (r.similar_clients ?? []).map((c) => c.brand_name).join(', ') +
          '. Save anyway only if this is genuinely a different account.',
        );
        return;
      }
    } catch {
      // Ignore RPC duplicate check error
    }
    setDupWarning(null);
  };

  const submit = () => {
    setError(null);
    const parsed = moduleSchema(mod).safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    const clean = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    create.mutate({ mod, values: clean }, {
      onSuccess: (row) => {
        pushToast(
          mod.key === 'clients'
            ? 'Client created. Add a service scope to auto-generate the project, cycle, deliverables and tasks.'
            : `${mod.singular} created`,
        );
        router.replace(`/${mod.key}/${String(row.id)}`);
      },
      onError: (e) => setError(e instanceof Error ? e.message : 'Could not create'),
    });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <header>
        <h1 className="text-lg font-semibold">New {mod.singular.toLowerCase()}</h1>
        <p className="text-[13px] text-muted">
          Inherited and computed fields are filled in automatically once this is saved.
        </p>
      </header>

      {error && <ErrorBox error={error} />}
      {dupWarning && (
        <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-[13px] text-amber">
          {dupWarning}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {sections(mod).map((s) => {
          const editable = s.fields.filter(isEditable);
          if (!editable.length) return null;
          return (
            <Card key={s.name} title={s.name}>
              <dl className="space-y-2.5">
                {editable.map((f) => (
                  <div key={f.key} className="grid grid-cols-[150px_1fr] items-start gap-3">
                    <dt className="pt-1 text-[12px] text-muted">
                      {f.label}{f.required && <span className="text-red"> *</span>}
                    </dt>
                    <dd>
                      <FieldEditor
                        field={f} row={values} value={values[f.key]} variant="form"
                        onCommit={(next) => {
                          setValues((v) => ({ ...v, [f.key]: next }));
                          if (['legal_name', 'brand_name'].includes(f.key)) void checkDuplicates();
                        }}
                      />
                      {f.help && <p className="mt-0.5 text-[11px] text-muted">{f.help}</p>}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>

      <div className="flex justify-end gap-2">
        <Button onClick={() => router.back()}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : `Create ${mod.singular.toLowerCase()}`}
        </Button>
      </div>
    </div>
  );
}
