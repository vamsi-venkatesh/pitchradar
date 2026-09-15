import { describe, expect, it } from "vitest";
import {
  nameMatchConfidence,
  normalizeOccurrence,
  type RawOccurrence
} from "./normalizer";

function occurrence(overrides: Partial<RawOccurrence> = {}): RawOccurrence {
  return {
    id: "raw-1",
    sourceId: "foodtruckmeile",
    sourceName: "Beispiel Foodtruckmeile",
    sourceBaseUrl: "https://example-foodtruckmeile.de/",
    sourceKind: "organizer",
    sourceLayer: "organizer_network",
    sourceRecordKey: "event-1",
    rawName: "Foodtruckmeile Siegen",
    rawLocation: "Siegen",
    rawStartsAt: "2026-07-31",
    rawEndsAt: "2026-08-02",
    rawPayload: {
      city: "Siegen",
      eventType: "street_food",
      eventUrl: "https://example-foodtruckmeile.de/siegen",
      applicationUrl: "https://example-foodtruckmeile.de/dirketbewerbung",
      routeOwner: "Beispiel Kulinarik GmbH"
    },
    contentHash: "hash",
    observedAt: "2026-07-27T12:00:00Z",
    ...overrides
  };
}

describe("event occurrence normalization", () => {
  it("matches equivalent German and English city-festival names", () => {
    expect(nameMatchConfidence(
      "CANALETTO · Dresden City Festival",
      "CANALETTO – Das Dresdner Stadtfest 2026"
    )).toBeGreaterThanOrEqual(0.9);
  });

  it("creates an honest German event candidate without claiming availability", () => {
    const result = normalizeOccurrence(
      occurrence(),
      new Date("2026-07-27T12:00:00Z")
    );
    expect(result).toMatchObject({
      state: "linked",
      candidate: {
        city: "Siegen",
        federalState: "Nordrhein-Westfalen",
        applicationRoute: "operator_network",
        applicationNote: expect.stringMatching(/has not been confirmed/i),
        verification: "partial"
      }
    });
    if (result.state === "linked") {
      expect(result.candidate.startsAt).toBe("2026-07-30T22:00:00.000Z");
      expect(result.candidate.endsAt).toBe("2026-08-02T21:59:59.000Z");
    }
  });

  it("ignores clearly foreign and expired occurrences", () => {
    expect(normalizeOccurrence(occurrence({
      rawName: "Food Truck Festival Imst 2026",
      rawLocation: "Sparkassenplatz, Imst, 6460",
      rawPayload: { venue: { city: "Imst", country: "Österreich" } }
    }), new Date("2026-07-27T12:00:00Z"))).toMatchObject({
      state: "ignored",
      note: expect.stringMatching(/outside Germany/i)
    });

    expect(normalizeOccurrence(occurrence({
      rawStartsAt: "2026-03-20",
      rawEndsAt: "2026-03-22"
    }), new Date("2026-07-27T12:00:00Z"))).toMatchObject({
      state: "ignored",
      note: expect.stringMatching(/ended/i)
    });
  });

  it("rejects records that cannot become a safe event", () => {
    expect(normalizeOccurrence(occurrence({
      rawLocation: undefined,
      rawStartsAt: undefined,
      rawPayload: {}
    }))).toMatchObject({ state: "rejected" });
  });

  it("recovers a city from the event name when a venue field contains a brand", () => {
    const result = normalizeOccurrence(occurrence({
      rawName: "Food Truck Festival Neuötting 2026",
      rawLocation: "XXXLutz Neuötting, 84524",
      rawPayload: {
        venue: { city: "84524" },
        routeOwner: "Beispiel Events GmbH"
      }
    }), new Date("2026-07-27T12:00:00Z"));
    expect(result).toMatchObject({
      state: "linked",
      candidate: {
        city: "Neuötting",
        federalState: "Bayern"
      }
    });
  });

  it("matches harmless name variants but not unrelated events", () => {
    expect(nameMatchConfidence(
      "Food Truck Festival Amberg 2026",
      "Food Truck Festival Amberg"
    )).toBe(1);
    expect(nameMatchConfidence(
      "Foodtruckmeile Siegen",
      "Street Food Festival Berlin"
    )).toBeLessThan(0.65);
  });
});

describe("normalization records a vendor-relevance verdict", () => {
  const NOW = new Date("2026-07-27T12:00:00Z");

  it("marks a food-truck occurrence relevant", () => {
    const result = normalizeOccurrence(occurrence(), NOW);
    expect(result.state).toBe("linked");
    expect(result.state === "linked" && result.candidate.vendorRelevance).toBe("relevant");
  });

  it("marks a guided tour irrelevant even though it is typed street_food", () => {
    // The real defect: eventType defaults to street_food, so the type agrees
    // with the noise. The verdict must come from the event's own name.
    const result = normalizeOccurrence(
      occurrence({ rawName: "Emporenführung auf Deutsch" }),
      NOW
    );
    expect(result.state === "linked" && result.candidate.vendorRelevance).toBe("irrelevant");
  });

  it("marks an undecidable occurrence unclear rather than guessing", () => {
    const result = normalizeOccurrence(occurrence({ rawName: "Köpenicker Herbst" }), NOW);
    expect(result.state === "linked" && result.candidate.vendorRelevance).toBe("unclear");
  });
});

describe("normalization refuses a venue string as a city", () => {
  const NOW = new Date("2026-07-27T12:00:00Z");

  it("ignores an occurrence whose only city candidate is a venue", () => {
    const result = normalizeOccurrence(
      occurrence({
        rawName: "Adventsmarkt",
        rawLocation: "Kirchplatz",
        rawPayload: { city: "Kirchplatz", eventType: "market" }
      }),
      NOW
    );
    expect(result.state).toBe("ignored");
    expect(result.note).toMatch(/No verifiable city/);
  });

  it("never invents a city to replace the venue it refused", () => {
    const result = normalizeOccurrence(
      occurrence({
        rawName: "Weihnachtsmarkt",
        rawLocation: "Vorplatz Einkaufszentrum",
        rawPayload: { city: "Vorplatz Einkaufszentrum", eventType: "christmas" }
      }),
      NOW
    );
    expect(result.state).not.toBe("linked");
  });

  it("falls through to a later candidate when one of them is usable", () => {
    const result = normalizeOccurrence(
      occurrence({
        rawName: "Stadtfest Dresden",
        rawLocation: "Dresden",
        rawPayload: { city: "Marktplatz", eventType: "city_festival" }
      }),
      NOW
    );
    expect(result.state).toBe("linked");
    expect(result.state === "linked" && result.candidate.city).toBe("Dresden");
  });

  it("keeps a real city that collides with a venue stem", () => {
    // "Halle" is a city of 240,000. The venue rule must never touch it.
    const result = normalizeOccurrence(
      occurrence({
        rawName: "Laternenfest Halle",
        rawLocation: "Halle",
        rawPayload: { city: "Halle", eventType: "city_festival" }
      }),
      NOW
    );
    expect(result.state).toBe("linked");
    expect(result.state === "linked" && result.candidate.city).toBe("Halle");
  });

  it("keeps a known city whatever the venue rule would say about it", () => {
    const result = normalizeOccurrence(
      occurrence({ rawLocation: "Dresden", rawPayload: { city: "Dresden", eventType: "market" } }),
      NOW
    );
    expect(result.state === "linked" && result.candidate.city).toBe("Dresden");
  });
});
