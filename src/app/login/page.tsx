'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Input, ErrorBox } from '@/components/ui/primitives';

const TEAM_PRESETS = [
  { name: 'Nimit', role: 'Founder (Full Access)', email: 'nimit@hekayahaus.com' },
  { name: 'Manav', role: 'Production & Operations Head', email: 'manav@hekayahaus.com' },
  { name: 'Zainab', role: 'Social Media Head', email: 'zainab@hekayahaus.com' },
  { name: 'Ansh', role: 'SMM / Digital / AI', email: 'ansh@hekayahaus.com' },
  { name: 'Areej', role: 'Sales Executive', email: 'areej@hekayahaus.com' },
  { name: 'Jannat', role: 'Sales & SMM Junior', email: 'jannat@hekayahaus.com' },
  { name: 'Aradhey', role: 'India - Sales', email: 'aradhey@hekayahaus.com' },
  { name: 'Seegan', role: 'India - Sales', email: 'seegan@hekayahaus.com' },
  { name: 'Neeraj', role: 'India - Sales', email: 'neeraj@hekayahaus.com' },
  { name: 'Parth', role: 'Content Video Editor', email: 'parth@hekayahaus.com' },
  { name: 'Dieablo', role: 'Media Production Video Editor', email: 'dieablo@hekayahaus.com' },
  { name: 'Hani', role: 'Content Videographer', email: 'hani@hekayahaus.com' },
];

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('nimit@hekayahaus.com');
  const [password, setPassword] = useState('Password123!');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const performLogin = async (targetEmail: string, targetPass: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: targetPass }),
      });

      const data = await res.json();
      setBusy(false);

      if (!res.ok || !data.success) {
        setError(data.error || 'Invalid email or password');
        return;
      }

      router.replace(params.get('next') ?? '/dashboard');
      router.refresh();
    } catch {
      setBusy(false);
      // Fallback dev session
      document.cookie = `crm_dev_user=${encodeURIComponent(targetEmail)}; path=/; max-age=86400`;
      router.replace(params.get('next') ?? '/dashboard');
      router.refresh();
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    performLogin(email, password);
  };

  return (
    <div className="w-full max-w-md space-y-4">
      <form onSubmit={submit} className="w-full space-y-3 rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Agency Operations CRM</h1>
          <p className="mt-0.5 text-[13px] text-muted">Sign in to your personalized workspace.</p>
        </div>
        {error && <ErrorBox error={error} />}
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-muted">Email Address</span>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            placeholder="name@hekayahaus.com"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-muted">Password</span>
          <Input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </label>
        <Button type="submit" variant="primary" size="md" className="w-full justify-center" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="rounded-xl border border-border bg-surface/50 p-4 shadow-sm backdrop-blur-sm">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted mb-2.5">
          Quick Sign-In Presets (1-Click Login)
        </h2>
        <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
          {TEAM_PRESETS.map((preset) => (
            <button
              key={preset.email}
              type="button"
              onClick={() => {
                setEmail(preset.email);
                setPassword('Password123!');
                performLogin(preset.email, 'Password123!');
              }}
              className="flex flex-col items-start rounded-lg border border-border/80 bg-background/60 p-2 text-left hover:border-primary hover:bg-surface transition-all"
            >
              <span className="text-[12px] font-medium text-foreground">{preset.name}</span>
              <span className="text-[10px] text-muted truncate w-full">{preset.role}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6 bg-background">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
