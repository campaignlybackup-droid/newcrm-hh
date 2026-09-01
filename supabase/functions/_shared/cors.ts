export const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Rejects anything that is not the scheduler or a signed-in user. */
export function requireAuth(req: Request): { kind: 'service' | 'user'; token: string } {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new Response('Unauthorized', { status: 401 });
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return { kind: token === service ? 'service' : 'user', token };
}
