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
 * This drives which chrome renders. It is NOT the authorization boundary:
 * hiding a button changes nothing about what the database will accept, and
 * every mutation is re-checked by RLS regardless of what this returns.
 */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SessionContext> => {
      const { data, error } = await supabase().rpc('my_context');
      if (error) throw error;
      return data as unknown as SessionContext;
    },
  });
}

export function can(
  session: SessionContext | undefined,
  module: ModuleKey | string,
  action: PermissionAction,
): boolean {
  if (!session?.authenticated) return false;
  if (session.role.level <= 1) return true;
  const m = session.perms?.[module];
  if (!m) return false;
  // Editing, approving and the rest are always a subset of viewing —
  // the same rule the database applies in auth_can().
  if (action === 'view') return Boolean(m.view);
  return Boolean(m.view) && Boolean(m[action]);
}

export function scopeOf(session: SessionContext | undefined, module: ModuleKey | string): string {
  if (!session?.authenticated) return 'NONE';
  if (session.role.level <= 1) return 'ALL';
  return session.scopes?.[module] ?? 'NONE';
}

export function visibleModules(session: SessionContext | undefined, order: ModuleKey[]): ModuleKey[] {
  return order.filter((k) => can(session, k, 'view'));
}
