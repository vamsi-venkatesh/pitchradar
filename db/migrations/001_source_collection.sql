alter table registered_sources
  add column if not exists collector_url text;
