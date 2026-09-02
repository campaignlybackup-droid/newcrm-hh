-- =====================================================================
-- 0029_fix_auth_rpc_status.sql
-- Fixes the authenticate_user RPC to check valid user_status enum values
-- ('Suspended', 'Offboarded') instead of the invalid 'Inactive' string.
-- =====================================================================

create or replace function public.authenticate_user(
  p_email    text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     public.users%rowtype;
  v_role_code text;
  v_dept_code text;
begin
  select * into v_user
    from public.users
   where lower(email) = lower(p_email)
     and deleted_at is null;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Invalid email or password');
  end if;

  if v_user.status in ('Suspended', 'Offboarded') then
    return jsonb_build_object('success', false, 'error', 'Account is deactivated. Contact an admin.');
  end if;

  -- Verify bcrypt password hash
  if v_user.password_hash is null or v_user.password_hash != extensions.crypt(p_password, v_user.password_hash) then
    return jsonb_build_object('success', false, 'error', 'Invalid email or password');
  end if;

  select code into v_role_code from public.roles where id = v_user.role_id;
  select code into v_dept_code from public.departments where id = v_user.department_id;

  return jsonb_build_object(
    'success', true,
    'user', jsonb_build_object(
      'id', v_user.id,
      'auth_id', v_user.auth_id,
      'full_name', v_user.full_name,
      'email', v_user.email,
      'phone', v_user.phone,
      'role_code', v_role_code,
      'dept_code', v_dept_code,
      'avatar_url', v_user.avatar_url,
      'timezone', v_user.timezone
    )
  );
end $$;
