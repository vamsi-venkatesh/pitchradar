create table if not exists gateway_requests (
  gateway_message_id text primary key,
  request_kind text not null,
  status text not null check (status in ('processing', 'completed', 'failed_unknown')),
  response jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text
);

create index if not exists gateway_requests_status_index
  on gateway_requests(status, started_at);
