create table if not exists llm_usage (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  model text not null,
  prompt_tokens integer not null,
  completion_tokens integer not null
);

create index if not exists llm_usage_created_at_idx
  on llm_usage (created_at desc);
