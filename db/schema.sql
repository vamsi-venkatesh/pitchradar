create extension if not exists pgcrypto;

create type verification_state as enum ('verified', 'partial', 'lead');
create type application_state as enum ('open', 'closed', 'unknown');
create type capacity_state as enum ('available', 'limited', 'full', 'rolling', 'not_yet_open', 'unknown');
create type booking_state as enum ('confirmed', 'live', 'completed', 'cancelled');
create type pipeline_state as enum (
  'discovered',
  'verifying',
  'watching',
  'owner_review',
  'applied',
  'accepted',
  'waitlist',
  'rejected',
  'completed'
);

create table client_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  profile_key text not null,
  display_name text not null,
  home_region text not null,
  home_postcode text,
  preferred_max_travel_minutes integer not null check (preferred_max_travel_minutes > 0),
  exceptional_max_travel_minutes integer not null check (
    exceptional_max_travel_minutes >= preferred_max_travel_minutes
  ),
  normal_days smallint[] not null,
  optional_thursday boolean not null default true,
  menu jsonb not null default '[]'::jsonb,
  operating_inputs jsonb not null default '{}'::jsonb,
  missing_inputs text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, profile_key)
);

create table registered_sources (
  id text primary key,
  name text not null,
  base_url text not null,
  source_kind text not null,
  source_layer text not null check (
    source_layer in ('event_census', 'organizer_network', 'application_route', 'procurement', 'private_demand')
  ),
  priority smallint not null check (priority between 1 and 4),
  cadence text not null,
  extraction_mode text not null,
  official_for text[] not null default '{}',
  trust_rule text not null,
  business_value text not null,
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_http_status integer
);

create table source_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references registered_sources(id),
  started_at timestamptz not null,
  completed_at timestamptz,
  run_state text not null check (run_state in ('running', 'succeeded', 'partial', 'failed')),
  records_seen integer not null default 0,
  records_changed integer not null default 0,
  error_summary text,
  run_receipt jsonb not null default '{}'::jsonb
);

create index source_runs_recent_idx on source_runs (source_id, started_at desc);

create table raw_event_occurrences (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid not null references source_runs(id) on delete cascade,
  source_id text not null references registered_sources(id),
  source_record_key text,
  raw_name text not null,
  raw_location text,
  raw_starts_at text,
  raw_ends_at text,
  raw_payload jsonb not null,
  content_hash text not null,
  observed_at timestamptz not null,
  unique (source_id, content_hash)
);

