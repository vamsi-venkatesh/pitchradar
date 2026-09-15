-- Weather enrichment. Coordinates are stored on the event because geocoding a
-- city is a one-off cost; geocode_source records how precise the answer really
-- is (city-level, not the exact pitch) so nothing downstream can overclaim.
alter table events
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists geocode_source text;

-- One stored forecast per event per Berlin calendar day. `fetched_on` is a
-- plain column rather than an expression index because both `fetched_at::date`
-- and `fetched_at at time zone '...'` are STABLE, not IMMUTABLE, and therefore
-- cannot be indexed; the enricher writes the Berlin day it used.
create table if not exists event_weather (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  fetched_on date not null default ((now() at time zone 'Europe/Berlin')::date),
  source text not null,
  forecast jsonb not null,
  risk_flags text[] not null default '{}',
  unique (event_id, fetched_on)
);

create index if not exists event_weather_recent_idx
  on event_weather (event_id, fetched_at desc);
