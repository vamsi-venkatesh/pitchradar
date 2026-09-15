import { describe, expect, it } from "vitest";
import { extractOccurrences, sourceCollectionUrl, sourceNextDueAt } from "./collector";
import type { RegisteredSource } from "../src/source-registry";
import type { SourceProbeResult } from "./source-probe";

const NOW = new Date("2026-08-01T09:00:00.000Z");

function source(overrides: Partial<RegisteredSource> = {}): RegisteredSource {
  return {
    id: "test-source",
    name: "Test source",
    baseUrl: "https://events.example.test/",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Test tour"],
    extractionMode: "json_ld_first",
    priority: 1,
    cadence: "daily",
    trustRule: "Verify",
    businessValue: "Multi-city route",
    ...overrides
  };
}

function probe(bodyText: string): SourceProbeResult {
  return {
    sourceId: "test-source",
    sourceName: "Test source",
    requestedUrl: "https://events.example.test/",
    finalUrl: "https://events.example.test/",
    checkedAt: NOW.toISOString(),
    state: "healthy",
    ok: true,
    status: 200,
    contentType: "text/html",
    bodyText,
    bytesReviewed: bodyText.length
  };
}

describe("source collector schedule", () => {
  it("runs never-checked sources immediately", () => {
    expect(sourceNextDueAt(null, "monthly")).toBe(0);
  });

  it("calculates each cadence from the source's last durable receipt", () => {
    const last = "2026-07-27T10:00:00.000Z";
    expect(new Date(sourceNextDueAt(last, "daily")).toISOString()).toBe("2026-07-28T10:00:00.000Z");
    expect(new Date(sourceNextDueAt(last, "weekly")).toISOString()).toBe("2026-08-03T10:00:00.000Z");
    expect(new Date(sourceNextDueAt(last, "manual")).toISOString()).toBe("2026-08-10T10:00:00.000Z");
  });

  it("builds a bounded rolling window for a structured collector endpoint", () => {
    const url = new URL(sourceCollectionUrl({
      id: "tour",
      name: "Tour",
      baseUrl: "https://events.example.test/",
      collectorUrl: "https://events.example.test/wp-json/events",
      kind: "organizer",
      layer: "organizer_network",
      officialFor: ["Tour"],
      extractionMode: "api",
      priority: 1,
      cadence: "daily",
      trustRule: "Verify",
      businessValue: "Multi-city route"
    }, new Date("2026-07-27T10:00:00.000Z")));
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("start_date")).toBe("2026-07-13");
    expect(url.searchParams.get("end_date")).toBe("2028-01-27");
  });
});

describe("collector extraction routing", () => {
  it("routes an ics source to the calendar extractor", () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ics-1",
      "SUMMARY:Street Food Festival Neuwied 2026",
      "DTSTART;VALUE=DATE:20260918",
      "DTEND;VALUE=DATE:20260921",
      "LOCATION:Marktplatz\\, 56564 Neuwied",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    expect(extractOccurrences(
      source({ extractionMode: "ics", collectorUrl: "https://events.example.test/?ical=1" }),
      probe(calendar),
      NOW
    )).toMatchObject([{
      rawName: "Street Food Festival Neuwied 2026",
      rawStartsAt: "2026-09-18",
      rawEndsAt: "2026-09-20",
      rawPayload: { city: "Neuwied", extraction: "ics" }
    }]);
  });

  it("routes any The Events Calendar feed through the structured API reader", () => {
    const payload = JSON.stringify({
      events: [{
        id: 4242,
        title: "Street Food Festival Cottbus",
        url: "https://events.example.test/event/4242",
        start_date: "2026-09-04 12:00:00",
        end_date: "2026-09-06 20:00:00",
        venue: { venue: "Altmarkt", city: "Cottbus", zip: "03046" }
      }]
    });
    expect(extractOccurrences(
      source({
        extractionMode: "api",
        collectorUrl: "https://events.example.test/wp-json/tribe/events/v1/events"
      }),
      probe(payload),
      NOW
    )).toMatchObject([{
      rawName: "Street Food Festival Cottbus",
      rawLocation: "Altmarkt, Cottbus, 03046",
      rawPayload: { eventUrl: "https://events.example.test/event/4242" }
    }]);
  });

  it("falls back to schema.org extraction for a source without its own adapter", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Event",
      name: "Stadtfest Rathenow",
      startDate: "2026-09-05",
      endDate: "2026-09-06",
      location: { name: "Markt", address: { addressLocality: "Rathenow", postalCode: "14712" } }
    })}</script>`;
    expect(extractOccurrences(source(), probe(html), NOW)).toMatchObject([{
      rawName: "Stadtfest Rathenow",
      rawLocation: "Markt, Rathenow, 14712",
      rawPayload: { city: "Rathenow", extraction: "json_ld" }
    }]);
  });

  it("returns nothing when the probe carried no body", () => {
    expect(extractOccurrences(source(), { ...probe(""), bodyText: undefined }, NOW)).toEqual([]);
  });
});
