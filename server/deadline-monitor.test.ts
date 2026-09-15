import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationDecision, deadlineStatusLabel } from "../src/application-intelligence";
import { mapCatalogueRows } from "./catalogue";
import {
  berlinDayKey,
  daysBetweenDayKeys,
  parseAlertThresholds,
  runDeadlineMonitorOn,
  type DeadlineQueryRunner
} from "./deadline-monitor";

/**
 * A pinned clock everywhere: nothing in this file may change its answer because
 * a day passed. 2026-10-05T09:00Z is 11:00 in Berlin, a plain CEST day.
 */
const NOW = new Date("2026-10-05T09:00:00.000Z");

interface WindowFixture {
  window_id: string;
  event_id: string;
  tenant_id: string;
  deadline_at: Date;
}

/**
 * An in-memory stand-in for the `pg` client that honours the one thing the
 * idempotence claim rests on: the unique key (event_id, threshold_days,
 * deadline_at) with `on conflict do nothing`.
 */
function fakeClient(options: {
  windows?: WindowFixture[];
  dueWindows?: number;
  evidenceRowCounts?: { published?: number; rolling?: number; notFound?: number };
}) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const alerts = new Set<string>();
  const inserted: Array<{ eventId: string; threshold: number; deadline: string }> = [];
  const client: DeadlineQueryRunner = {
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      const sql = text.toLowerCase();
      if (sql.includes("update application_windows")) {
        if (sql.includes("'published'")) return { rows: [], rowCount: options.evidenceRowCounts?.published ?? 0 };
        if (sql.includes("'none_rolling'")) return { rows: [], rowCount: options.evidenceRowCounts?.rolling ?? 0 };
        return { rows: [], rowCount: options.evidenceRowCounts?.notFound ?? 0 };
      }
      if (sql.includes("count(*)::int as due")) {
        return { rows: [{ due: options.dueWindows ?? 0 }] as never[], rowCount: 1 };
      }
      if (sql.includes("from application_windows aw")) {
        return { rows: (options.windows ?? []) as never[], rowCount: (options.windows ?? []).length };
      }
      if (sql.includes("insert into deadline_alerts")) {
        const [, eventId, , threshold, deadline] = values as [string, string, string, number, string];
        const key = `${eventId}|${threshold}|${deadline}`;
        if (alerts.has(key)) return { rows: [], rowCount: 0 };
        alerts.add(key);
        inserted.push({ eventId, threshold, deadline });
        return { rows: [{ id: `alert-${alerts.size}` }] as never[], rowCount: 1 };
      }
      throw new Error(`Unexpected statement: ${text}`);
    }
  };
  return { client, statements, inserted, alerts };
}

describe("deadline alert thresholds", () => {
  it("defaults to 30/14/7/2 when the variable is absent or blank", () => {
    expect(parseAlertThresholds(undefined)).toEqual([30, 14, 7, 2]);
    expect(parseAlertThresholds("   ")).toEqual([30, 14, 7, 2]);
  });

  it("parses, de-duplicates and orders a configured list", () => {
    expect(parseAlertThresholds("7, 30 ,7,1")).toEqual([30, 7, 1]);
  });

  it("refuses a malformed list instead of silently dropping an alert", () => {
    expect(() => parseAlertThresholds("30,soon")).toThrow(/whole positive day counts/i);
    expect(() => parseAlertThresholds("0,7")).toThrow(/between 1 and 365/i);
    expect(() => parseAlertThresholds("-4")).toThrow(/whole positive day counts/i);
  });
});

