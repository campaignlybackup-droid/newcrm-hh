'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { Button, Input, ErrorBox } from '@/components/ui/primitives';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.replace(params.get('next') ?? '/dashboard');
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-surface p-6">
      <div>
        <h1 className="text-lg font-semibold">Agency Operations</h1>
        <p className="mt-0.5 text-[13px] text-muted">Sign in to continue.</p>
      </div>
      {error && <ErrorBox error={error} />}
      <label className="block space-y-1">
        <span className="text-[12px] text-muted">Email</span>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-muted">Password</span>
        <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <Button type="submit" variant="primary" size="md" className="w-full justify-center" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-[11px] text-muted">
        Access is decided by your role and your position in the reporting tree. If something you expect
        is missing, ask a Founder to review Settings → Roles &amp; Permissions.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
