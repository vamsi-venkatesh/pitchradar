-- Deadline monitor. Until now a NULL application_windows.deadline_at meant two
-- different things: "no deadline has been published yet" and "no deadline
-- exists because the organizer accepts applications on a rolling basis". The
-- product cannot be honest about either while they share one representation,
-- so the distinction gets its own column.
alter table application_windows
  add column if not exists deadline_evidence text not null default 'not_found'
    check (deadline_evidence in ('published', 'not_found', 'none_rolling'));

-- Backfill from what the existing rows already prove.
update application_windows
   set deadline_evidence = 'published'
 where deadline_at is not null;

update application_windows
   set deadline_evidence = 'none_rolling'
 where deadline_at is null
   and capacity = 'rolling';

-- One row per (event, threshold, deadline value). The unique key is what makes
-- alert generation idempotent: re-running the monitor creates nothing new, and
-- a changed deadline is a different value, so it earns its own alerts.
create table if not exists deadline_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null references events(id) on delete cascade,
  window_id uuid references application_windows(id) on delete set null,
  threshold_days int not null check (threshold_days > 0),
  deadline_at date not null,
  alert_state text not null check (alert_state in ('pending', 'surfaced')),
  created_at timestamptz not null default now(),
  unique (event_id, threshold_days, deadline_at)
);

create index if not exists deadline_alerts_pending_idx
  on deadline_alerts (tenant_id, alert_state, deadline_at);
