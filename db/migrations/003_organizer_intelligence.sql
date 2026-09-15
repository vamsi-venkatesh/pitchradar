alter table application_windows
  add column if not exists route_scope text not null default 'unknown'
    check (route_scope in ('event_specific', 'organizer_general', 'portal_general', 'unknown')),
  add column if not exists route_reachable boolean,
  add column if not exists requirements text[] not null default '{}',
  add column if not exists source_url text;

create table if not exists application_window_checks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  checked_at timestamptz not null,
  source_url text not null,
  source_hash text not null,
  route_type text not null check (
    route_type in ('public_form', 'email', 'phone', 'tender', 'operator_network', 'unknown')
  ),
  route_scope text not null check (
    route_scope in ('event_specific', 'organizer_general', 'portal_general', 'unknown')
  ),
  route_reachable boolean not null,
  capacity capacity_state not null default 'unknown',
  deadline_at timestamptz,
  requirements text[] not null default '{}',
  finding text not null,
  created_at timestamptz not null default now(),
  unique (event_id, source_url, source_hash)
);

create index if not exists application_window_checks_recent_idx
  on application_window_checks (event_id, checked_at desc);
