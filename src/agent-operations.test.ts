import { describe, expect, it } from "vitest";
import { buildAgentQueue } from "./agent-operations";
import { clientBookings } from "./bookings";
import { eventLeads } from "./events";
import { clientProfile } from "./profile";
import { rankOpportunities } from "./ranking";
import { sourceRegistry } from "./source-registry";

describe("agent operations queue", () => {
  // Pin to the fixtures' observation date — the live Seefest am Demo-Ufer booking ends
  // 2026-08-09 and wall-clock scoring would rot these assertions after that.
  const TEST_NOW = new Date("2026-07-27T15:00:00+02:00");
  const queue = buildAgentQueue(
    rankOpportunities(eventLeads, clientProfile, TEST_NOW),
    sourceRegistry,
    clientBookings,
    TEST_NOW
  );

  it("protects a live client booking before scouting work", () => {
    expect(queue[0].kind).toBe("protect_booking");
    expect(queue[0].relatedBookingId).toBe("client-seefest-demo-ufer-2026");
  });

  it("creates application rechecks and deadline preparation jobs", () => {
    expect(queue.some((job) => job.kind === "recheck_application")).toBe(true);
    expect(queue.some((job) => job.kind === "deadline_preparation")).toBe(true);
  });

  it("keeps every generated job internal and approval-safe", () => {
    expect(queue.every((job) => job.externalActionAllowed === false)).toBe(true);
  });

  it("turns uncovered private demand into an explicit coverage job", () => {
    expect(queue.some((job) => job.id === "gap:private_demand")).toBe(true);
  });

  it("makes an event with no application window due for a recheck now", () => {
    const now = new Date("2026-07-27T15:00:00+02:00");
    const withoutWindow = { ...eventLeads[0], id: "no-window", application: undefined };
    const jobs = buildAgentQueue([withoutWindow], [], [], now);
    const recheck = jobs.find((job) => job.kind === "recheck_application");
    expect(recheck?.id).toBe("recheck:no-window:never-checked");
    expect(recheck?.dueAt).toBe(now.toISOString());
  });

  it("makes never-checked sources due now and schedules checked sources from their receipt", () => {
    const now = new Date("2026-07-27T15:00:00+02:00");
    const sources = [
      { ...sourceRegistry[0], id: "never-checked", lastCheckedAt: undefined },
      { ...sourceRegistry[1], id: "daily-checked", cadence: "daily" as const, lastCheckedAt: "2026-07-27T10:00:00.000Z" }
    ];
    const jobs = buildAgentQueue([], sources, [], now);
    expect(jobs.find((job) => job.relatedSourceId === "never-checked")?.dueAt).toBe(now.toISOString());
    expect(jobs.find((job) => job.relatedSourceId === "daily-checked")?.dueAt).toBe("2026-07-28T10:00:00.000Z");
  });
});
