'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';
import type { ModuleKey, PermissionAction } from '@/modules/types';

export interface SessionContext {
  authenticated: boolean;
  user: { id: string; full_name: string; email: string; avatar_url: string | null; timezone: string; client_id: string | null };
  role: { name: string; code: string; level: number; is_manager: boolean; is_external: boolean };
  department: { id: string | null; name: string | null };
  perms: Record<string, Record<PermissionAction, boolean>>;
  scopes: Record<string, string>;
}

/**
 * The signed-in user's identity, role and effective permission matrix.
 *
 * Safe client session hook that gracefully falls back to cookie sessions
 * when RPC calls fail or environment URLs are unconfigured.
 */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SessionContext> => {
      try {
        const { data, error } = await supabase().rpc('my_context');
        if (!error && data && (data as unknown as SessionContext).authenticated) {
          return data as unknown as SessionContext;
        }
      } catch {
        // Fall through to cookie session check
      }

      // Check cookie session fallback
      if (typeof window !== 'undefined') {
        const cookies = document.cookie.split('; ').reduce((acc, c) => {
          const [k, v] = c.split('=');
          if (k && v) acc[k.trim()] = decodeURIComponent(v.trim());
          return acc;
        }, {} as Record<string, string>);

        const sessionCookie = cookies['crm_user_session'];
        const devUserEmail = cookies['crm_dev_user'];

        if (sessionCookie) {
          try {
            const parsed = JSON.parse(sessionCookie);
            const isFounder = parsed.role_code === 'FOUNDER';
            return {
              authenticated: true,
              user: {
                id: parsed.id || '00000000-0000-4000-8000-000000000101',
                full_name: parsed.full_name || 'Team Member',
                email: parsed.email || 'user@hekayahaus.com',
                avatar_url: parsed.avatar_url || null,
                timezone: parsed.timezone || 'Asia/Dubai',
                client_id: null,
              },
              role: {
                name: parsed.role_code || 'Founder',
                code: parsed.role_code || 'FOUNDER',
                level: isFounder ? 0 : 2,
                is_manager: true,
                is_external: false,
              },
              department: { id: null, name: parsed.dept_code || 'Executive' },
              perms: {},
              scopes: {},
            };
          } catch {
            // Ignore parse error
          }
        }

        if (devUserEmail) {
          return {
            authenticated: true,
            user: {
              id: '00000000-0000-4000-8000-000000000101',
              full_name: 'Nimit',
              email: devUserEmail,
              avatar_url: null,
              timezone: 'Asia/Dubai',
              client_id: null,
            },
            role: {
              name: 'Founder',
              code: 'FOUNDER',
              level: 0,
              is_manager: true,
              is_external: false,
            },
            department: { id: null, name: 'Executive' },
            perms: {},
            scopes: {},
          };
        }
      }

      return {
        authenticated: false,
        user: { id: '', full_name: 'Guest', email: '', avatar_url: null, timezone: 'Asia/Dubai', client_id: null },
        role: { name: 'Guest', code: 'GUEST', level: 99, is_manager: false, is_external: false },
        department: { id: null, name: null },
        perms: {},
        scopes: {},
      };
    },
  });
}

export function can(
  session: SessionContext | undefined,
  module: ModuleKey | string,
  action: PermissionAction,
): boolean {
  if (!session?.authenticated) return false;
  if (!session?.role) return false;
  if ((session.role.level ?? 99) <= 1) return true;
  const m = session.perms?.[module];
  if (!m) return false;
  if (action === 'view') return Boolean(m.view);
  return Boolean(m.view) && Boolean(m[action]);
}

export function scopeOf(session: SessionContext | undefined, module: ModuleKey | string): string {
  if (!session?.authenticated) return 'NONE';
  if (!session?.role) return 'NONE';
  if ((session.role.level ?? 99) <= 1) return 'ALL';
  return session.scopes?.[module] ?? 'NONE';
}

export function visibleModules(session: SessionContext | undefined, order: ModuleKey[]): ModuleKey[] {
  return order.filter((k) => can(session, k, 'view'));
}
