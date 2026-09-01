-- =====================================================================
-- 0013_audit_and_safety.sql
-- Generic audit trail, soft delete + recycle bin, hard-delete guard,
-- and the no-money regression guard.
-- =====================================================================

create table if not exists public.activity_log (
  id          bigint generated always as identity primary key,
  entity_type text not null,
  entity_id   uuid,
  client_id   uuid,
  actor_id    uuid,
  is_system   boolean not null default false,
  action      audit_action not null,
  field_name  text,
  old_value   text,
  new_value   text,
  changed_at  timestamptz not null default now(),
  ip          inet,
  user_agent  text,
  request_id  text
);

comment on table public.activity_log is
  'Every insert, update and delete on every business table, including bulk edits and automated changes (actor_id null, is_system true). Append-only.';

create index if not exists activity_log_entity_idx    on public.activity_log (entity_type, entity_id, changed_at desc);
create index if not exists activity_log_actor_idx     on public.activity_log (actor_id, changed_at desc);
create index if not exists activity_log_client_idx    on public.activity_log (client_id, changed_at desc);
create index if not exists activity_log_changed_at_idx on public.activity_log (changed_at desc);

-- The log cannot be rewritten, not even by a Founder.
drop trigger if exists trg_activity_log_append_only on public.activity_log;
create trigger trg_activity_log_append_only before update or delete on public.activity_log
  for each row execute function public.trg_append_only();

-- ---------------------------------------------------------------------
-- Request metadata (PostgREST forwards these; null elsewhere)
-- ---------------------------------------------------------------------
create or replace function public.request_headers()
returns jsonb language sql stable parallel safe as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function public.request_ip()
returns inet language plpgsql stable parallel safe as $$
declare v text;
begin
  v := split_part(coalesce(public.request_headers() ->> 'x-forwarded-for', ''), ',', 1);
  if v is null or btrim(v) = '' then return null; end if;
  return btrim(v)::inet;
exception when others then return null;
end $$;

-- ---------------------------------------------------------------------
-- The generic audit trigger
-- ---------------------------------------------------------------------
create or replace function public.trg_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old       jsonb;
  v_new       jsonb;
  v_actor     uuid := public.auth_user_id();
  v_headers   jsonb := public.request_headers();
  v_ip        inet  := public.request_ip();
  v_ua        text  := v_headers ->> 'user-agent';
  v_req       text  := v_headers ->> 'x-request-id';
  v_entity    text  := coalesce(tg_argv[0], tg_table_name);
  v_entity_id uuid;
  v_client    uuid;
  v_action    audit_action;
  k           text;
  v_newval    text;
  v_oldval    text;
  -- Columns whose churn carries no information for a human reader.
  c_ignored   text[] := array['updated_at','created_at','path','search_vector'];
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := null;
    v_action := 'DELETE';
  elsif tg_op = 'INSERT' then
    v_old := null;
    v_new := to_jsonb(new);
    v_action := 'INSERT';
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    if (v_old ? 'deleted_at') then
      if v_old ->> 'deleted_at' is null and v_new ->> 'deleted_at' is not null then
        v_action := 'SOFT_DELETE';
      elsif v_old ->> 'deleted_at' is not null and v_new ->> 'deleted_at' is null then
        v_action := 'RESTORE';
      else
        v_action := 'UPDATE';
      end if;
    else
      v_action := 'UPDATE';
    end if;
  end if;

  v_entity_id := nullif(coalesce(v_new, v_old) ->> 'id', '')::uuid;
  if coalesce(v_new, v_old) ? 'client_id' then
    v_client := nullif(coalesce(v_new, v_old) ->> 'client_id', '')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    -- One row per changed field, so the History tab reads as prose.
    for k, v_newval in select key, value from jsonb_each_text(v_new) loop
      if k = any (c_ignored) then continue; end if;
      v_oldval := v_old ->> k;
      if v_newval is distinct from v_oldval then
        insert into public.activity_log (
          entity_type, entity_id, client_id, actor_id, is_system, action,
          field_name, old_value, new_value, ip, user_agent, request_id
        ) values (
          v_entity, v_entity_id, v_client, v_actor, v_actor is null, v_action,
          k, v_oldval, v_newval, v_ip, v_ua, v_req
        );
      end if;
    end loop;
    -- A field-less marker so SOFT_DELETE/RESTORE are always findable even
    -- if the only changed column was filtered out.
    if v_action in ('SOFT_DELETE','RESTORE') then
      insert into public.activity_log (
        entity_type, entity_id, client_id, actor_id, is_system, action, ip, user_agent, request_id
      ) values (v_entity, v_entity_id, v_client, v_actor, v_actor is null, v_action, v_ip, v_ua, v_req);
    end if;
  else
    insert into public.activity_log (
      entity_type, entity_id, client_id, actor_id, is_system, action,
      field_name, old_value, new_value, ip, user_agent, request_id
    ) values (
      v_entity, v_entity_id, v_client, v_actor, v_actor is null, v_action,
      null,
      case when tg_op = 'DELETE' then v_old::text else null end,
      case when tg_op = 'INSERT' then v_new::text else null end,
      v_ip, v_ua, v_req
    );
  end if;

  return null;   -- AFTER trigger
