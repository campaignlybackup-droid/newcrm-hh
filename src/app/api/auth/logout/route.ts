import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ success: true, message: 'Logged out successfully' });
  response.cookies.delete('crm_user_session');
  response.cookies.delete('crm_dev_user');
  return response;
}
