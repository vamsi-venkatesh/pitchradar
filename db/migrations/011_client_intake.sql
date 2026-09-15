alter table client_profiles
  add column if not exists intake jsonb not null default '{}'::jsonb,
  add column if not exists intake_status jsonb not null default '{}'::jsonb,
  add column if not exists menu_confirmed_at timestamptz,
  add column if not exists intake_completed_at timestamptz;
