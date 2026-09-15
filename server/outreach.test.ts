import { describe, expect, it } from "vitest";
import type { ProductSnapshot } from "../src/product-data";
import type { EventOpportunity } from "../src/types";
import { clientProfile } from "../src/profile";
import { buildAvailabilityPlan, createVerificationDraft } from "./outreach";

function event(
  id: string,
  name: string,
  startsAt: string,
  endsAt: string,
  input: Partial<EventOpportunity> = {}
): EventOpportunity {
  return {
    id,
    name,
    city: "Example City",
    state: "Brandenburg",
    startsAt,
    endsAt,
    eventType: "street_food",
    verification: "verified",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [],
    riskSignals: [],
    missingFields: ["speciality category capacity"],
    sources: [],
    pipeline: "verifying",
    ...input
  };
}

function snapshot(events: EventOpportunity[]): ProductSnapshot {
  return {
    mode: "fixtures",
    loadedAt: "2026-07-27T15:00:00+02:00",
    profile: clientProfile,
    missingProfileInputs: [],
    sources: [],
    discovery: { rawOccurrences: 0, pending: 0, linked: 0, ignored: 0, rejected: 0 },
    bookings: [{
      id: "live-booking",
      eventName: "Live booking",
      city: "Hannover",
      state: "Lower Saxony",
      startsAt: "2026-07-22T12:00:00+02:00",
      endsAt: "2026-08-09T23:00:00+02:00",
      bookingState: "live",
      organizer: "Owner confirmed",
      relationshipNote: "Confirmed",
      confirmedFacts: [],
      missingOutcomeInputs: [],
      sources: []
    }],
    events,
    verificationQueue: []
  };
}

// The fixture events below carry fixed 2026 dates, so the "first two free weeks"
// window must be measured from a pinned clock. Without it this test rots the
// moment the real date moves past the fixture weeks.
const NOW = new Date("2026-07-27T15:00:00+02:00");

describe("availability verification queue", () => {
  it("prepares every actionable event across the first two free weeks", () => {
    const plan = buildAvailabilityPlan(snapshot([
      event("a", "Week 33 primary", "2026-08-14T10:00:00+02:00", "2026-08-16T20:00:00+02:00", {
        contactEmail: "organizer@example.com",
        application: {
          route: "email",
          capacityState: "unknown",
          lastCheckedAt: "2026-07-27T10:00:00+02:00",
          nextCheckAt: "2026-07-28T10:00:00+02:00",
          routeReachable: true,
          note: "General route verified."
        }
      }),
      event("b", "Week 33 second option", "2026-08-15T10:00:00+02:00", "2026-08-16T20:00:00+02:00"),
      event("c", "Week 34 option", "2026-08-21T10:00:00+02:00", "2026-08-23T20:00:00+02:00", {
        applicationUrl: "https://example.com/apply",
        application: {
          route: "public_form",
          capacityState: "unknown",
          lastCheckedAt: "2026-07-27T10:00:00+02:00",
          nextCheckAt: "2026-07-28T10:00:00+02:00",
          routeReachable: true,
          note: "Portal reachable."
        }
      }),
      event("d", "Week 35 excluded", "2026-08-28T10:00:00+02:00", "2026-08-30T20:00:00+02:00")
    ]), NOW);

    expect(plan.map((item) => item.event.id).sort()).toEqual(["a", "b", "c"]);
    expect(plan.filter((item) => item.weekKey === "2026-W33")).toHaveLength(2);
    expect(plan.find((item) => item.event.id === "b")).toMatchObject({
      channel: "research",
      status: "blocked_contact_missing",
      routeVerified: false
    });
    expect(plan.find((item) => item.event.id === "c")).toMatchObject({
      channel: "portal",
      status: "owner_review",
      routeVerified: true
    });
  });

  it("creates honest bilingual drafts without claiming availability", () => {
    const draft = createVerificationDraft(
      event("event-1", "Example Festival", "2026-08-14T10:00:00+02:00", "2026-08-16T20:00:00+02:00", {
        contactEmail: "events@example.com",
        organizer: "Example Events",
        application: {
          route: "email",
          capacityState: "unknown",
          lastCheckedAt: "2026-07-27T10:00:00+02:00",
          nextCheckAt: "2026-07-28T10:00:00+02:00",
          routeReachable: true,
          note: "Email route verified."
        }
      }),
      "2026-W33",
      "primary"
    );

    expect(draft.draftDe).toContain("ob noch ein Foodtruck-Standplatz verfügbar ist");
    expect(draft.draftEn).toContain("whether a food-truck pitch is still available");
    expect(draft.draftDe).not.toMatch(/bestätigt|reserviert|zugesagt/i);
    expect(draft.verificationQuestions).toHaveLength(5);
  });
});
