'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/lib/database.types';

/**
 * Browser client. Carries ONLY the anon key — the service_role key is
 * never bundled, so every request the browser makes is subject to RLS.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

let singleton: ReturnType<typeof createClient> | null = null;
export function supabase() {
  if (!singleton) singleton = createClient();
  return singleton;
}

/**
 * A deliberately untyped handle for the registry-driven queries.
 *
 * The view engine builds its table name and its PostgREST select string
 * from src/modules/registry.ts at runtime, so the compile-time select
 * parser has nothing to work from and collapses the result to an error
 * type. Rather than sprinkle casts at every call site, the dynamic paths
 * take this handle and state the shape they expect.
 *
 * Correctness is not lost, only relocated: every write through these paths
 * is validated by the module's derived Zod schema before it is sent, and
 * enforced again by RLS and CHECK constraints when it lands.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function supabaseDynamic(): any {
  return supabase();
}
