# Limitations

Stated plainly, because a system that hides these is harder to trust than one that names them.

## Single-tenant by construction

The tenant is hard-coded. A tenant UUID is a module constant in several server stages, the gateway route accepts exactly one tenant identifier, and shared memory is scoped by a fixed `tenantId` / `appId` pair. This was a deliberate trade for a single-operator product and it is not a multi-tenant system: making it one means threading tenancy through the stages, the retrieval layer and the reports, not flipping a flag.

## Proposal-only — there are no outbound connectors

Nothing leaves the system. `propose_external_action` creates a held proposal and never executes; approval records `approved_waiting_connector` and stops. No email, application-form or WhatsApp connector is implemented, in this repository or in the private deployment. That is a design position (a human approves every outbound message in this domain), but it also means the last mile is unbuilt: a delivery connector would need its own implementation, credentials, consent handling, templates and audit before it could send anything.

## Travel gating is not yet decisive

Fit scoring uses the operator's declared travel radius and trading days, but the inputs that would make a travel decision *final* — exact starting address, portions per hour, food/labour/travel cost, minimum acceptable revenue, pitch fee ceiling — are operator inputs that are still outstanding. The product tracks them as explicitly missing rather than substituting a guess, so travel-based rejection is currently advisory, not conclusive.

## Weather is city precision, and only that

Coordinates come from a public geocoding API at **city** precision, and the stored record says so (`geocode_source`). A city centroid is not the pitch location; a forecast here is a regional signal for a near-term event, never a site condition. It also never touches the fit score — that is asserted in the test suite, not merely intended.

## Coverage is measured, not complete

The system reports what it has checked and when, and every source carries a health receipt. It cannot report national completeness, and it does not claim to: a source that has never been checked is shown as never checked, a broken one as broken. Private and corporate demand (direct catering enquiries, private property, corporate bookings) is a declared coverage gap with no source layer behind it at all.

## Some sources cannot be automated

Several genuinely useful sources are `manual_verification` on purpose:

- calendars that only serve a search form or assemble their listings in the browser, so there is nothing for an adapter to read;
- listings that are official but voluntary and explicitly incomplete, where each organizer still has to be followed separately;
- PDF annual plans, which are read but not reliably structured;
- and at least one partner page that refuses automated access outright (HTTP 403), so it is read by a person or not at all.

Registered sources without a dedicated adapter still receive health receipts, but their events do not become raw occurrences until an adapter for that family exists.

## What this repository specifically cannot show

The public source registry here is deliberately reduced (ten representative entries plus placeholders), so counts computed from it are counts of *this repository's* configuration and nothing else. The same applies to the committed sample report: it is generated from the fixture snapshot, and its numbers are fixture numbers. Neither is a business metric. See [what remains private](what-remains-private.md).
