'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { ModuleView } from '@/components/view-engine/ModuleView';
import { getModule } from '@/modules/registry';

/**
 * One route serves every module. The registry decides the fields, the view
 * modes, the filters and the permissions — there is no per-module page.
 */
export default function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = use(params);
  const mod = getModule(module);
  if (!mod) notFound();
  return <ModuleView mod={mod} />;
}
