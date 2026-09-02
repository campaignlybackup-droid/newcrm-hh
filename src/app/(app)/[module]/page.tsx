'use client';

import { use, Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ModuleView } from '@/components/view-engine/ModuleView';
import { getModule } from '@/modules/registry';
import { Spinner } from '@/components/ui/primitives';

/**
 * One route serves every module. The registry decides the fields, the view
 * modes, the filters and the permissions — there is no per-module page.
 */
export default function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = use(params);
  const mod = getModule(module);
  if (!mod) notFound();
  return (
    <Suspense fallback={<div className="p-8 flex items-center justify-center"><Spinner /></div>}>
      <ModuleView mod={mod} />
    </Suspense>
  );
}
