-- Contact resolution — impressum-grounded organizer contacts.
--
-- German commercial sites must publish an Impressum, so for most organizers a
-- real route already exists on a public page. The resolver reads those pages
-- through the SSRF-guarded fetcher and writes what it can PROVE into
-- organizer_contacts. Two things were missing for that to be honest:
--
-- 1. The EVIDENCE. `source_url` says which page a contact came from, but not
--    what on that page established it. A name is only a contact when it sits
--    next to a contact role ("Ansprechpartner", "Vertreten durch"), and the
--    matched phrase is the whole argument — so it is stored, verbatim and
--    bounded, beside the row it justifies.
-- 2. The NEGATIVE result. A page that publishes no reachable contact is a fact
--    worth keeping: without it the next run re-fetches the same dead page, and
--    the report cannot tell "not looked at" from "looked at, nothing there".
--    A receipt row records the check itself, contact or no contact.
alter table organizer_contacts
  add column if not exists evidence_snippet text;

-- The resolved role phrase, kept apart from `responsibility` (which the
-- hand-maintained intelligence targets write) so a resolved row can never be
-- mistaken for a curated one.
alter table organizer_contacts
  add column if not exists evidence_role text;

alter table organizer_contacts
  add column if not exists resolved_by text;

create table if not exists organizer_contact_checks (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references organizers(id) on delete cascade,
  event_id uuid references events(id) on delete set null,
  source_url text not null,
  checked_at timestamptz not null,
  -- 'contact_found' | 'no_contact' | 'fetch_failed'
  outcome text not null,
  finding text not null,
  evidence_snippet text,
  unique (organizer_id, source_url)
);

create index if not exists organizer_contact_checks_organizer_idx
  on organizer_contact_checks (organizer_id, checked_at desc);
