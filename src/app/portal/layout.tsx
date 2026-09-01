'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Client portal shell.
 *
 * There is deliberately no navigation to anything internal. That is a
 * convenience, not the protection: a portal user's token switches
 * PostgREST into the `client_portal` database role, which holds no
 * privilege on internal tables or columns at all.
 */
const TABS = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/deliverables', label: 'Deliverables' },
  { href: '/portal/calendar', label: 'Content calendar' },
  { href: '/portal/approvals', label: 'Approvals' },
  { href: '/portal/schedule', label: 'Schedule' },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data: session } = useSession();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <div>
            <p className="text-[13px] font-semibold">Your workspace</p>
            <p className="text-[11px] text-muted">{session?.user.full_name}</p>
          </div>
          <Button variant="ghost"
            onClick={async () => { await supabase().auth.signOut(); window.location.href = '/login'; }}>
            Sign out
          </Button>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 px-5">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href}
              className={cn('-mb-px border-b-2 px-3 py-2 text-[13px]',
                path === t.href ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg')}>
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-5">{children}</main>
    </div>
  );
}
