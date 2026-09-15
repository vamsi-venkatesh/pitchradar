alter table raw_event_occurrences
  add column if not exists normalization_state text not null default 'pending'
    check (normalization_state in ('pending', 'linked', 'ignored', 'rejected')),
  add column if not exists normalized_at timestamptz,
  add column if not exists normalization_note text;

create index if not exists raw_event_occurrences_pending_idx
  on raw_event_occurrences (normalization_state, observed_at)
  where normalization_state = 'pending';

create unique index if not exists event_evidence_event_content_unique
  on event_evidence (event_id, content_hash)
  where content_hash is not null;
