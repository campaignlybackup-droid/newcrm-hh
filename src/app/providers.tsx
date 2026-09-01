'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/Toaster';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          // A permission failure is an answer, not a transient error.
          const code = (err as { code?: string })?.code;
          if (code === '42501' || code === 'PGRST301') return false;
          return count < 2;
        },
      },
    },
  }));

  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
