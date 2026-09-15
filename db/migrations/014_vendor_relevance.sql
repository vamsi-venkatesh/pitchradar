-- Vendor relevance. A municipal or tourism calendar is a Layer 1 census: it
-- lists every public happening in a city, so guided tours, lectures, museum
-- exhibitions and planetarium shows arrive through the same feed, in the same
-- shape, as a Weihnachtsmarkt. `event_type` cannot carry this distinction --
-- the normalizer defaults an unrecognised occurrence to 'street_food', so in
-- the 2026-09-15 collection "Emporenführung auf Deutsch" is stored as a street
-- food event. The verdict is therefore its own column, written by the
-- deterministic classifier in server/vendor-relevance.ts.
--
-- 'unclear' is the default and the honest one: a row the rules cannot decide
-- is deducted for and tagged in the report, never silently dropped the way an
-- 'irrelevant' row is.
alter table events
  add column if not exists vendor_relevance text not null default 'unclear';

do $$
begin
  alter table events
    add constraint events_vendor_relevance_check
    check (vendor_relevance in ('relevant', 'irrelevant', 'unclear'));
exception
  when duplicate_object then null;
end
$$;

-- The report and the ranking both filter on this, over the whole tenant.
create index if not exists events_vendor_relevance_idx
  on events (tenant_id, vendor_relevance);
