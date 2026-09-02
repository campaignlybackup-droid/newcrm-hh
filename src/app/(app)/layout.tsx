'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import { useSession, can } from '@/lib/session';
import { MODULES, MODULE_ORDER } from '@/modules/registry';
import { Avatar, Button } from '@/components/ui/primitives';
import { ChangePasswordModal } from '@/components/settings/ChangePasswordModal';
import { cn } from '@/lib/utils';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data: session } = useSession();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  // Views the user pinned appear directly in the sidebar.
  const pinned = useQuery({
    queryKey: ['pinned_views'],
    queryFn: async () => {
      const { data } = await supabase().from('saved_views')
        .select('id,name,module,view_mode,filters').eq('is_pinned', true).order('sort_order');
      return (data ?? []) as { id: string; name: string; module: string }[];
    },
  });

  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase().from('notifications')
        .select('id', { count: 'exact', head: true }).is('read_at', null);
      return count ?? 0;
    },
  });

  const modules = MODULE_ORDER.filter((k) => can(session, k, 'view'));
  const isFounder = (session?.role.level ?? 99) <= 1;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-3.5 py-3">
          <Link href="/dashboard" className="text-[13px] font-semibold">Agency Operations</Link>
          {session?.role && (
            <p className="mt-0.5 truncate text-[11px] text-muted">{session.role.name}</p>
          )}
        </div>

        <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto p-2">
          <NavLink href="/dashboard" active={path === '/dashboard'}>Dashboard</NavLink>
          <NavLink href="/calendar" active={path.startsWith('/calendar')}>Calendar</NavLink>
          <NavLink href="/notifications" active={path.startsWith('/notifications')}>
            Notifications{(unread.data ?? 0) > 0 && (
              <span className="ml-auto rounded bg-accent px-1.5 text-[10px] text-white">{unread.data}</span>
            )}
          </NavLink>

          <p className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wide text-muted">Modules</p>
          {modules.map((k) => (
            <NavLink key={k} href={`/${k}`} active={path === `/${k}` || path.startsWith(`/${k}/`)}>
              {MODULES[k].label}
            </NavLink>
          ))}

          {(pinned.data?.length ?? 0) > 0 && (
            <>
              <p className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wide text-muted">Pinned views</p>
              {pinned.data!.map((v) => (
                <NavLink key={v.id} href={`/${v.module}?savedView=${v.id}`} active={false}>
                  📌 {v.name}
                </NavLink>
              ))}
            </>
          )}

          {isFounder && (
            <>
              <p className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-wide text-muted">Administration</p>
              <NavLink href="/settings/roles" active={path.startsWith('/settings/roles')}>Roles &amp; Permissions</NavLink>
              <NavLink href="/settings/recycle-bin" active={path.startsWith('/settings/recycle-bin')}>Recycle Bin</NavLink>
              <NavLink href="/settings/audit" active={path.startsWith('/settings/audit')}>Audit Log</NavLink>
            </>
          )}
        </nav>

        <div className="border-t border-border p-2.5">
          <div className="flex items-center gap-2">
            <Avatar name={session?.user.full_name} url={session?.user.avatar_url} size={26} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium">{session?.user.full_name ?? '—'}</p>
              <p className="truncate text-[11px] text-muted">{session?.user.timezone}</p>
            </div>
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-center text-[11px]"
              onClick={() => setPasswordModalOpen(true)}
            >
              🔒 Change Password
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center text-[11px]"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' });
                await supabase().auth.signOut();
                window.location.href = '/login';
              }}
            >
              Sign out
            </Button>
          </div>
          <ChangePasswordModal isOpen={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-bg">{children}</main>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href}
      className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
        active ? 'bg-accent/12 font-medium text-accent' : 'text-muted hover:bg-raised hover:text-fg')}>
      {children}
    </Link>
  );
}
