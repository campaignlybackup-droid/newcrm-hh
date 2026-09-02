import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: NextRequest) {
  try {
    const { currentPassword, newPassword } = await request.json();

    const sessionCookie = request.cookies.get('crm_user_session')?.value;
    if (!sessionCookie) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const session = JSON.parse(sessionCookie);
    if (!session?.id) {
      return NextResponse.json({ success: false, error: 'Invalid user session' }, { status: 401 });
    }

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'Current password and new password are required' },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { success: false, error: 'New password must be at least 6 characters long' },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';
    const client = createClient(supabaseUrl, supabaseKey);

    const { data: result, error: rpcError } = await client.rpc('change_password', {
      p_user_id: session.id,
      p_current_password: currentPassword,
      p_new_password: newPassword,
    });

    if (rpcError) {
      return NextResponse.json({ success: false, error: rpcError.message }, { status: 400 });
    }

    if (!result?.success) {
      return NextResponse.json({ success: false, error: result?.error || 'Password update failed' }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: 'Password changed successfully' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to change password';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
