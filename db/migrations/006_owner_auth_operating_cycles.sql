create table if not exists operating_cycles (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('manual', 'schedule')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  state text not null check (state in ('running', 'succeeded', 'partial', 'failed', 'skipped_locked')),
  stages jsonb not null default '[]'::jsonb,
  error_summary text,
  external_actions integer not null default 0 check (external_actions = 0)
);

create index if not exists operating_cycles_recent_idx
  on operating_cycles (started_at desc);
