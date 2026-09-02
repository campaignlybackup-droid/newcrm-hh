'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/database.types';

/**
 * Browser client. Carries ONLY the anon key — the service_role key is
 * never bundled, so every request the browser makes is subject to RLS.
 */
export function createClient() {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const rawKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const url = (rawUrl && rawUrl.startsWith('http')) ? rawUrl : 'https://placeholder.supabase.co';
  const key = rawKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder.placeholder';

  return createBrowserClient<Database>(url, key);
}

let singleton: ReturnType<typeof createClient> | null = null;
export function supabase() {
  if (!singleton) singleton = createClient();
  return singleton;
}

/**
 * A dynamic handle for registry-driven queries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function supabaseDynamic(): any {
  return supabase();
}
