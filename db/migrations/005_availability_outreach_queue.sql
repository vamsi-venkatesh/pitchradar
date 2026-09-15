create table if not exists availability_verification_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null references events(id) on delete cascade,
  week_key text not null,
  weekly_role text not null check (weekly_role in ('primary', 'backup', 'verify_first')),
  channel text not null check (channel in ('email', 'phone', 'portal', 'research')),
  status text not null check (
    status in (
      'owner_review',
      'blocked_contact_missing',
      'approved_waiting_connector',
      'cancelled',
      'sent',
      'answered'
    )
  ),
  recipient_name text,
  recipient_email text,
  recipient_phone text,
  application_url text,
  route_verified boolean not null default false,
  subject text not null,
  draft_de text not null,
  draft_en text not null,
  verification_questions text[] not null default '{}',
  approval_required boolean not null default true,
  approved_at timestamptz,
  approved_by text,
  sent_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, event_id, week_key)
);

create index if not exists availability_verification_queue_idx
  on availability_verification_requests (tenant_id, week_key, status, weekly_role);

create table if not exists availability_verification_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references availability_verification_requests(id) on delete cascade,
  action text not null check (
    action in ('draft_created', 'draft_refreshed', 'owner_approved', 'owner_cancelled', 'sent', 'answered')
  ),
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists availability_verification_receipts_recent_idx
  on availability_verification_receipts (request_id, occurred_at desc);