create table organizers (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null unique,
  organizer_type text not null check (
    organizer_type in ('municipality', 'festival_operator', 'zone_operator', 'trader_portal', 'association', 'private')
  ),
  website_url text,
  verification verification_state not null default 'lead',
  relationship_state text not null default 'unknown',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organizer_contacts (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references organizers(id) on delete cascade,
  contact_name text,
  responsibility text,
  email text,
  phone text,
  source_url text not null,
  last_verified_at timestamptz not null,
  unique (organizer_id, email, phone)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  external_id text not null,
  canonical_name text not null,
  city text not null,
  federal_state text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  event_type text not null,
  organizer_id uuid references organizers(id),
  organizer_name text,
  verification verification_state not null default 'lead',
  application_status application_state not null default 'unknown',
  application_deadline date,
  application_url text,
  expected_visitors integer check (expected_visitors is null or expected_visitors >= 0),
  pitch_fee_eur numeric(10,2) check (pitch_fee_eur is null or pitch_fee_eur >= 0),
  travel_minutes integer,
  travel_km numeric(8,2),
  infrastructure jsonb not null default '{}'::jsonb,
  fit_signals text[] not null default '{}',
  risk_signals text[] not null default '{}',
  missing_fields text[] not null default '{}',
  current_score integer check (current_score is null or current_score between 0 and 100),
  current_tier text,
  score_breakdown jsonb,
  pipeline pipeline_state not null default 'discovered',
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  unique (tenant_id, canonical_name, starts_at, city)
);

create index events_window_idx on events (tenant_id, starts_at, application_deadline);
create index events_pipeline_idx on events (tenant_id, pipeline);

create table event_source_links (
  raw_occurrence_id uuid not null references raw_event_occurrences(id) on delete cascade,
  event_id uuid not null references events(id) on delete cascade,
  match_method text not null check (match_method in ('exact', 'rules', 'manual')),
  match_confidence numeric(4,3) check (match_confidence between 0 and 1),
  reviewed_at timestamptz,
  primary key (raw_occurrence_id, event_id)
);

create table event_evidence (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  source_id text references registered_sources(id),
  source_url text not null,
  publisher text not null,
  is_official boolean not null default false,
  observed_at timestamptz not null,
  supports_fields text[] not null,
  evidence_excerpt text,
  content_hash text,
  created_at timestamptz not null default now()
);

create table application_windows (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  route_type text not null check (route_type in ('public_form', 'email', 'phone', 'tender', 'operator_network', 'unknown')),
  capacity capacity_state not null default 'unknown',
  opens_at timestamptz,
  deadline_at timestamptz,
  expected_next_window text,
  route_owner text,
  application_url text,
  status_note text not null,
  last_checked_at timestamptz not null,
  next_check_at timestamptz not null,
  evidence_id uuid references event_evidence(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id)
);

create index application_windows_due_idx on application_windows (next_check_at, deadline_at);

create table client_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  external_id text not null,
  event_id uuid references events(id),
  event_name text not null,
  city text not null,
  federal_state text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  state booking_state not null,
  organizer_id uuid references organizers(id),
  operating_partner_id uuid references organizers(id),
  stand_or_zone text,
  relationship_note text not null,
  confirmed_facts text[] not null default '{}',
  missing_outcome_inputs text[] not null default '{}',
  owner_confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create index client_bookings_calendar_idx on client_bookings (tenant_id, starts_at, ends_at, state);

create table booking_evidence (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references client_bookings(id) on delete cascade,
  source_url text not null,
  label text not null,
  publisher text not null,
  is_official boolean not null default false,
  observed_at timestamptz not null,
  supports_fields text[] not null,
  unique (booking_id, source_url)
);

create table event_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null references events(id) on delete cascade,
  action_type text not null,
  requested_by text not null,
  approval_state text not null check (approval_state in ('not_required', 'pending', 'approved', 'denied')),
  external_state text not null check (external_state in ('not_started', 'attempted', 'verified', 'unverified', 'failed')),
  request_payload jsonb not null default '{}'::jsonb,
  receipt jsonb,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz
);

create table event_selections (
  tenant_id uuid not null,
  event_id uuid not null references events(id) on delete cascade,
  selection_state text not null check (selection_state in ('watch', 'try', 'skip')),
  weekly_role text check (weekly_role in ('primary', 'backup', 'verify_first')),
  week_key text not null,
  selected_by text not null,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, event_id)
);

create index event_selections_week_idx on event_selections (tenant_id, week_key, selection_state);

create table event_outcomes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null references events(id) on delete cascade,
  application_result text,
  actual_revenue_eur numeric(12,2),
  actual_cost_eur numeric(12,2),
  pitch_cost_eur numeric(12,2),
  travel_cost_eur numeric(12,2),
  labour_cost_eur numeric(12,2),
  accommodation_cost_eur numeric(12,2),
  portions_sold integer,
  weather_summary text,
  repeat_invitation boolean,
  next_cycle_hint text,
  owner_rating smallint check (owner_rating is null or owner_rating between 1 and 5),
  organizer_reliability smallint check (organizer_reliability is null or organizer_reliability between 1 and 5),
  notes text,
  recorded_at timestamptz not null default now()
);

create table booking_outcomes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references client_bookings(id) on delete cascade,
  trading_date date not null,
  revenue_eur numeric(12,2),
  portions_sold integer,
  food_cost_eur numeric(12,2),
  labour_cost_eur numeric(12,2),
  weather_summary text,
  stock_loss_eur numeric(12,2),
  owner_note text,
  recorded_at timestamptz not null default now(),
  unique (booking_id, trading_date)
);

create table notification_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  channel text not null,
  destination_ciphertext text not null,
  categories text[] not null,
  consented_at timestamptz not null,
  revoked_at timestamptz,
  unique (tenant_id, channel)
);

create table agent_runtime_state (
  tenant_id text not null,
  app_id text not null,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, app_id)
);
