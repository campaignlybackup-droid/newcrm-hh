-- =====================================================================
-- 0028_auth_passwords.sql
-- Native CRM Portal Authentication System:
-- Adds password_hash to public.users, RPCs for authentication & password updates.
-- =====================================================================

-- 1. Add password_hash column to public.users
alter table public.users add column if not exists password_hash text;

-- 2. Populate default password_hash ('Password123!') for all team members
update public.users
   set password_hash = extensions.crypt('Password123!', extensions.gen_salt('bf'))
 where password_hash is null or password_hash = '';

-- 3. Create authenticate_user RPC function
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

  if v_user.status = 'Inactive' then
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

comment on function public.authenticate_user is
  'Authenticates a user against public.users using bcrypt password hashing. Returns user profile JSON on success.';

-- 4. Create change_password RPC function
create or replace function public.change_password(
  p_user_id          uuid,
  p_current_password text,
  p_new_password     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.users%rowtype;
begin
  select * into v_user
    from public.users
   where id = p_user_id
     and deleted_at is null;

  if not found then
    return jsonb_build_object('success', false, 'error', 'User not found');
  end if;

  -- Verify current password
  if v_user.password_hash is not null and v_user.password_hash != extensions.crypt(p_current_password, v_user.password_hash) then
    return jsonb_build_object('success', false, 'error', 'Current password is incorrect');
  end if;

  if length(p_new_password) < 6 then
    return jsonb_build_object('success', false, 'error', 'New password must be at least 6 characters');
  end if;

  -- Update to new hashed password
  update public.users
     set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;

  -- Also sync with auth.users if schema auth exists
  if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') then
    update auth.users
       set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf'))
     where id = v_user.auth_id;
  end if;

  return jsonb_build_object('success', true, 'message', 'Password updated successfully');
end $$;

comment on function public.change_password is
  'Verifies current password and updates password_hash to new password for the specified user.';
