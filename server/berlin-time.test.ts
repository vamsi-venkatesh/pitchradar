import { describe, expect, it } from "vitest";
import { berlinDate, berlinYearMonth, daysInMonth } from "./berlin-time";

describe("Europe/Berlin calendar helpers", () => {
  it("uses CET (+01:00) for winter dates, not a hardcoded summer offset", () => {
    expect(berlinDate("2026-12-15").toISOString()).toBe("2026-12-14T23:00:00.000Z");
    expect(berlinDate("2026-12-15", 23, 59, 59).toISOString()).toBe("2026-12-15T22:59:59.000Z");
  });

  it("uses CEST (+02:00) for summer dates", () => {
    expect(berlinDate("2026-07-15").toISOString()).toBe("2026-07-14T22:00:00.000Z");
    expect(berlinDate("2026-07-15", 23, 59, 59).toISOString()).toBe("2026-07-15T21:59:59.000Z");
  });

  it("keeps a late-evening winter event inside its Berlin calendar day", () => {
    // 22:30 Berlin time on Dec 15 = 21:30Z; the old +02:00 rangeEnd (21:59:59Z)
    // barely kept it, but 23:30 Berlin (22:30Z) fell outside. The CET-correct
    // day end (22:59:59Z) contains both.
    const lateEvent = new Date("2026-12-15T22:30:00.000Z"); // 23:30 Berlin
    expect(lateEvent.getTime()).toBeLessThanOrEqual(berlinDate("2026-12-15", 23, 59, 59).getTime());
  });

  it("assigns instants to their Berlin month, not the UTC month", () => {
    // 23:30Z on Dec 31 is already 00:30 on Jan 1 in Berlin.
    expect(berlinYearMonth(new Date("2026-12-31T23:30:00.000Z"))).toEqual({ year: 2027, month: 1 });
    // 22:30Z on Jul 31 is already 00:30 on Aug 1 in Berlin (CEST).
    expect(berlinYearMonth(new Date("2026-07-31T22:30:00.000Z"))).toEqual({ year: 2026, month: 8 });
  });

  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});