end $$;

-- ---------------------------------------------------------------------
-- Hard-delete guard. A physical DELETE is refused unless the session is
-- inside public.hard_delete(), which is Founder-only and demands a typed
-- confirmation string.
-- ---------------------------------------------------------------------
create or replace function public.trg_block_hard_delete()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('crm.allow_hard_delete', true), 'off') <> 'on' then
    raise exception
      'Hard delete of %.% is blocked. Use soft_delete() — the row stays recoverable from the Recycle Bin.',
      tg_table_schema, tg_table_name
      using errcode = '42501',
            hint = 'A Founder may call public.hard_delete(entity_type, id, confirmation).';
  end if;
  return old;
end $$;

-- ---------------------------------------------------------------------
-- Attach audit + delete-guard to every business table
-- ---------------------------------------------------------------------
create table if not exists public.audited_tables (
  table_name  text primary key,
  soft_delete boolean not null default true
);

insert into public.audited_tables (table_name, soft_delete) values
  ('departments', true), ('roles', true), ('users', true), ('teams', true),
  ('team_members', false), ('role_permissions', false), ('user_permission_overrides', false),
  ('clients', true), ('client_contacts', true), ('client_brand_kit', true),
  ('client_social_accounts', true), ('client_service_scope', true), ('client_documents', true),
  ('client_team_members', false), ('content_pillars', true),
  ('leads', true), ('lead_activities', true),
  ('projects', true), ('retainer_cycles', true), ('deliverables', true), ('tasks', true),
  ('task_dependencies', false), ('checklist_items', true), ('revisions', true),
  ('shoots', true), ('shoot_crew', false), ('equipment', true), ('equipment_bookings', true),
  ('shot_lists', true), ('shot_list_items', true),
  ('campaigns', true), ('content_calendar', true),
  ('assets', true), ('approvals', true), ('approval_chains', false),
  ('meetings', true), ('meeting_attendees', false), ('action_items', true), ('client_reports', true),
  ('comments', true),
  ('leave_requests', true), ('availability', false), ('onboarding_checklists', true), ('reviews', true),
  ('project_templates', true), ('deliverable_templates', true), ('task_templates', true),
  ('checklist_templates', true), ('sops', true), ('automation_rules', true),
  ('saved_views', false), ('tags', false), ('entity_tags', false),
  ('custom_fields', false), ('custom_field_values', false), ('attachments', true)
on conflict (table_name) do nothing;

