import { describe, expect, it, vi } from "vitest";
import { extractJsonLdEvents, extractTribeEvents, probeSource } from "./source-probe";

const source = {
  id: "official-events",
  name: "Official events",
  baseUrl: "https://events.example.test/calendar"
};
const allowUrl = async (value: string) => new URL(value);

describe("registered source probe", () => {
  it("follows a bounded public redirect and returns a content receipt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "/calendar-2027" }
      }))
      .mockResolvedValueOnce(new Response("<html><title>Official calendar</title><p>Events</p></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      }));
    const result = await probeSource(source, {
      fetchImpl,
      assertUrl: allowUrl
    });
    expect(result).toMatchObject({
      state: "healthy",
      ok: true,
      status: 200,
      title: "Official calendar",
      finalUrl: "https://events.example.test/calendar-2027"
    });
    expect(result.bodyHash).toHaveLength(64);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("distinguishes access restriction from a broken source", async () => {
    const restricted = await probeSource(source, {
      fetchImpl: vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
      assertUrl: allowUrl
    });
    const missing = await probeSource(source, {
      fetchImpl: vi.fn().mockResolvedValue(new Response("Gone", { status: 404 })),
      assertUrl: allowUrl
    });
    expect(restricted.state).toBe("restricted");
    expect(restricted.error).toMatch(/blocks or rate-limits/i);
    expect(missing.state).toBe("broken");
  });

  it("returns an unavailable receipt when URL safety validation rejects a source", async () => {
    const result = await probeSource(source, {
      assertUrl: async () => {
        throw new Error("Private network targets are blocked.");
      }
    });
    expect(result).toMatchObject({
      state: "unavailable",
      finalUrl: source.baseUrl,
      error: "Private network targets are blocked."
    });
  });

  it("rejects an undeclared oversized text response instead of parsing a truncated page", async () => {
    const result = await probeSource(source, {
      fetchImpl: vi.fn().mockResolvedValue(new Response("123456", {
        status: 200,
        headers: { "content-type": "text/html" }
      })),
      assertUrl: allowUrl,
      maxBytes: 5
    });
    expect(result).toMatchObject({
      state: "degraded",
      ok: false,
      bytesReviewed: 5
    });
    expect(result.error).toMatch(/exceeds/i);
  });

  it("extracts and deduplicates only schema.org event nodes", () => {
    const event = {
      "@type": "FoodEvent",
      "@id": "event-1",
      name: "Food Festival",
      startDate: "2027-05-01",
      endDate: "2027-05-03",
      location: {
        name: "Market square",
        address: { addressLocality: "Potsdam", postalCode: "10115" }
      }
    };
    const html = `
      <script type="application/ld+json">${JSON.stringify({
        "@graph": [
          event,
          event,
          { "@type": "Organization", name: "Organizer" }
        ]
      })}</script>
    `;
    const occurrences = extractJsonLdEvents(html);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      sourceRecordKey: "event-1",
      rawName: "Food Festival",
      rawLocation: "Market square, Potsdam, 10115",
      rawStartsAt: "2027-05-01",
      rawEndsAt: "2027-05-03"
    });
  });

  it("extracts stable occurrences from a Tribe Events API response", () => {
    const payload = JSON.stringify({
      events: [{
        id: 2078,
        title: "Food Truck Festival Oberasbach 2026",
        url: "https://events.example.test/event/2078",
        start_date: "2026-08-01 12:00:00",
        end_date: "2026-08-02 19:00:00",
        venue: {
          venue: "Rathausplatz Oberasbach",
          city: "Oberasbach",
          zip: "90522"
        }
      }]
    });
    expect(extractTribeEvents(payload)).toMatchObject([{
      sourceRecordKey: "2078",
      rawName: "Food Truck Festival Oberasbach 2026",
      rawLocation: "Rathausplatz Oberasbach, Oberasbach, 90522",
      rawStartsAt: "2026-08-01 12:00:00",
      rawEndsAt: "2026-08-02 19:00:00"
    }]);
  });
});
