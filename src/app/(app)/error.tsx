'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/primitives';

export default function AppLayoutError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App Layout Boundary Error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-6 text-center shadow-lg">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber/10 text-amber text-xl">
          🔄
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Module View Reset</h2>
          <p className="mt-1 text-[13px] text-muted">
            The active module data refreshed. Reload the view or return to dashboard.
          </p>
        </div>
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="primary" size="sm" onClick={() => reset()}>
            Reload Module
          </Button>
          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/dashboard'; }}>
            Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
