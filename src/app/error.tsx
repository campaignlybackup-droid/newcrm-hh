'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/primitives';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application Boundary Error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-surface p-6 text-center shadow-lg">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red/10 text-red text-xl">
          ⚠️
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Workspace View Recovery</h2>
          <p className="mt-1 text-[13px] text-muted">
            The workspace encountered a temporary rendering state. Click retry to refresh the view cleanly.
          </p>
        </div>
        <div className="flex justify-center gap-2 pt-2">
          <Button variant="primary" size="sm" onClick={() => reset()}>
            Retry View
          </Button>
          <Button variant="outline" size="sm" onClick={() => { window.location.href = '/dashboard'; }}>
            Go to Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
