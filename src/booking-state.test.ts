/**
 * ONE DERIVATION OF WHAT A BOOKING IS.
 *
 * The defect this closes: the private web rendered the Seefest am Demo-Ufer — ended
 * 9 August — as "LIVE · CLIENT OPERATION", pinned into the current week, five
 * weeks after it finished, because the stored row still read 'live' and the
 * page believed the row. The brief had already stopped believing it. Two
 * derivations, two answers; this is the one both now read.
 */
import { describe, expect, it } from "vitest";
import { clientBookings } from "./bookings";
import { bookingBadgeFor, bookingHoldsTruck, bookingLifecycleFor } from "./booking-state";
import type { ClientBooking } from "./types";

const AFTER_SEASON_END = new Date("2026-09-15T14:30:00+02:00");

function booking(overrides: Partial<ClientBooking>): ClientBooking {
  return {
    id: "b1",
    eventName: "Test Booking",
    city: "Hannover",
    state: "Niedersachsen",
    startsAt: "2026-08-01T10:00:00+02:00",
    endsAt: "2026-08-09T22:00:00+02:00",
    bookingState: "live",
    organizer: "Organizer",
    relationshipNote: "",
    confirmedFacts: [],
    missingOutcomeInputs: [],
    sources: [],
    ...overrides
  } as ClientBooking;
}

describe("booking lifecycle — the clock decides, not the stored row", () => {
  it("reads an elapsed 'live' booking as completed and awaiting its outcome", () => {
    const row = booking({ bookingState: "live" });
    expect(bookingLifecycleFor(row, AFTER_SEASON_END)).toBe("completed_outcome_pending");
    expect(bookingBadgeFor(bookingLifecycleFor(row, AFTER_SEASON_END))).toBe(
      "COMPLETED · OUTCOME PENDING"
    );
    expect(bookingBadgeFor(bookingLifecycleFor(row, AFTER_SEASON_END))).not.toContain("LIVE");
  });

  it("holds the truck only while the booking is live or still upcoming", () => {
    const ended = booking({});
    const running = booking({ startsAt: "2026-09-14T10:00:00+02:00", endsAt: "2026-09-20T22:00:00+02:00" });
    const upcoming = booking({ startsAt: "2026-10-01T10:00:00+02:00", endsAt: "2026-10-03T22:00:00+02:00" });
    const cancelled = booking({ bookingState: "cancelled", startsAt: "2026-10-01T10:00:00+02:00", endsAt: "2026-10-03T22:00:00+02:00" });

    expect(bookingHoldsTruck(ended, AFTER_SEASON_END)).toBe(false);
    expect(bookingLifecycleFor(running, AFTER_SEASON_END)).toBe("live");
    expect(bookingHoldsTruck(running, AFTER_SEASON_END)).toBe(true);
    expect(bookingLifecycleFor(upcoming, AFTER_SEASON_END)).toBe("upcoming");
    expect(bookingHoldsTruck(upcoming, AFTER_SEASON_END)).toBe(true);
    expect(bookingLifecycleFor(cancelled, AFTER_SEASON_END)).toBe("cancelled");
    expect(bookingHoldsTruck(cancelled, AFTER_SEASON_END)).toBe(false);
  });

  it("separates 'the booking is over' from 'we know how it went'", () => {
    const captured = booking({ outcomesRecorded: 3 });
    expect(bookingLifecycleFor(captured, AFTER_SEASON_END)).toBe("completed_outcome_recorded");
    expect(bookingLifecycleFor(booking({ outcomesRecorded: 0 }), AFTER_SEASON_END)).toBe(
      "completed_outcome_pending"
    );
  });

  it("is what the real Seefest am Demo-Ufer row derives to on the real date", () => {
    const seefest = clientBookings.find((item) => item.eventName.includes("Seefest am Demo-Ufer"))!;
    expect(bookingLifecycleFor(seefest, AFTER_SEASON_END)).toBe("completed_outcome_pending");
    expect(bookingHoldsTruck(seefest, AFTER_SEASON_END)).toBe(false);
    // During the event itself it IS live — the rule is the clock, not a blanket.
    expect(bookingLifecycleFor(seefest, new Date("2026-08-05T12:00:00+02:00"))).toBe("live");
  });
});
