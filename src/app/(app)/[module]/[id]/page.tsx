'use client';

import { use, Suspense } from 'react';
import { notFound } from 'next/navigation';
import { DetailView } from '@/components/view-engine/DetailView';
import { CreateView } from '@/components/view-engine/CreateView';
import { getModule } from '@/modules/registry';
import { Spinner } from '@/components/ui/primitives';

export default function RecordPage({ params }: { params: Promise<{ module: string; id: string }> }) {
  const { module, id } = use(params);
  const mod = getModule(module);
  if (!mod) notFound();
  if (id === 'new') {
    return (
      <Suspense fallback={<div className="p-8 flex items-center justify-center"><Spinner /></div>}>
        <CreateView mod={mod} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<div className="p-8 flex items-center justify-center"><Spinner /></div>}>
      <DetailView mod={mod} id={id} />
    </Suspense>
  );
}
