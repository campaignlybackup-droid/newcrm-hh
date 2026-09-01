-- =====================================================================
-- 0018_cron.sql
-- Scheduled jobs. Everything here is a database job, not a UI
-- convenience, so an import or an API call gets identical behaviour.
--
-- On Supabase, pg_cron and pg_net must be enabled for the project. Each
-- block degrades to a NOTICE on a plain Postgres so the migration set
-- stays runnable anywhere (CI, a local container, a review app).
-- =====================================================================

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron unavailable (%). Schedule these jobs with your platform scheduler instead.', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net unavailable (%). Edge Function invocation from cron will be skipped.', sqlerrm;
end $$;

-- Digests fire at 09:00 in each user's OWN timezone, so the hourly job
-- only picks the users for whom it is currently 9 AM locally.
create or replace function public.fn_queue_daily_digests(p_local_hour int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_d jsonb; v_n int := 0; v_count int;
begin
  for r in
    select u.id from public.users u
      join public.roles ro on ro.id = u.role_id
     where u.deleted_at is null and u.status = 'Active' and not ro.is_external
       and extract(hour from (now() at time zone u.timezone))::int = p_local_hour
  loop
    v_d := public.fn_daily_digest(r.id);
    v_count := jsonb_array_length(v_d -> 'tasks_due_today')
             + jsonb_array_length(v_d -> 'tasks_overdue')
             + jsonb_array_length(v_d -> 'approvals_waiting_on_me')
             + jsonb_array_length(v_d -> 'shoots_today')
             + jsonb_array_length(v_d -> 'posts_going_live')
             + jsonb_array_length(v_d -> 'meetings_today');

    if v_count > 0 and not exists (
         select 1 from public.notifications n
          where n.user_id = r.id and n.type = 'daily_digest'
            and n.created_at > now() - interval '20 hours') then
      insert into public.notifications (user_id, type, title, message, channel, priority)
      values (r.id, 'daily_digest', format('Your day: %s item(s)', v_count), v_d::text, 'digest', 'Medium');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- Nightly logical backup to a separate bucket, 30-day retention. The
-- heavy lifting is an Edge Function; cron only pokes it.
create or replace function public.fn_trigger_backup()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_url text; v_key text;
begin
  v_url := current_setting('app.settings.functions_url', true);
  v_key := current_setting('app.settings.service_role_key', true);
  if v_url is null or v_key is null then
    raise notice 'Backup trigger skipped: app.settings.functions_url / service_role_key not configured';
    return;
  end if;

  perform extensions.http_post(
    url     := v_url || '/nightly-backup',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
    body    := jsonb_build_object('retention_days', 30)
  );
exception when others then
  raise notice 'Backup trigger failed: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------
do $$
declare
  v_jobs text[][] := array[
    -- name                       schedule        command
    array['crm-generate-cycles',  '0 2 25 * *',   'select public.fn_generate_next_cycles();'],
    array['crm-escalate-overdue', '0 8 * * *',    'select public.fn_escalate_overdue();'],
    array['crm-renewal-alerts',   '0 7 * * *',    'select public.fn_renewal_alerts();'],
    array['crm-daily-digest',     '0 * * * *',    'select public.fn_queue_daily_digests(9);'],
    array['crm-nightly-backup',   '30 18 * * *',  'select public.fn_trigger_backup();']
  ];
  j text[];
begin
  if to_regproc('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron not installed — skipping job registration';
    return;
  end if;

  foreach j slice 1 in array v_jobs loop
    begin
      perform cron.unschedule(j[1]);
    exception when others then null;
    end;
    perform cron.schedule(j[1], j[2], j[3]);
  end loop;
end $$;

comment on function public.fn_generate_next_cycles() is
  'Runs on the 25th. Creates next month''s cycle, deliverables and task chains for every active retainer, dated from each client''s own SLA rules.';
