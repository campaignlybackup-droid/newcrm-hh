-- =====================================================================
-- 0026_add_lead_stage_enum_values.sql
-- Migration: Add 9 Lead Stages to lead_stage enum.
-- =====================================================================

alter type lead_stage add value if not exists 'New leads';
alter type lead_stage add value if not exists 'Cold lead';
alter type lead_stage add value if not exists 'Warm lead';
alter type lead_stage add value if not exists 'Call scheduled';
alter type lead_stage add value if not exists 'Follow up';
alter type lead_stage add value if not exists 'Long nurture';
alter type lead_stage add value if not exists 'Meet';
alter type lead_stage add value if not exists 'Closed';
alter type lead_stage add value if not exists 'Dead';
