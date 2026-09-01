import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { Database } from '@/lib/database.types';

/**
 * Server client, still on the anon key and still bound to the caller's
 * session. Server components get exactly the rows RLS allows the signed-in
 * user — the server is not a privileged escape hatch.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options?: CookieOptions }[]) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component; the middleware refreshes instead.
          }
        },
      },
    },
  );
}