do $$
declare r record;
begin
  for r in select table_name, soft_delete from public.audited_tables loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then
      raise notice 'audit skip: public.% does not exist', r.table_name;
      continue;
    end if;

    execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', r.table_name);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
       for each row execute function public.trg_audit(%2$L)', r.table_name, r.table_name);

    if r.soft_delete then
      execute format('drop trigger if exists trg_block_hard_delete_%1$s on public.%1$I', r.table_name);
      execute format(
        'create trigger trg_block_hard_delete_%1$s before delete on public.%1$I
         for each row execute function public.trg_block_hard_delete()', r.table_name);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Soft delete / restore / hard delete RPCs
-- ---------------------------------------------------------------------
create or replace function public.soft_delete(p_entity_type text, p_id uuid)
returns void
language plpgsql
security invoker            -- deliberately: RLS must still apply to the UPDATE
set search_path = public
as $$
declare v_ok boolean;
begin
  select true into v_ok from public.audited_tables
   where table_name = p_entity_type and soft_delete;
  if not found then
    raise exception 'Table % is not soft-deletable', p_entity_type using errcode = '22023';
  end if;

  execute format(
    'update public.%I set deleted_at = now(), deleted_by = public.auth_user_id()
      where id = $1 and deleted_at is null', p_entity_type)
  using p_id;
end $$;

create or replace function public.restore_record(p_entity_type text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_founder() then
    raise exception 'Only a Founder or Co-Founder may restore a record' using errcode = '42501';
  end if;
  execute format(
    'update public.%I set deleted_at = null, deleted_by = null where id = $1', p_entity_type)
  using p_id;
end $$;

comment on function public.restore_record(text, uuid) is
  'Restores from the Recycle Bin. Relations survive because soft delete never removed the row, so every foreign key still resolves.';

create or replace function public.hard_delete(p_entity_type text, p_id uuid, p_confirmation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_founder() then
    raise exception 'Only a Founder or Co-Founder may hard delete' using errcode = '42501';
  end if;
  if p_confirmation is distinct from ('DELETE ' || p_entity_type) then
    raise exception 'Confirmation text does not match. Type exactly: DELETE %', p_entity_type
      using errcode = '22023';
  end if;

  perform set_config('crm.allow_hard_delete', 'on', true);
  execute format('delete from public.%I where id = $1', p_entity_type) using p_id;
  perform set_config('crm.allow_hard_delete', 'off', true);
end $$;

-- ---------------------------------------------------------------------
-- Recycle bin
-- ---------------------------------------------------------------------
create or replace function public.recycle_bin(p_limit int default 200)
returns table (
  entity_type text, entity_id uuid, label text,
  deleted_at timestamptz, deleted_by uuid, deleted_by_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_label    text;
  v_parts    text[] := '{}';
  v_sql      text;
  c_label_cols text[] := array['title','name','full_name','brand_name','label','item_name','company','shot_name'];
begin
  if not public.is_founder() then
    raise exception 'Recycle Bin is Founder-only' using errcode = '42501';
  end if;

  for r in select at.table_name from public.audited_tables at where at.soft_delete order by at.table_name loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;

    -- Use the most human-readable column this table happens to have.
    select string_agg(format('t.%I::text', ic.column_name), ', ' order by array_position(c_label_cols, ic.column_name))
      into v_label
      from information_schema.columns ic
     where ic.table_schema = 'public'
       and ic.table_name = r.table_name
       and ic.column_name = any (c_label_cols);

    if v_label is null then
      v_label := 't.id::text';
    end if;

    v_parts := v_parts || format(
      'select %1$L::text as entity_type, t.id as entity_id, coalesce(%2$s)::text as label,
              t.deleted_at, t.deleted_by
         from public.%1$I t where t.deleted_at is not null',
      r.table_name, v_label);
  end loop;

  if array_length(v_parts, 1) is null then
    return;
  end if;

  v_sql := array_to_string(v_parts, ' union all ');
  return query execute format(
    'select b.entity_type, b.entity_id, b.label, b.deleted_at, b.deleted_by, u.full_name
       from (%s) b left join public.users u on u.id = b.deleted_by
      order by b.deleted_at desc limit %s', v_sql, p_limit);
end $$;

comment on function public.recycle_bin(int) is
  'Founder-only Recycle Bin across every soft-deletable table. Restoring is non-destructive: the row never left, so all relations are intact.';

-- ---------------------------------------------------------------------
-- NO-MONEY REGRESSION GUARD
-- The hard rule is enforced by the database, not by reviewer discipline.
-- CI calls assert_no_money_columns(); it fails the build if anyone ever
-- adds a price, budget, salary or currency column.
-- ---------------------------------------------------------------------
create or replace function public.find_money_columns()
returns table (table_name text, column_name text, data_type text)
language sql stable as $$
  select c.table_name::text, c.column_name::text, c.data_type::text
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name not in ('audited_tables','modules')
    and (
      c.data_type = 'money'
      -- The concatenation must be parenthesised: ~* and || share a
      -- precedence level and associate left, so without the parens this
      -- parses as (column_name ~* '...') || '...'.
      or c.column_name ~* (
           '(^|_)(price|pricing|cost|costs|amount|amounts|budget|budgets|spend|spent|'
        || 'invoice|invoiced|salary|salaries|payroll|wage|wages|rate|rates|'
        || 'fee|fees|currency|revenue|profit|margin|discount|tax|gst|vat|'
        || 'payment|paid_amount|balance|billing|billable|quotation|quote_amount|'
        || 'expense|expenses|reimbursement|bonus|increment|ctc|compensation)($|_)')
    )
    ;
$$;

create or replace function public.assert_no_money_columns()
returns void language plpgsql as $$
declare v_bad text;
begin
  select string_agg(format('%s.%s (%s)', table_name, column_name, data_type), ', ')
    into v_bad from public.find_money_columns();
  if v_bad is not null then
    raise exception 'HARD RULE VIOLATION — this system has no money module. Offending columns: %', v_bad
      using errcode = '23514';
  end if;
end $$;

comment on function public.assert_no_money_columns() is
  'Fails if any money-shaped column exists. Wired into CI so the no-money rule survives future contributors.';

select public.assert_no_money_columns();
