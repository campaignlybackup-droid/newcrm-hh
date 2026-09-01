import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** Refreshes the session cookie and gates the app behind a login. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options?: CookieOptions }[]) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith('/login') || path.startsWith('/auth') || path.startsWith('/api/public');

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  // External users live in the portal and nowhere else. This is a
  // convenience redirect; the actual protection is RLS plus the
  // client_portal database role.
  if (user) {
    const isExternal = Boolean((user.app_metadata as Record<string, unknown>)?.is_external);
    if (isExternal && !path.startsWith('/portal') && !isPublic) {
      const url = request.nextUrl.clone();
      url.pathname = '/portal';
      return NextResponse.redirect(url);
    }
  }

  return response;
}
