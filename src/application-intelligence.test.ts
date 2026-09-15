import { describe, expect, it } from "vitest";
import { applicationDecision, applicationIntelligenceFor } from "./application-intelligence";
import { eventLeads } from "./events";
import type { EventOpportunity } from "./types";

function event(id: string) {
  return eventLeads.find((item) => item.id === id)!;
}

// Fixture events carry fixed 2026 dates — pin the clock so tests don't rot.
const TEST_NOW = new Date("2026-07-27T15:00:00+02:00");

describe("application intelligence", () => {
  it("turns a published deadline into an actionable countdown", () => {
    const decision = applicationDecision(
      event("mainzer-rheinfruehling-2027"),
      new Date("2026-07-27T15:00:00+02:00")
    );
    expect(decision.phase).toBe("open");
    expect(decision.daysRemaining).toBe(35);
    expect(decision.nextAction).toMatch(/Confirm capacity/);
  });

  it("keeps rolling applications distinct from a guaranteed available pitch", () => {
    const decision = applicationDecision(event("norder-sommerfest-2026"), TEST_NOW);
    expect(decision.phase).toBe("rolling");
    expect(decision.label).toBe("Rolling applications");
    expect(decision.nextAction).toMatch(/suitable pitch remains/);
  });

  it("blocks a passed deadline and preserves the next-cycle action", () => {
    const decision = applicationDecision(event("schlachtefest-paaren-2026"), TEST_NOW);
    expect(decision.phase).toBe("full");
    expect(decision.urgency).toBe("blocked");
  });

  it("uses a verified general route without claiming category capacity", () => {
    const lead = event("canaletto-dresden-2026");
    const decision = applicationDecision({
      ...lead,
      application: {
        ...lead.application!,
        routeScope: "portal_general",
        routeReachable: true,
        capacityState: "unknown"
      }
    }, TEST_NOW);
    expect(decision.label).toBe("Contact route verified");
    expect(decision.nextAction).toMatch(/whether a speciality pitch remains/i);
  });
});

describe("events with no application window", () => {
  function unwatchedEvent(input: Partial<EventOpportunity> = {}): EventOpportunity {
    return {
      id: "no-window",
      name: "Never checked festival",
      city: "Example City",
      state: "Brandenburg",
      startsAt: "2026-08-14T10:00:00+02:00",
      endsAt: "2026-08-16T20:00:00+02:00",
      eventType: "street_food",
      verification: "lead",
      applicationState: "unknown",
      infrastructure: {},
      fitSignals: [],
      riskSignals: [],
      missingFields: [],
      sources: [],
      pipeline: "verifying",
      ...input
    };
  }

  it("reports no check history instead of inventing one", () => {
    const intel = applicationIntelligenceFor(unwatchedEvent());
    expect(intel.lastCheckedAt).toBeNull();
    expect(intel.nextCheckAt).toBeNull();
  });

  it("still reports no check history when a public application URL exists", () => {
    const intel = applicationIntelligenceFor(unwatchedEvent({
      applicationUrl: "https://example.com/apply",
      applicationState: "open"
    }));
    expect(intel.lastCheckedAt).toBeNull();
    expect(intel.nextCheckAt).toBeNull();
    expect(intel.route).toBe("public_form");
  });

  it("keeps a usable decision without a check history", () => {
    const decision = applicationDecision(
      unwatchedEvent({ applicationUrl: "https://example.com/apply", applicationState: "open" }),
      TEST_NOW
    );
    expect(decision.phase).toBe("open");
    expect(decision.urgency).toBe("verify");
    expect(decision.nextAction).toMatch(/Confirm a speciality pitch remains/);
  });

  it("does not disturb events that do carry a window row", () => {
    const lead = event("mainzer-rheinfruehling-2027");
    const intel = applicationIntelligenceFor(lead);
    expect(intel).toBe(lead.application);
    expect(intel.lastCheckedAt).toBe(lead.application!.lastCheckedAt);
    expect(intel.nextCheckAt).toBe(lead.application!.nextCheckAt);
    expect(intel.lastCheckedAt).not.toBeNull();
  });
});
