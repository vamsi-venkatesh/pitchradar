/**
 * KPI PARITY — the command centre and the brief are the same arithmetic.
 *
 * The private web used to derive its own hero numbers beside the report's, and
 * an owner had no way to tell which of the two was the product. The snapshot
 * API now carries the report's OWN derivations, so this suite pins the only
 * thing that matters: what the web is handed is, field for field, what the
 * brief printed for the same snapshot and the same clock.
 */
import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot } from "./catalogue";
import { buildBriefingView, buildKpis, buildWeeklyReport } from "./report";

const NOW = new Date("2026-07-27T09:00:00+02:00");
const BRIEFING_CLOCK = new Date("2026-09-15T14:30:00+02:00");

describe("the briefing view — one derivation, two surfaces", () => {
  it("hands the web the brief's own KPI numbers, field for field", () => {
    const snapshot = fixtureProductSnapshot();
    const report = buildWeeklyReport(snapshot, NOW);
    const briefing = buildBriefingView(snapshot, NOW);

    expect(briefing.kpis).toEqual(report.kpis);
    expect(buildKpis(snapshot, NOW)).toEqual(report.kpis);
    expect(briefing.summarySentence).toBe(report.summarySentence);
    expect(briefing.kpis.actionNow).toBe(report.actionQueue.length);
    expect(briefing.kpis.actionNowEvents).toBe(report.actionNow.length);
  });

  it("carries the pipeline counts, the deadline radar and the tasks the brief carries", () => {
    const snapshot = fixtureProductSnapshot();
    const report = buildWeeklyReport(snapshot, NOW);
    const briefing = buildBriefingView(snapshot, NOW);

    expect(briefing.pipelineCounts).toEqual(report.pipelineCounts);
    expect(briefing.deadlineRadar).toEqual(report.deadlineRadar.slice(0, 5));
    expect(briefing.deadlineRadar.length).toBeLessThanOrEqual(5);
    expect(briefing.actionQueue.map((task) => task.key)).toEqual(
      report.actionQueue.map((task) => task.key)
    );
  });

  it("gives the web the booking LIFECYCLE, so no ended booking can render as live", () => {
    const briefing = buildBriefingView(fixtureProductSnapshot(), BRIEFING_CLOCK);
    const seefest = briefing.bookings.find((row) => row.eventName.includes("Seefest am Demo-Ufer"))!;

    expect(seefest.lifecycle).toBe("completed_outcome_pending");
    expect(seefest.blockedWeeks).toEqual([]);
    expect(briefing.kpis.currentBookings).toBe(
      briefing.bookings.filter((row) => row.lifecycle === "live" || row.lifecycle === "upcoming").length
    );
  });

  it("resolves one contact, the open questions and the next action per organizer", () => {
    const snapshot = fixtureProductSnapshot();
    const report = buildWeeklyReport(snapshot, NOW);
    const briefing = buildBriefingView(snapshot, NOW);

    expect(briefing.organizers.length).toBeGreaterThan(0);
    // Every organizer row is an organizer the register actually names.
    const named = new Set(report.register.map((event) => event.organizer).filter(Boolean));
    briefing.organizers.forEach((row) => expect(named.has(row.name)).toBe(true));
    // Every task's organizer carries that task's ask, and no other row invents one.
    const tasks = new Map(report.actionQueue.map((task) => [task.organizerName, task.nextAction]));
    briefing.organizers.forEach((row) => {
      expect(row.nextAction).toBe(tasks.get(row.name) ?? "—");
      expect(row.openQuestions).toBeGreaterThanOrEqual(0);
    });
    // Counts are the register's, not a page's idea of them.
    briefing.organizers.forEach((row) => {
      expect(row.eventCount).toBe(
        report.register.filter((event) => event.organizer === row.name).length
      );
    });
  });

  it("is deterministic: the same snapshot and the same clock give the same view", () => {
    const snapshot = fixtureProductSnapshot();
    expect(JSON.stringify(buildBriefingView(snapshot, NOW))).toBe(
      JSON.stringify(buildBriefingView(snapshot, NOW))
    );
  });
});
