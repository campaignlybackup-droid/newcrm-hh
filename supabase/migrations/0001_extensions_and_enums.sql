-- =====================================================================
-- 0001_extensions_and_enums.sql
-- Agency Operations CRM — extensions, domains and enumerated types.
--
-- ADDITIVE ONLY. Never drop or retype a column in a later migration;
-- add a new one and backfill.
--
-- HARD RULE ENFORCED THROUGHOUT THIS SCHEMA: there is no money module.
-- No invoice, budget, price, cost, rate, salary, payroll, expense,
-- revenue or currency column exists anywhere. Work is modelled with
-- dates, statuses, ownership and workload only. Migration 0013 installs
-- a regression guard that fails CI if a money-shaped column is ever added.
-- =====================================================================

create schema if not exists extensions;

create extension if not exists "pgcrypto"   with schema extensions;  -- gen_random_uuid
create extension if not exists "ltree";                              -- reporting tree paths
create extension if not exists "btree_gist" with schema extensions;  -- equipment exclusion constraint
create extension if not exists "pg_trgm"    with schema extensions;  -- duplicate-name fuzzy guard
create extension if not exists "unaccent"   with schema extensions;

-- pg_cron / pg_net live in their own schema on Supabase and are created
-- by migration 0016 so that this file stays runnable on a bare Postgres.

-- ---------------------------------------------------------------------
-- Scope + permission vocabulary
-- ---------------------------------------------------------------------
do $$ begin
  create type access_scope as enum ('ALL', 'SUBTREE', 'TEAM', 'OWN', 'CLIENT_PORTAL', 'NONE');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
do $$ begin
  create type employment_type as enum ('Full-time', 'Part-time', 'Intern', 'Freelancer', 'Contract', 'External');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum ('Invited', 'Active', 'On Leave', 'Suspended', 'Offboarded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type leave_type as enum ('Casual', 'Sick', 'Earned', 'Unpaid', 'Comp Off', 'Holiday');
exception when duplicate_object then null; end $$;

do $$ begin
  create type leave_status as enum ('Requested', 'Approved', 'Rejected', 'Cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Clients & pipeline
-- ---------------------------------------------------------------------
do $$ begin
  create type client_status as enum ('Lead', 'Onboarding', 'Active', 'Paused', 'Churned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type priority_level as enum ('Low', 'Medium', 'High', 'Critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lead_stage as enum ('New', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type access_status as enum ('Granted', 'Pending', 'Not required', 'Revoked');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------
do $$ begin
  create type project_type as enum ('Retainer', 'One-off', 'Campaign');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum ('Planned', 'Active', 'On Hold', 'Completed', 'Cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type health_status as enum ('Green', 'Amber', 'Red');
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_status as enum ('Not Started', 'In Progress', 'Blocked', 'In Review', 'Changes Requested', 'Approved', 'Scheduled', 'Delivered', 'Cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_state as enum ('Not Required', 'Draft', 'Pending', 'Approved', 'Changes Requested', 'Rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_level as enum ('Internal', 'Lead', 'Manager', 'Client');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------
do $$ begin
  create type shoot_type as enum ('Reel', 'Cinematic', 'Product', 'Event', 'Interview', 'Photoshoot');
exception when duplicate_object then null; end $$;

do $$ begin
  create type shoot_status as enum ('Tentative', 'Confirmed', 'In Progress', 'Wrapped', 'Postponed', 'Cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Social
-- ---------------------------------------------------------------------
do $$ begin
  create type social_platform as enum ('Instagram', 'Facebook', 'YouTube', 'LinkedIn', 'X', 'Threads', 'Pinterest', 'Google', 'Website', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type content_type as enum ('Reel', 'Carousel', 'Static', 'Story', 'Short', 'Long-form Video', 'Blog', 'Newsletter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type campaign_objective as enum ('Awareness', 'Traffic', 'Engagement', 'Leads', 'App Installs', 'Conversions', 'Retention');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Meetings, assets, system
-- ---------------------------------------------------------------------
do $$ begin
  create type meeting_type as enum ('Kickoff', 'Review', 'Strategy', 'Internal', 'Shoot Recce', 'Training');
exception when duplicate_object then null; end $$;

do $$ begin
  create type asset_type as enum ('Raw Footage', 'Edit', 'Image', 'Design', 'Document', 'Audio', 'Link', 'Other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_action as enum ('INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notification_channel as enum ('in_app', 'email', 'digest');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Shared column defaults
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger keeping updated_at honest regardless of client payload.';
