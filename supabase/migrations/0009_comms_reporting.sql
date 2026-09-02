-- =====================================================================
-- 0009_comms_reporting.sql
-- Meetings, action items, client reports, polymorphic comments,
-- notifications.
-- =====================================================================

create table if not exists public.meetings (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid references public.clients(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete set null,
  type          meeting_type not null default 'Review',
  title         text not null,
  starts_at     timestamptz not null,
  duration_mins int not null default 30 check (duration_mins > 0),
  timezone      text not null default 'Asia/Dubai',
  location      text,
  meeting_link  text,
  agenda        text,
  minutes       text,
  minutes_locked_at timestamptz,
  organiser_id  uuid references public.users(id),
  status        text not null default 'Scheduled' check (status in ('Scheduled','Held','Cancelled','No Show')),
  google_event_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.users(id),
  deleted_at    timestamptz,
  deleted_by    uuid references public.users(id)
);

-- Attendees as rows, not an array, so a meeting is visible to each
-- participant through the OWN axis of the visibility model.
create table if not exists public.meeting_attendees (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  user_id      uuid references public.users(id) on delete cascade,
  contact_id   uuid references public.client_contacts(id) on delete cascade,
  is_required  boolean not null default true,
  attended     boolean,
  created_at   timestamptz not null default now(),
  constraint meeting_attendees_who_chk check (num_nonnulls(user_id, contact_id) = 1)
);

create unique index if not exists meeting_attendees_user_uidx
  on public.meeting_attendees (meeting_id, user_id) where user_id is not null;
create unique index if not exists meeting_attendees_contact_uidx
  on public.meeting_attendees (meeting_id, contact_id) where contact_id is not null;

-- tasks.meeting_id FK, now that meetings exists
alter table public.tasks drop constraint if exists tasks_meeting_id_fkey;
alter table public.tasks
  add constraint tasks_meeting_id_fkey foreign key (meeting_id) references public.meetings(id) on delete set null;

create table if not exists public.action_items (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete cascade,
  description  text not null,
  owner_id     uuid references public.users(id),
  due_date     date,
  status       work_status not null default 'Not Started',
  task_id      uuid references public.tasks(id) on delete set null,   -- set when converted
  converted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id)
);

comment on column public.action_items.task_id is
  'Set by trg_action_item_to_task: saving minutes converts every action item into an assigned, dated task. The link is kept so the task can be traced back to the meeting.';

create table if not exists public.client_reports (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete set null,
  title        text not null,
  period_start date not null,
  period_end   date not null,
  report_date  date not null default current_date,
  status       work_status not null default 'Not Started',
  approval_status approval_state not null default 'Draft',
  owner_id     uuid references public.users(id),
  link         text,
  file_url     text,
  summary      text,
  shared_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.users(id),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id),
  constraint client_reports_period_chk check (period_end >= period_start)
);

comment on table public.client_reports is
  'Performance reporting is a document with dates and a status. No spend, ROAS, CPL or revenue column exists: the numbers live in the linked report artefact, not in this schema.';

-- ---------------------------------------------------------------------
-- Comments — polymorphic, immutable once posted
-- ---------------------------------------------------------------------
create table if not exists public.comments (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  client_id    uuid references public.clients(id) on delete cascade,
  parent_id    uuid references public.comments(id) on delete cascade,
  body         text not null,
  mentions     uuid[] not null default '{}',
  is_internal  boolean not null default true,   -- false = visible in the client portal
  author_id    uuid references public.users(id),
  edited_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid references public.users(id)
);

comment on column public.comments.is_internal is
  'Internal comments are invisible to CLIENT_PORTAL users at the RLS layer, not by hiding them in the UI.';

create table if not exists public.comment_revisions (
  id           uuid primary key default gen_random_uuid(),
  comment_id   uuid not null references public.comments(id) on delete cascade,
  previous_body text not null,
  edited_by    uuid references public.users(id),
  edited_at    timestamptz not null default now()
);

-- Editing a posted comment leaves a visible trail.
create or replace function public.trg_comment_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.body is distinct from old.body then
    insert into public.comment_revisions (comment_id, previous_body, edited_by)
    values (old.id, old.body, public.auth_user_id());
    new.edited_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_comment_immutable on public.comments;
create trigger trg_comment_immutable before update of body on public.comments
  for each row execute function public.trg_comment_immutable();

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  type         text not null,
  entity_type  text,
  entity_id    uuid,
  client_id    uuid references public.clients(id) on delete cascade,
  title        text not null,
  message      text,
  url          text,
  channel      notification_channel not null default 'in_app',
  priority     priority_level not null default 'Medium',
  read_at      timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists meetings_client_idx     on public.meetings (client_id) where deleted_at is null;
create index if not exists meetings_organiser_idx  on public.meetings (organiser_id) where deleted_at is null;
create index if not exists meetings_created_by_idx on public.meetings (created_by);
create index if not exists meetings_starts_at_idx  on public.meetings (starts_at) where deleted_at is null;
create index if not exists meeting_attendees_user_id_idx on public.meeting_attendees (user_id);
create index if not exists meeting_attendees_meeting_idx on public.meeting_attendees (meeting_id);

create index if not exists action_items_meeting_idx on public.action_items (meeting_id);
create index if not exists action_items_owner_idx   on public.action_items (owner_id) where deleted_at is null;
create index if not exists action_items_client_idx  on public.action_items (client_id);
create index if not exists action_items_due_idx     on public.action_items (due_date);

create index if not exists client_reports_client_idx on public.client_reports (client_id) where deleted_at is null;
create index if not exists client_reports_owner_idx  on public.client_reports (owner_id);
create index if not exists client_reports_created_by_idx on public.client_reports (created_by);
create index if not exists client_reports_period_idx on public.client_reports (period_start, period_end);

create index if not exists comments_entity_idx   on public.comments (entity_type, entity_id, created_at desc);
create index if not exists comments_author_idx   on public.comments (author_id);
create index if not exists comments_client_idx   on public.comments (client_id) where deleted_at is null;
create index if not exists comments_mentions_idx on public.comments using gin (mentions);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc) where read_at is null;
create index if not exists notifications_entity_idx on public.notifications (entity_type, entity_id);

do $$
declare t text;
begin
  foreach t in array array['meetings','action_items','client_reports','comments'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$s
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
