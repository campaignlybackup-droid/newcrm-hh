'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error for diagnostics
    console.error('Global Application Error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100 font-sans">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center shadow-2xl">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-400 text-xl font-bold">
            ⚠️
          </div>
          <div>
            <h1 className="text-lg font-bold text-zinc-100">CRM Workspace Recovery</h1>
            <p className="mt-1 text-[13px] text-zinc-400">
              A temporary rendering issue occurred. Click reload to refresh your session context.
            </p>
          </div>
          <div className="flex gap-2 justify-center pt-2">
            <button
              onClick={() => reset()}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-[13px] font-semibold text-zinc-950 hover:bg-zinc-200 transition-all"
            >
              Reload View
            </button>
            <button
              onClick={() => { window.location.href = '/dashboard'; }}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-[13px] font-semibold text-zinc-300 hover:bg-zinc-800 transition-all"
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
