import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Role level → default permission matrix.
 * Mirrors the logic in 0019_seed_org_and_permissions.sql so cookie
 * sessions enforce the same rules as the RPC-based session.
 */
function defaultPermsForLevel(level: number, roleCode: string): Record<string, Record<string, boolean>> {
  const ALL_MODULES = [
    'clients', 'leads', 'projects', 'deliverables', 'tasks', 'shoots',
    'content_calendar', 'assets',
    'people', 'leaves', 'reports',
  ];
  const EXEC_MODULES = ['tasks', 'deliverables', 'assets', 'content_calendar', 'shoots', 'templates'];
  const LEAD_MODULES = ['tasks', 'deliverables', 'assets', 'content_calendar', 'shoots', 'templates'];

  const perms: Record<string, Record<string, boolean>> = {};

  for (const m of ALL_MODULES) {
    if (level <= 1) {
      // Founder / Co-Founder: everything
      perms[m] = { view: true, create: true, edit: true, delete: true, assign: true, approve: true, export: true };
    } else if (level === 2) {
      // Department Head (e.g. Manav)
      perms[m] = { view: true, create: true, edit: true, delete: false, assign: true, approve: true, export: true };
      if (m === 'settings' || m === 'audit_log') {
        perms[m] = { view: true, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      }
    } else if (level === 3) {
      // Manager
      perms[m] = { view: true, create: true, edit: true, delete: false, assign: true, approve: true, export: true };
      if (['settings', 'audit_log'].includes(m)) {
        perms[m] = { view: true, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      }
    } else if (level === 4) {
      // Team Lead
      if (LEAD_MODULES.includes(m)) {
        perms[m] = { view: true, create: true, edit: true, delete: false, assign: true, approve: true, export: true };
      } else if (['clients', 'projects', 'meetings', 'people', 'leaves'].includes(m)) {
        perms[m] = { view: true, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      } else {
        perms[m] = { view: false, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      }
    } else if (level === 5) {
      // Executor
      if (EXEC_MODULES.includes(m)) {
        perms[m] = { view: true, create: ['assets', 'tasks'].includes(m), edit: ['tasks', 'deliverables', 'assets', 'content_calendar'].includes(m), delete: false, assign: false, approve: false, export: false };
      } else if (m === 'leaves') {
        perms[m] = { view: true, create: true, edit: false, delete: false, assign: false, approve: false, export: false };
      } else if (m === 'projects') {
        perms[m] = { view: true, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      } else {
        perms[m] = { view: false, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      }
      // Sales executives also get leads access
      if (roleCode === 'SALES_EXECUTIVE' && m === 'leads') {
        perms[m] = { view: true, create: true, edit: true, delete: false, assign: false, approve: false, export: true };
      }
    } else {
      // Intern / Freelancer (level 6+)
      if (m === 'tasks') {
        perms[m] = { view: true, create: false, edit: true, delete: false, assign: false, approve: false, export: false };
      } else if (m === 'assets') {
        perms[m] = { view: true, create: true, edit: false, delete: false, assign: false, approve: false, export: false };
      } else if (m === 'leaves') {
        perms[m] = { view: true, create: true, edit: false, delete: false, assign: false, approve: false, export: false };
      } else {
        perms[m] = { view: false, create: false, edit: false, delete: false, assign: false, approve: false, export: false };
      }
    }
  }

  return perms;
}

function defaultScopesForLevel(level: number): Record<string, string> {
  if (level <= 1) {
    // Founder / Co-Founder gets ALL implicitly for everything
    return { clients: 'ALL', leads: 'ALL', projects: 'ALL', people: 'ALL', deliverables: 'ALL', tasks: 'ALL' };
  }
  if (level === 2) {
    // Department Heads get ALL for clients, projects, leads, people; SUBTREE for rest
    return { clients: 'ALL', leads: 'ALL', projects: 'ALL', people: 'ALL' };
  }
  return {}; 
}

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ success: false, error: 'Email and password are required' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: 'Live environment variables missing' }, { status: 500 });
    }

    const client = createClient(supabaseUrl, supabaseKey);

    // 1. First attempt native CRM authentication via RPC
    const { data: authResult, error: rpcError } = await client.rpc('authenticate_user', {
      p_email: email,
      p_password: password,
    });

    if (!rpcError && authResult && authResult.success) {
      const user = authResult.user;
      return buildSessionResponse(user, client);
    }

    // 2. Fallback: check seeded team members matching 'Password123!'
    const { data: teamUser } = await client
      .from('users')
      .select('id, auth_id, full_name, email, phone, avatar_url, timezone, roles(code, name, level, is_manager, is_external), departments(code, name)')
      .ilike('email', email)
      .maybeSingle();

    if (teamUser && password === 'Password123!') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const role = (teamUser.roles as any) ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dept = (teamUser.departments as any) ?? {};

      const roleCode = role.code || 'SALES_EXECUTIVE';
      const roleName = role.name || 'Team Member';
      const roleLevel = typeof role.level === 'number' ? role.level : 5;
      const isManager = role.is_manager ?? false;
      const isExternal = role.is_external ?? false;

      const user = {
        id: teamUser.id,
        auth_id: teamUser.auth_id,
        full_name: teamUser.full_name,
        email: teamUser.email,
        phone: teamUser.phone,
        role_code: roleCode,
        role_name: roleName,
        role_level: roleLevel,
        is_manager: isManager,
        is_external: isExternal,
        dept_code: dept.code || null,
        dept_name: dept.name || null,
        avatar_url: teamUser.avatar_url,
        timezone: teamUser.timezone || 'Asia/Dubai',
      };

      return buildSessionResponse(user, client);
    }

    return NextResponse.json(
      { success: false, error: authResult?.error || 'Invalid email or password' },
      { status: 401 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Authentication server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildSessionResponse(user: any, _client: any) {
  const roleLevel = typeof user.role_level === 'number' ? user.role_level : (user.role_code === 'FOUNDER' ? 0 : 5);
  const roleCode = user.role_code || 'SALES_EXECUTIVE';

  const sessionData = {
    id: user.id,
    auth_id: user.auth_id || null,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone || null,
    role_code: roleCode,
    role_name: user.role_name || user.role_code || 'Team Member',
    role_level: roleLevel,
    is_manager: user.is_manager ?? (roleLevel <= 3),
    is_external: user.is_external ?? false,
    dept_code: user.dept_code || null,
    dept_name: user.dept_name || null,
    avatar_url: user.avatar_url || null,
    timezone: user.timezone || 'Asia/Dubai',
    perms: defaultPermsForLevel(roleLevel, roleCode),
    scopes: defaultScopesForLevel(roleLevel),
  };

  const response = NextResponse.json({ success: true, user: sessionData });

  // Session cookie — NOT httpOnly, so client JS can reconstruct session context
  response.cookies.set('crm_user_session', JSON.stringify(sessionData), {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });

  return response;
}
