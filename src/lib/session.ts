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
 * Priority:
 * 1. Supabase RPC `my_context` (production with real DB)
 * 2. `crm_user_session` cookie (cookie-based auth with role-level permissions)
 * 3. Guest / unauthenticated fallback
 */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SessionContext> => {
      // 1. Try Supabase RPC first (real DB session)
      try {
        const { data, error } = await supabase().rpc('my_context');
        if (!error && data && (data as unknown as SessionContext).authenticated) {
          return data as unknown as SessionContext;
        }
      } catch {
        // Fall through to cookie session check
      }

      // 2. Cookie-based session fallback (set by /api/auth/login)
      if (typeof window !== 'undefined') {
        const cookies = document.cookie.split('; ').reduce((acc, c) => {
          const eqIdx = c.indexOf('=');
          if (eqIdx > 0) {
            const k = c.slice(0, eqIdx).trim();
            const v = c.slice(eqIdx + 1).trim();
            if (k && v) acc[k] = decodeURIComponent(v);
          }
          return acc;
        }, {} as Record<string, string>);

        const sessionCookie = cookies['crm_user_session'];

        if (sessionCookie) {
          try {
            const parsed = JSON.parse(sessionCookie);
            const roleLevel = typeof parsed.role_level === 'number' ? parsed.role_level : 99;
            const roleCode = parsed.role_code || 'GUEST';
            const roleName = parsed.role_name || parsed.role_code || 'Guest';
            const isManager = parsed.is_manager ?? false;
            const isExternal = parsed.is_external ?? false;

            return {
              authenticated: true,
              user: {
                id: parsed.id || '',
                full_name: parsed.full_name || 'Team Member',
                email: parsed.email || '',
                avatar_url: parsed.avatar_url || null,
                timezone: parsed.timezone || 'Asia/Dubai',
                client_id: parsed.client_id || null,
              },
              role: {
                name: roleName,
                code: roleCode,
                level: roleLevel,
                is_manager: isManager,
                is_external: isExternal,
              },
              department: {
                id: parsed.dept_id || null,
                name: parsed.dept_name || parsed.dept_code || null,
              },
              perms: parsed.perms || {},
              scopes: parsed.scopes || {},
            };
          } catch {
            // Ignore parse error — cookie may be corrupted
          }
        }
      }

      // 3. No valid session found
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
  // Founder / Co-Founder: level <= 1 bypasses all permission checks
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
