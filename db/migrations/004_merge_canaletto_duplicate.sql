do $$
declare
  canonical_id uuid;
  duplicate_id uuid;
begin
  select id into canonical_id
  from events
  where tenant_id = '4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5'
    and external_id = 'canaletto-dresden-2026';

  select id into duplicate_id
  from events
  where tenant_id = '4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5'
    and external_id like 'discovery:haendler-portal:%'
    and lower(city) = 'dresden'
    and (starts_at at time zone 'Europe/Berlin')::date = date '2026-08-14'
  limit 1;

  if canonical_id is not null and duplicate_id is not null then
    insert into event_source_links (
      raw_occurrence_id, event_id, match_method, match_confidence, reviewed_at
    )
    select raw_occurrence_id, canonical_id, 'rules', 1, now()
    from event_source_links
    where event_id = duplicate_id
    on conflict (raw_occurrence_id, event_id) do nothing;

    insert into event_evidence (
      event_id, source_id, source_url, publisher, is_official, observed_at,
      supports_fields, evidence_excerpt, content_hash, created_at
    )
    select canonical_id, source_id, source_url, publisher, is_official, observed_at,
      supports_fields, evidence_excerpt, content_hash, created_at
    from event_evidence
    where event_id = duplicate_id
    on conflict (event_id, content_hash) where content_hash is not null do nothing;

    insert into application_window_checks (
      event_id, checked_at, source_url, source_hash, route_type, route_scope,
      route_reachable, capacity, deadline_at, requirements, finding, created_at
    )
    select canonical_id, checked_at, source_url, source_hash, route_type, route_scope,
      route_reachable, capacity, deadline_at, requirements, finding, created_at
    from application_window_checks
    where event_id = duplicate_id
    on conflict (event_id, source_url, source_hash) do nothing;

    update application_windows canonical
    set route_type = duplicate.route_type,
      capacity = duplicate.capacity,
      deadline_at = coalesce(duplicate.deadline_at, canonical.deadline_at),
      route_owner = duplicate.route_owner,
      application_url = duplicate.application_url,
      status_note = duplicate.status_note,
      last_checked_at = greatest(canonical.last_checked_at, duplicate.last_checked_at),
      next_check_at = least(canonical.next_check_at, duplicate.next_check_at),
      route_scope = duplicate.route_scope,
      route_reachable = duplicate.route_reachable,
      requirements = duplicate.requirements,
      source_url = duplicate.source_url,
      evidence_id = null,
      updated_at = now()
    from application_windows duplicate
    where canonical.event_id = canonical_id
      and duplicate.event_id = duplicate_id;

    update events
    set canonical_name = canonical_name || ' [merge-source]'
    where id = duplicate_id;

    update events canonical
    set canonical_name = replace(duplicate.canonical_name, ' [merge-source]', ''),
      starts_at = duplicate.starts_at,
      ends_at = duplicate.ends_at,
      organizer_id = duplicate.organizer_id,
      organizer_name = duplicate.organizer_name,
      application_url = coalesce(duplicate.application_url, canonical.application_url),
      last_verified_at = greatest(canonical.last_verified_at, duplicate.last_verified_at),
      updated_at = now()
    from events duplicate
    where canonical.id = canonical_id
      and duplicate.id = duplicate_id;

    delete from events where id = duplicate_id;
  end if;
end $$;
