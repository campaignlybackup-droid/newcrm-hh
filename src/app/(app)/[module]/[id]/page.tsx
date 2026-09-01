'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { DetailView } from '@/components/view-engine/DetailView';
import { CreateView } from '@/components/view-engine/CreateView';
import { getModule } from '@/modules/registry';

export default function RecordPage({ params }: { params: Promise<{ module: string; id: string }> }) {
  const { module, id } = use(params);
  const mod = getModule(module);
  if (!mod) notFound();
  // `new` is handled here rather than as a sibling route so create and
  // edit render from the same field definitions.
  if (id === 'new') return <CreateView mod={mod} />;
  return <DetailView mod={mod} id={id} />;
}
