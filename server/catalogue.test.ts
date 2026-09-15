import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot, loadProductSnapshot, mapCatalogueRows } from "./catalogue";

describe("product catalogue repository", () => {
  it("uses fixtures explicitly when no operating database is available", async () => {
    const snapshot = await loadProductSnapshot();
    expect(snapshot.mode).toBe("fixtures");
    expect(snapshot.events.length).toBeGreaterThan(10);
    expect(snapshot.sources.length).toBeGreaterThan(10);
    expect(snapshot.bookings[0]?.eventName).toMatch(/Seefest am Demo-Ufer/);
  });

  it("maps PostgreSQL rows into one shared product snapshot shape", () => {
    const mapped = mapCatalogueRows({
      profile: {
        home_region: "Brandenburg",
        home_postcode: "10115",
        normal_days: [5, 6, 0],
        optional_thursday: true,
        preferred_max_travel_minutes: 480,
        exceptional_max_travel_minutes: 600,
        menu: [{ name: "Kräuter", priceEur: 6 }],
        operating_inputs: {},
        missing_inputs: ["Truck dimensions"]
      },
      sources: [{
        id: "official-calendar",
        name: "Official calendar",
        base_url: "https://example.com/events",
        source_kind: "municipal",
        source_layer: "event_census",
        official_for: ["Example events"],
        extraction_mode: "html_adapter",
        priority: 1,
        cadence: "weekly",
        trust_rule: "Occurrence only.",
        business_value: "Finds public events.",
        last_checked_at: new Date("2026-07-27T10:00:00Z"),
        last_success_at: new Date("2026-07-27T10:00:00Z"),
        last_http_status: 200
      }],
      events: [{
        db_id: "event-db-id",
        external_id: "example-event-2027",
        canonical_name: "Example Event",
        city: "Potsdam",
        federal_state: "Brandenburg",
        starts_at: new Date("2027-05-01T10:00:00Z"),
        ends_at: new Date("2027-05-03T20:00:00Z"),
        event_type: "city_festival",
        verification: "verified",
        application_status: "open",
        application_deadline: "2027-02-01",
        application_url: "https://example.com/apply",
        organizer_name: "Example Organizer",
        contact_email: "events@example.com",
        contact_phone: null,
        expected_visitors: 12000,
        pitch_fee_eur: "450.00",
        travel_minutes: 60,
        travel_km: "42.5",
        infrastructure: { power: "16A", water: true },
        fit_signals: ["Three trading days"],
        risk_signals: ["Fee unconfirmed"],
        missing_fields: ["Category capacity"],
        current_score: 82,
        current_tier: "A",
        score_breakdown: { Duration: 5 },
        pipeline: "owner_review",
        route_type: "public_form",
        capacity: "available",
        opens_at: null,
        deadline_at: new Date("2027-02-01T23:59:00Z"),
        expected_next_window: null,
        route_owner: "Example Organizer",
        window_application_url: "https://example.com/vendor-form",
        status_note: "Vendor form is open.",
        last_checked_at: new Date("2026-07-27T10:00:00Z"),
        next_check_at: new Date("2026-08-03T10:00:00Z"),
        route_scope: "organizer_general",
        route_reachable: true,
        requirements: ["Trade permit", "Power requirement"],
        application_source_url: "https://example.com/vendor-form"
      }],
      eventEvidence: [{
        owner_id: "event-db-id",
        label: "Official event page",
        source_url: "https://example.com/event",
        publisher: "Example Organizer",
        is_official: true,
        observed_at: new Date("2026-07-27T10:00:00Z"),
        supports_fields: ["dates", "organizer"]
      }],
      bookings: [{
        db_id: "booking-db-id",
        external_id: "client-example-booking",
        event_name: "Booked Event",
        city: "Berlin",
        federal_state: "Berlin",
        starts_at: new Date("2026-08-01T10:00:00Z"),
        ends_at: new Date("2026-08-02T20:00:00Z"),
        booking_state: "confirmed",
        organizer_name: "Booking Organizer",
        operating_partner_name: null,
        relationship_note: "Owner confirmed.",
        stand_or_zone: "Market square",
        confirmed_facts: ["Booking confirmed"],
        missing_outcome_inputs: ["Revenue"]
      }],
      bookingEvidence: [{
        owner_id: "booking-db-id",
        label: "Owner confirmation",
        source_url: "owner://booking",
        publisher: "Client owner",
        is_official: true,
        observed_at: "2026-07-27T10:00:00Z",
        supports_fields: ["active_booking"]
      }],
      discovery: {
        raw_occurrences: 50,
        pending: 0,
        linked: 38,
        ignored: 12,
        rejected: 0,
        last_observed_at: "2026-07-27T12:00:00Z"
      }
    });

    expect(mapped.events[0]).toMatchObject({
      id: "example-event-2027",
      name: "Example Event",
      applicationUrl: "https://example.com/vendor-form",
      pitchFeeEur: 450,
      travelKm: 42.5,
      contactEmail: "events@example.com"
    });
    expect(mapped.events[0].application).toMatchObject({
      route: "public_form",
      capacityState: "available",
      routeOwner: "Example Organizer",
      routeScope: "organizer_general",
      routeReachable: true,
      requirements: ["Trade permit", "Power requirement"]
    });
    expect(mapped.events[0].sources[0].official).toBe(true);
    expect(mapped.bookings[0].id).toBe("client-example-booking");
    expect(mapped.profile.homePostcode).toBe("10115");
    expect(mapped.missingProfileInputs).toEqual(["Truck dimensions"]);
    expect(mapped.sources[0].healthState).toBe("healthy");
    expect(mapped.discovery).toMatchObject({
      rawOccurrences: 50,
      linked: 38,
      pending: 0
    });
  });

  it("recomputes the gap list from the intake and flags an unconfirmed menu", () => {
    const base = {
      home_region: "Brandenburg",
      home_postcode: "10115",
      normal_days: [5, 6, 0],
      optional_thursday: true,
      preferred_max_travel_minutes: 480,
      exceptional_max_travel_minutes: 600,
      menu: [
        { name: "Kräuter", priceEur: 6 },
        { name: "Variante A", priceEur: 8, confirmationRequired: true }
      ],
      operating_inputs: {},
      missing_inputs: ["A stale cached label nobody updated"]
    };
    const empty = {
      sources: [], events: [], eventEvidence: [], bookings: [], bookingEvidence: [],
      discovery: { raw_occurrences: 0, pending: 0, linked: 0, ignored: 0, rejected: 0, last_observed_at: null }
    };

    // Post-011 row: the stored column is a cache, the intake is the truth.
    const withIntake = mapCatalogueRows({
      ...empty,
      profile: {
        ...base,
        intake: {
          home_base: {
            postcode: { value: "10115", state: "provided", updatedAt: "2026-08-01T09:00:00Z" },
            streetAddress: { value: "Hauptstr. 1", state: "provided", updatedAt: "2026-08-01T09:00:00Z" }
          }
        },
        menu_confirmed_at: null
      }
    });
    expect(withIntake.missingProfileInputs)
      .not.toContain("A stale cached label nobody updated");
    expect(withIntake.missingProfileInputs)
      .not.toContain("Exact postcode / starting address");
    // The client has confirmed no line, and that is now a first-class gap.
    expect(withIntake.missingProfileInputs)
      .toContain("Client confirmation of the menu names and prices");
    // Per-line flags are the founder's "cannot decode this name" signal and are
    // passed through untouched — they are not the confirmation state.
    expect(withIntake.profile.menu.map((item) => item.confirmationRequired))
      .toEqual([undefined, true]);

    // Pre-011 row (deploy window, before migrations run): stored column stands.
    const withoutIntake = mapCatalogueRows({ ...empty, profile: base });
    expect(withoutIntake.missingProfileInputs).toEqual(["A stale cached label nobody updated"]);

    // Once the client confirms, the gap closes.
    const confirmed = mapCatalogueRows({
      ...empty,
      profile: { ...base, intake: {}, menu_confirmed_at: "2026-08-01T10:00:00Z" }
    });
    expect(confirmed.missingProfileInputs)
      .not.toContain("Client confirmation of the menu names and prices");
  });

  it("keeps the fixture marker honest", () => {
    expect(fixtureProductSnapshot().mode).toBe("fixtures");
    expect(fixtureProductSnapshot().discovery.rawOccurrences).toBe(0);
  });
});
