import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientProfile } from "../src/profile";
import { scoreOpportunity } from "../src/ranking";
import type { EventOpportunity } from "../src/types";
import {
  deriveRiskFlags,
  parseWeatherWindowDays,
  runWeatherEnrichmentOn,
  weatherInternals,
  type DailyForecast,
  type WeatherQueryRunner
} from "./weather";

/** Pinned clock. 2026-06-10T08:00Z is 10:00 in Berlin. */
const NOW = new Date("2026-06-10T08:00:00.000Z");
const MS_DAY = 86_400_000;

interface EventFixture {
  id: string;
  canonical_name: string;
  city: string;
  starts_at: Date;
  ends_at: Date;
  latitude: number | null;
  longitude: number | null;
}

function daily(overrides: Partial<DailyForecast> = {}): DailyForecast {
  return {
    time: ["2026-06-13", "2026-06-14"],
    precipitation_sum: [0.2, 0.0],
    precipitation_probability_max: [10, 5],
    wind_speed_10m_max: [12, 9],
    temperature_2m_max: [22, 24],
    temperature_2m_min: [12, 13],
    ...overrides
  };
}

/** Records the SQL issued and applies the window predicate itself, so the
 * gating claim is tested against the real bounds the code passes. */
function fakeClient(events: EventFixture[]) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const stored: Array<{ eventId: string; source: string; forecast: Record<string, unknown>; riskFlags: string[]; fetchedOn: string }> = [];
  const coordinates: Array<{ eventId: string; latitude: number; longitude: number; source: string }> = [];
  const client: WeatherQueryRunner = {
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      const sql = text.toLowerCase();
      if (sql.includes("from events e")) {
        const [, from, to] = values as [string, string, string];
        const rows = events.filter((event) =>
          event.ends_at.toISOString() >= from && event.starts_at.toISOString() <= to);
        return { rows: rows as never[], rowCount: rows.length };
      }
      if (sql.includes("update events")) {
        const [eventId, latitude, longitude, source] = values as [string, number, number, string];
        coordinates.push({ eventId, latitude, longitude, source });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into event_weather")) {
        const [eventId, , fetchedOn, source, forecast, riskFlags] =
          values as [string, string, string, string, string, string[]];
        stored.push({ eventId, source, forecast: JSON.parse(forecast), riskFlags, fetchedOn });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${text}`);
    }
  };
  return { client, statements, stored, coordinates };
}

function event(overrides: Partial<EventFixture> = {}): EventFixture {
  return {
    id: "event-1",
    canonical_name: "Stadtfest Beispiel",
    city: "Potsdam",
    starts_at: new Date(NOW.getTime() + 3 * MS_DAY),
    ends_at: new Date(NOW.getTime() + 4 * MS_DAY),
    latitude: 52.4,
    longitude: 13.06,
    ...overrides
  };
}

function stubFetch(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    const body = JSON.stringify(handler(url));
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(body.length) },
      text: async () => body
    } as unknown as Response;
  });
}

const originalFetchImpl = weatherInternals.fetchImpl;
afterEach(() => {
  weatherInternals.fetchImpl = originalFetchImpl;
});

describe("weather window configuration", () => {
  it("defaults to ten days and rejects nonsense", () => {
    expect(parseWeatherWindowDays(undefined)).toBe(10);
    expect(parseWeatherWindowDays("4")).toBe(4);
    expect(() => parseWeatherWindowDays("ten")).toThrow(/whole day count/i);
    expect(() => parseWeatherWindowDays("40")).toThrow(/between 1 and 16/i);
  });
});

describe("risk flag derivation", () => {
  it("raises rain on probability or on accumulation", () => {
    expect(deriveRiskFlags(daily({ precipitation_probability_max: [10, 60] }))).toEqual(["rain"]);
    expect(deriveRiskFlags(daily({ precipitation_sum: [0, 5.4] }))).toEqual(["rain"]);
    expect(deriveRiskFlags(daily({ precipitation_probability_max: [59, 40], precipitation_sum: [4.9, 0] })))
      .toEqual([]);
  });

  it("raises wind, heat and cold at their fixed thresholds", () => {
    expect(deriveRiskFlags(daily({ wind_speed_10m_max: [12, 41] }))).toEqual(["wind"]);
    expect(deriveRiskFlags(daily({ temperature_2m_max: [22, 32] }))).toEqual(["heat"]);
    expect(deriveRiskFlags(daily({ temperature_2m_max: [4, 5] }))).toEqual(["cold"]);
    expect(deriveRiskFlags(daily({ temperature_2m_max: [6, 8] }))).toEqual([]);
  });

  it("raises nothing from a missing measurement", () => {
    expect(deriveRiskFlags({ time: ["2026-06-13"] })).toEqual([]);
    expect(deriveRiskFlags(daily({ wind_speed_10m_max: [null, null] }))).toEqual([]);
  });

  it("flags every risk a multi-day forecast actually carries", () => {
    expect(deriveRiskFlags(daily({
      precipitation_probability_max: [80, 10],
      wind_speed_10m_max: [45, 10],
      temperature_2m_max: [33, 20]
    }))).toEqual(["rain", "wind", "heat"]);
  });
});

describe("weather enrichment pass", () => {
  it("leaves an event outside the window completely untouched", async () => {
    const { client, statements, stored } = fakeClient([
      event({ id: "far", starts_at: new Date(NOW.getTime() + 11 * MS_DAY), ends_at: new Date(NOW.getTime() + 12 * MS_DAY) })
    ]);
    const fetchImpl = stubFetch(() => ({ daily: daily() }));
    weatherInternals.fetchImpl = fetchImpl as never;

    const receipt = await runWeatherEnrichmentOn(client, { now: NOW, windowDays: 10 });

    expect(receipt.eventsInWindow).toBe(0);
    expect(receipt.forecastsFetched).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
    expect(statements).toHaveLength(1);
  });

  it("fetches and stores a forecast with its own request receipt", async () => {
    const { client, stored } = fakeClient([event()]);
    const urls: string[] = [];
    weatherInternals.fetchImpl = stubFetch((url) => {
      urls.push(url);
      return { daily: daily({ precipitation_probability_max: [75, 20] }) };
    }) as never;

    const receipt = await runWeatherEnrichmentOn(client, { now: NOW, windowDays: 10 });

    expect(receipt).toMatchObject({
      eventsInWindow: 1,
      geocoded: 0,
      forecastsFetched: 1,
      riskFlagged: 1,
      failures: []
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("https://api.open-meteo.com/v1/forecast");
    expect(urls[0]).toContain("start_date=2026-06-13");
    expect(urls[0]).toContain("end_date=2026-06-14");
    expect(urls[0]).toContain("timezone=Europe%2FBerlin");
    expect(stored[0].riskFlags).toEqual(["rain"]);
    expect(stored[0].fetchedOn).toBe("2026-06-10");
    expect(stored[0].forecast.requestUrl).toBe(urls[0]);
    expect(stored[0].forecast.fetchedAt).toBe(NOW.toISOString());
    expect(stored[0].forecast.geocodePrecision).toBe("city");
    expect((stored[0].forecast.daily as DailyForecast).time).toEqual(["2026-06-13", "2026-06-14"]);
  });

  it("geocodes a city once and records that the precision is city-level", async () => {
    const { client, coordinates } = fakeClient([event({ latitude: null, longitude: null })]);
    const urls: string[] = [];
    weatherInternals.fetchImpl = stubFetch((url) => {
      urls.push(url);
      if (url.includes("geocoding-api")) return { results: [{ latitude: 52.4, longitude: 13.06 }] };
      return { daily: daily() };
    }) as never;

    const receipt = await runWeatherEnrichmentOn(client, { now: NOW, windowDays: 10 });

    expect(receipt.geocoded).toBe(1);
    expect(receipt.forecastsFetched).toBe(1);
    expect(urls[0]).toContain("https://geocoding-api.open-meteo.com/v1/search");
    expect(urls[0]).toContain("country_code=DE");
    expect(urls[0]).toContain("name=Potsdam");
    expect(coordinates).toEqual([
      { eventId: "event-1", latitude: 52.4, longitude: 13.06, source: "open-meteo-geocoding" }
    ]);
  });

  it("skips an event it cannot locate, records the failure and carries on", async () => {
    const { client, stored } = fakeClient([
      event({ id: "unlocatable", city: "Nirgendwo", latitude: null, longitude: null }),
      event({ id: "known" })
    ]);
    weatherInternals.fetchImpl = stubFetch((url) => {
      if (url.includes("geocoding-api")) return { results: [] };
      return { daily: daily() };
    }) as never;

    const receipt = await runWeatherEnrichmentOn(client, { now: NOW, windowDays: 10 });

    expect(receipt.eventsInWindow).toBe(2);
    expect(receipt.failures).toEqual([{
      eventId: "unlocatable",
      eventName: "Stadtfest Beispiel",
      stage: "geocode",
      error: 'No German geocoding result for "Nirgendwo" (tried: Nirgendwo).'
    }]);
    expect(receipt.forecastsFetched).toBe(1);
    expect(stored.map((row) => row.eventId)).toEqual(["known"]);
  });

  it("records a forecast failure rather than throwing the cycle down", async () => {
    const { client } = fakeClient([event()]);
    weatherInternals.fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "0" },
      text: async () => ""
    }) as unknown as Response) as never;

    const receipt = await runWeatherEnrichmentOn(client, { now: NOW, windowDays: 10 });

    expect(receipt.forecastsFetched).toBe(0);
    expect(receipt.failures).toHaveLength(1);
    expect(receipt.failures[0]).toMatchObject({ eventId: "event-1", stage: "forecast" });
    expect(receipt.failures[0].error).toMatch(/HTTP 503/);
  });
});

describe("the fit score never reads weather", () => {
  const base: EventOpportunity = {
    id: "score-event",
    name: "Stadtfest Beispiel",
    city: "Potsdam",
    state: "Brandenburg",
    startsAt: new Date(NOW.getTime() + 3 * MS_DAY).toISOString(),
    endsAt: new Date(NOW.getTime() + 4 * MS_DAY).toISOString(),
    eventType: "city_festival",
    verification: "verified",
    applicationState: "open",
    applicationDeadline: "2026-06-20",
    expectedVisitors: 18_000,
    pitchFeeEur: 420,
    travelMinutes: 60,
    travelKm: 45,
    infrastructure: { power: "16A", water: true },
    fitSignals: ["Street food zone"],
    riskSignals: [],
    missingFields: [],
    sources: [],
    pipeline: "watching"
  };

  it("produces an identical score and breakdown with a storm forecast attached", () => {
    const without = scoreOpportunity(base, clientProfile, NOW);
    const withWeather = scoreOpportunity(
      {
        ...base,
        weather: {
          fetchedAt: NOW.toISOString(),
          source: "open-meteo-forecast",
          riskFlags: ["rain", "wind", "heat", "cold"]
        }
      } as EventOpportunity,
      clientProfile,
      NOW
    );
    expect(withWeather.score).toBe(without.score);
    expect(withWeather.tier).toBe(without.tier);
    expect(withWeather.scoreBreakdown).toEqual(without.scoreBreakdown);
    expect(withWeather.rejectionReason).toBe(without.rejectionReason);
  });
});

describe("migration 013", () => {
  it("adds city-level coordinates and one forecast row per event per day", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "db", "migrations", "013_weather.sql"),
      "utf8"
    );
    expect(sql).toContain("add column if not exists latitude double precision");
    expect(sql).toContain("add column if not exists longitude double precision");
    expect(sql).toContain("add column if not exists geocode_source text");
    expect(sql).toContain("create table if not exists event_weather");
    expect(sql).toContain("risk_flags text[] not null default '{}'");
    expect(sql).toContain("unique (event_id, fetched_on)");
  });
});

describe("geocode candidate fallbacks", () => {
  it("expands St. to Sankt and strips a leading venue word, verbatim first", async () => {
    const { geocodeCandidates } = await import("./weather");
    expect(geocodeCandidates("St. Goarshausen")).toEqual(["St. Goarshausen", "Sankt Goarshausen", "Goarshausen"]);
    expect(geocodeCandidates("Kornmarkt Bad Kreuznach")).toEqual(["Kornmarkt Bad Kreuznach", "Bad Kreuznach"]);
    expect(geocodeCandidates("Berlin")).toEqual(["Berlin"]);
    // A verbatim hit means the fallbacks are never queried; candidates are only the attempt order.
    expect(geocodeCandidates("Bad Kreuznach")).toEqual(["Bad Kreuznach", "Kreuznach"]);
  });
});
