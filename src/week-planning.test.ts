import { describe, expect, it } from "vitest";
import { eventLeads } from "./events";
import { clientBookings } from "./bookings";
import { clientProfile } from "./profile";
import { rankOpportunities } from "./ranking";
import { groupByCalendarWeek } from "./week-planning";

// Pin scoring to the fixtures' observation date — fixture events carry fixed 2026
// dates and wall-clock scoring rots as real time passes them.
const TEST_NOW = new Date("2026-07-27T09:00:00+02:00");

describe("weekly booking portfolio", () => {
  const weeks = groupByCalendarWeek(rankOpportunities(eventLeads, clientProfile, TEST_NOW), clientBookings);

  it("keeps every known event and repeats multi-week events in every occupied week", () => {
    const uniqueEventIds = new Set(
      weeks.flatMap((week) => week.events.map((item) => item.event.id))
    );
    expect(uniqueEventIds.size).toBe(eventLeads.length);
    expect(weeks.reduce((count, week) => count + week.events.length, 0)).toBeGreaterThan(eventLeads.length);
  });

  it("places the live Seefest am Demo-Ufer booking in all three calendar weeks it occupies", () => {
    const occupiedWeeks = weeks.filter((week) =>
      week.bookings.some((booking) => booking.id === "client-seefest-demo-ufer-2026")
    );
    expect(occupiedWeeks.map((week) => week.weekNumber)).toEqual([30, 31, 32]);
  });

  it("blocks prospect recommendations that conflict with a confirmed booking", () => {
    const hockenheimWeek = weeks.find((week) =>
      week.events.some((item) => item.event.id === "hockenheim-street-food-2026")
    )!;
    const hockenheim = hockenheimWeek.events.find(
      (item) => item.event.id === "hockenheim-street-food-2026"
    )!;
    expect(hockenheim.role).toBe("Blocked");
    expect(hockenheimWeek.recommendation).toMatch(/Protect the confirmed booking/);
  });

  it("recommends multiple attempts when a week has alternatives", () => {
    const prospectOnlyWeeks = groupByCalendarWeek(rankOpportunities(eventLeads, clientProfile, TEST_NOW));
    const firstAugust = prospectOnlyWeeks.find((week) =>
      week.events.some((item) => item.event.id === "muellroser-seezauber-2026")
    )!;
    expect(firstAugust.events).toHaveLength(2);
    expect(firstAugust.events.map((item) => item.role)).toEqual(["Primary", "Backup"]);
    expect(firstAugust.recommendation).toMatch(/Primary and Backup/);
  });
});