describe("Berlin calendar day maths", () => {
  it("counts calendar days, not 24-hour blocks, across a DST change", () => {
    // 2026-10-25 is the CEST → CET switch: that day is 25 hours long.
    expect(daysBetweenDayKeys("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetweenDayKeys("2026-10-26", "2026-10-24")).toBe(-2);
  });

  it("reads the Berlin day, not the UTC day, for a late-evening instant", () => {
    // 22:30 UTC on 5 October is already 00:30 on 6 October in Berlin.
    expect(berlinDayKey(new Date("2026-10-05T22:30:00.000Z"))).toBe("2026-10-06");
    expect(berlinDayKey(new Date("2026-10-05T09:00:00.000Z"))).toBe("2026-10-05");
  });
});

describe("deadline monitor pass", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records due windows without fetching anything or rescheduling the check", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("the deadline monitor must never fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { client, statements } = fakeClient({ dueWindows: 4 });

    const receipt = await runDeadlineMonitorOn(client, { now: NOW });

    expect(receipt.dueWindows).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
    // next_check_at belongs to the intelligence stage; this pass leaves it alone.
    expect(statements.some((statement) => /next_check_at\s*=/i.test(statement.text))).toBe(false);
  });

  it("keeps deadline_evidence true with one statement per transition", async () => {
    const { client, statements, } = fakeClient({
      evidenceRowCounts: { published: 3, rolling: 2, notFound: 1 }
    });
    const receipt = await runDeadlineMonitorOn(client, { now: NOW });

    expect(receipt.evidenceUpdated).toEqual({ published: 3, none_rolling: 2, not_found: 1 });
    const updates = statements
      .filter((statement) => /update application_windows/i.test(statement.text))
      .map((statement) => statement.text.replace(/\s+/g, " "));
    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain("deadline_at is not null");
    expect(updates[1]).toContain("capacity = 'rolling'");
    expect(updates[2]).toContain("capacity <> 'rolling'");
  });

  it("generates one alert per crossed threshold and nothing on a second pass", async () => {
    const windows: WindowFixture[] = [{
      window_id: "window-1",
      event_id: "event-1",
      tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
      // 13 days out in Berlin: crosses 30 and 14, not 7 or 2.
      deadline_at: new Date("2026-10-18T21:59:59.000Z")
    }];
    const { client, inserted } = fakeClient({ windows });

    const first = await runDeadlineMonitorOn(client, { now: NOW });
    expect(first.alertsCreated).toBe(2);
    expect(first.alertsByThreshold).toEqual({ "30": 1, "14": 1 });
    expect(inserted.map((row) => row.threshold)).toEqual([30, 14]);
    expect(inserted.every((row) => row.deadline === "2026-10-18")).toBe(true);

    const second = await runDeadlineMonitorOn(client, { now: NOW });
    expect(second.alertsCreated).toBe(0);
    expect(second.alertsByThreshold).toEqual({});
    expect(inserted).toHaveLength(2);
  });

  it("generates fresh alerts when the published deadline itself changes", async () => {
    const window: WindowFixture = {
      window_id: "window-1",
      event_id: "event-1",
      tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
      deadline_at: new Date("2026-10-18T21:59:59.000Z")
    };
    const harness = fakeClient({ windows: [window] });
    await runDeadlineMonitorOn(harness.client, { now: NOW });
    expect(harness.inserted).toHaveLength(2);

    // The organizer moves the deadline forward: a different date is a different
    // alert key, so the owner is told again.
    window.deadline_at = new Date("2026-10-10T21:59:59.000Z");
    const moved = await runDeadlineMonitorOn(harness.client, { now: NOW });
    expect(moved.alertsCreated).toBe(3);
    expect(moved.alertsByThreshold).toEqual({ "30": 1, "14": 1, "7": 1 });
    expect(harness.inserted.filter((row) => row.deadline === "2026-10-10")).toHaveLength(3);
  });

  it("counts a deadline in Berlin, not in UTC, on the day boundary", async () => {
    // Berlin is already 6 October; the deadline falls on 6 October in Berlin
    // too, so nothing is "tomorrow" and every threshold has been crossed.
    const lateEvening = new Date("2026-10-05T22:30:00.000Z");
    const { client, inserted } = fakeClient({
      windows: [{
        window_id: "window-1",
        event_id: "event-1",
        tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
        deadline_at: new Date("2026-10-06T08:00:00.000Z")
      }]
    });
    const receipt = await runDeadlineMonitorOn(client, { now: lateEvening });
    expect(receipt.alertsCreated).toBe(4);
    expect(inserted.map((row) => row.threshold)).toEqual([30, 14, 7, 2]);
    expect(inserted.every((row) => row.deadline === "2026-10-06")).toBe(true);
  });

  it("counts a passed deadline and refuses to alert on it", async () => {
    const { client, inserted } = fakeClient({
      windows: [{
        window_id: "window-1",
        event_id: "event-1",
        tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
        deadline_at: new Date("2026-10-04T21:59:59.000Z")
      }]
    });
    const receipt = await runDeadlineMonitorOn(client, { now: NOW });
    expect(receipt.deadlinePassedCount).toBe(1);
    expect(receipt.alertsCreated).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("honours a configured threshold list", async () => {
    const { client, inserted } = fakeClient({
      windows: [{
        window_id: "window-1",
        event_id: "event-1",
        tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
        deadline_at: new Date("2026-10-18T21:59:59.000Z")
      }]
    });
    const receipt = await runDeadlineMonitorOn(client, { now: NOW, thresholds: [60, 3] });
    expect(receipt.thresholds).toEqual([60, 3]);
    expect(inserted.map((row) => row.threshold)).toEqual([60]);
  });
});

describe("deadlineStatusLabel", () => {
  it("counts down only when a deadline is actually published", () => {
    expect(deadlineStatusLabel("published", "2026-10-18", NOW)).toBe("Deadline 18 Oct 2026 — 13 days");
    expect(deadlineStatusLabel("published", "2026-10-06", NOW)).toBe("Deadline 06 Oct 2026 — 1 day");
    expect(deadlineStatusLabel("published", "2026-10-05", NOW)).toBe("Deadline 05 Oct 2026 — today");
  });

  it("says a deadline passed instead of showing a negative countdown", () => {
    expect(deadlineStatusLabel("published", "2026-10-04", NOW)).toBe("Deadline passed");
  });

  it("keeps 'not found yet' and 'none exists' as different sentences", () => {
    expect(deadlineStatusLabel("not_found", undefined, NOW)).toBe("No deadline published — not yet found");
    expect(deadlineStatusLabel(undefined, undefined, NOW)).toBe("No deadline published — not yet found");
    expect(deadlineStatusLabel("none_rolling", undefined, NOW)).toBe("Rolling applications — no deadline exists");
  });

  it("reads the deadline in the Berlin calendar, not the UTC one", () => {
    const lateEvening = new Date("2026-10-05T22:30:00.000Z"); // 6 Oct 00:30 in Berlin
    expect(deadlineStatusLabel("published", "2026-10-06", lateEvening)).toBe("Deadline 06 Oct 2026 — today");
  });

  it("leaves the existing application decision untouched", () => {
    const event = {
      id: "event-1",
      name: "Example",
      city: "Potsdam",
      state: "Brandenburg",
      startsAt: "2026-11-01T10:00:00.000Z",
      endsAt: "2026-11-02T20:00:00.000Z",
      eventType: "city_festival",
      verification: "verified",
      applicationState: "open",
      applicationDeadline: "2026-10-18",
      infrastructure: {},
      fitSignals: [],
      riskSignals: [],
      missingFields: [],
      sources: [],
      pipeline: "watching"
    } as const;
    const decision = applicationDecision(event as never, NOW);
    expect(decision.phase).toBe("closing_soon");
    expect(decision.daysRemaining).toBe(13);
  });
});

describe("snapshot surfacing", () => {
  const profile = {
    home_region: "Brandenburg",
    home_postcode: "10115",
    normal_days: [5, 6, 0],
    optional_thursday: true,
    preferred_max_travel_minutes: 480,
    exceptional_max_travel_minutes: 600,
    menu: [],
    operating_inputs: {},
    missing_inputs: []
  };
  const event = {
    db_id: "event-db-id",
    external_id: "example-2026",
    canonical_name: "Example Event",
    city: "Potsdam",
    federal_state: "Brandenburg",
    starts_at: new Date("2026-10-20T10:00:00Z"),
    ends_at: new Date("2026-10-21T20:00:00Z"),
    event_type: "city_festival" as const,
    verification: "verified" as const,
    application_status: "open" as const,
    application_deadline: "2026-10-18",
    application_url: "https://example.com/apply",
    organizer_name: "Example Organizer",
    contact_email: null,
    contact_phone: null,
    expected_visitors: 12_000,
    pitch_fee_eur: null,
    travel_minutes: 60,
    travel_km: null,
    infrastructure: {},
    fit_signals: [],
    risk_signals: [],
    missing_fields: [],
    current_score: null,
    current_tier: null,
    score_breakdown: null,
    pipeline: "watching" as const,
    route_type: null,
    capacity: null,
    opens_at: null,
    deadline_at: null,
    expected_next_window: null,
    route_owner: null,
    window_application_url: null,
    status_note: null,
    last_checked_at: null,
    next_check_at: null,
    route_scope: null,
    route_reachable: null,
    requirements: null,
    application_source_url: null
  };
  const rest = {
    sources: [],
    eventEvidence: [],
    bookings: [],
    bookingEvidence: [],
    discovery: {
      raw_occurrences: 0,
      pending: 0,
      linked: 0,
      ignored: 0,
      rejected: 0,
      last_observed_at: null
    }
  };

  it("carries deadline evidence, weather and pending alerts additively", () => {
    const snapshot = mapCatalogueRows({
      profile,
      ...rest,
      events: [{
        ...event,
        deadline_evidence: "published",
        weather_fetched_at: new Date("2026-10-05T06:00:00Z"),
        weather_source: "open-meteo-forecast",
        weather_risk_flags: ["rain"],
        weather_forecast: { geocodePrecision: "city", summary: {
          days: 2,
          precipitationSumMaxMm: 7.2,
          precipitationProbabilityMaxPercent: 80,
          windSpeedMaxKmh: 22,
          temperatureMaxC: 17,
          temperatureMinC: 9
        } }
      }],
      deadlineAlerts: [{
        id: "alert-1",
        event_id: "event-db-id",
        event_name: "Example Event",
        city: "Potsdam",
        deadline_at: "2026-10-18",
        threshold_days: 14,
        alert_state: "pending",
        created_at: new Date("2026-10-05T06:00:00Z")
      }],
      now: NOW
    });

    expect(snapshot.events[0].deadlineEvidence).toBe("published");
    expect(snapshot.events[0].weather).toMatchObject({
      source: "open-meteo-forecast",
      riskFlags: ["rain"],
      geocodePrecision: "city"
    });
    expect(snapshot.alerts).toEqual([{
      id: "alert-1",
      eventId: "event-db-id",
      eventName: "Example Event",
      city: "Potsdam",
      deadline: "2026-10-18",
      thresholdDays: 14,
      daysRemaining: 13,
      alertState: "pending",
      createdAt: "2026-10-05T06:00:00.000Z"
    }]);
  });

  it("omits both fields entirely when nothing has been recorded", () => {
    const snapshot = mapCatalogueRows({ profile, ...rest, events: [event], now: NOW });
    expect(snapshot.events[0].deadlineEvidence).toBeUndefined();
    expect(snapshot.events[0].weather).toBeUndefined();
    expect(snapshot.alerts).toEqual([]);
  });
});

describe("migration 012", () => {
  it("constrains the three evidence states and backfills them from the rows", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "db", "migrations", "012_deadline_monitor.sql"),
      "utf8"
    );
    expect(sql).toContain("add column if not exists deadline_evidence text not null default 'not_found'");
    expect(sql).toContain("check (deadline_evidence in ('published', 'not_found', 'none_rolling'))");
    // Backfill: a stored deadline proves "published"; rolling capacity proves
    // "none exists"; everything else keeps the 'not_found' default.
    expect(sql).toMatch(/set deadline_evidence = 'published'\s+where deadline_at is not null/);
    expect(sql).toMatch(/set deadline_evidence = 'none_rolling'\s+where deadline_at is null\s+and capacity = 'rolling'/);
    expect(sql).toContain("unique (event_id, threshold_days, deadline_at)");
    expect(sql).toContain("check (alert_state in ('pending', 'surfaced'))");
  });
});
