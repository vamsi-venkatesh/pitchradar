import { tradingDays } from "./ranking";
import type { ClientBooking, EventOpportunity } from "./types";

export type WeeklyRole = "Primary" | "Backup" | "Verify first" | "Blocked" | "Closed";

export interface WeeklyOpportunity {
  event: EventOpportunity;
  role: WeeklyRole;
  tradingDays: number;
}

export interface EventWeek {
  key: string;
  weekNumber: number;
  startsAt: Date;
  endsAt: Date;
  bookings: ClientBooking[];
  events: WeeklyOpportunity[];
  activeCount: number;
  possibleTradingDays: number;
  recommendation: string;
  hasOverlap: boolean;
}

const MS_DAY = 86_400_000;

function isoWeek(date: Date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((utc.getTime() - yearStart.getTime()) / MS_DAY) + 1) / 7);
  return { year: utc.getUTCFullYear(), weekNumber };
}

function mondayFor(date: Date) {
  const value = new Date(date);
  const day = value.getDay() || 7;
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() - day + 1);
  return value;
}

function sundayFor(monday: Date) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

function weekKey(monday: Date) {
  const iso = isoWeek(monday);
  return `${iso.year}-W${String(iso.weekNumber).padStart(2, "0")}`;
}

function weekStartsInRange(startsAt: string, endsAt: string): Date[] {
  const starts = mondayFor(new Date(startsAt));
  const ends = new Date(endsAt);
  const weeks: Date[] = [];
  for (const cursor = new Date(starts); cursor <= ends; cursor.setDate(cursor.getDate() + 7)) {
    weeks.push(new Date(cursor));
  }
  return weeks;
}

function rangesOverlap(
  a: Pick<EventOpportunity | ClientBooking, "startsAt" | "endsAt">,
  b: Pick<EventOpportunity | ClientBooking, "startsAt" | "endsAt">
) {
  return new Date(a.startsAt) <= new Date(b.endsAt) && new Date(b.startsAt) <= new Date(a.endsAt);
}

function daysInsideWeek(event: EventOpportunity, monday: Date): number {
  const start = new Date(Math.max(new Date(event.startsAt).getTime(), monday.getTime()));
  const end = new Date(Math.min(new Date(event.endsAt).getTime(), sundayFor(monday).getTime()));
  return tradingDays({ startsAt: start.toISOString(), endsAt: end.toISOString() });
}

export function groupByCalendarWeek(
  events: EventOpportunity[],
  bookings: ClientBooking[] = []
): EventWeek[] {
  const groups = new Map<string, { monday: Date; events: EventOpportunity[]; bookings: ClientBooking[] }>();

  function groupFor(monday: Date) {
    const key = weekKey(monday);
    const current = groups.get(key) ?? { monday, events: [], bookings: [] };
    groups.set(key, current);
    return current;
  }

  events.forEach((event) => {
    weekStartsInRange(event.startsAt, event.endsAt).forEach((monday) => groupFor(monday).events.push(event));
  });

  bookings.forEach((booking) => {
    weekStartsInRange(booking.startsAt, booking.endsAt).forEach((monday) => groupFor(monday).bookings.push(booking));
  });

  return [...groups.entries()]
    .map(([key, group]) => {
      const sorted = [...group.events].sort((a, b) => {
        if (a.tier === "REJECTED" && b.tier !== "REJECTED") return 1;
        if (b.tier === "REJECTED" && a.tier !== "REJECTED") return -1;
        return (b.score ?? 0) - (a.score ?? 0);
      });
      let actionableIndex = 0;
      const weeklyEvents = sorted.map((event): WeeklyOpportunity => {
        if (event.tier === "REJECTED") {
          return { event, role: "Closed", tradingDays: daysInsideWeek(event, group.monday) };
        }
        if (group.bookings.some((booking) => rangesOverlap(event, booking))) {
          return { event, role: "Blocked", tradingDays: daysInsideWeek(event, group.monday) };
        }
        const role: WeeklyRole =
          actionableIndex === 0 ? "Primary" : actionableIndex === 1 ? "Backup" : "Verify first";
        actionableIndex += 1;
        return { event, role, tradingDays: daysInsideWeek(event, group.monday) };
      });
      const active = weeklyEvents.filter((item) => !["Closed", "Blocked"].includes(item.role));
      const hasOverlap =
        group.bookings.length > 0 ||
        active.some((item, index) =>
          active.slice(index + 1).some((other) => rangesOverlap(item.event, other.event))
        );

      return {
        key,
        weekNumber: Number(key.slice(-2)),
        startsAt: group.monday,
        endsAt: sundayFor(group.monday),
        bookings: group.bookings,
        events: weeklyEvents,
        activeCount: active.length,
        possibleTradingDays: active.reduce((total, item) => total + item.tradingDays, 0),
        recommendation:
          group.bookings.length > 0
            ? "Protect the confirmed booking. Research future weeks, but do not recommend conflicting work."
            : active.length >= 2
              ? "Verify the Primary and Backup in parallel before the best application window closes."
              : active.length === 1
                ? "Advance the Primary and keep searching hidden sources for another option."
                : "No actionable event remains; deepen the city and organizer search for this week.",
        hasOverlap
      };
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
