/**
 * The booking lifecycle rule. Clock-injected and database-free: every boundary
 * is pinned against a constructed set of rows, so the assertions cannot rot
 * into a different answer next month.
 *
 * The case that produced this stage is here verbatim: "Seefest am Demo-Ufer",
 * ends_at 2026-08-09, still `state = 'live'` in pitchradar_dev on 2026-09-15.
 */
import { describe, expect, it } from "vitest";
import { bookingsToComplete, COMPLETABLE_STATES, type BookingLifecycleRow } from "./booking-lifecycle";

const NOW = new Date("2026-09-15T14:30:00+02:00");

function booking(overrides: Partial<BookingLifecycleRow> & { id: string }): BookingLifecycleRow {
  return {
    event_name: "Some Booking",
    ends_at: "2026-08-09T23:59:00+02:00",
    state: "live",
    ...overrides
  };
}

describe("booking lifecycle — an elapsed booking is not a live booking", () => {
  it("completes the real Seefest am Demo-Ufer row that was still marked live", () => {
    const transitions = bookingsToComplete(
      [booking({ id: "seefest-demo-ufer", event_name: "Seefest am Demo-Ufer" })],
      NOW
    );
    expect(transitions).toEqual([
      {
        id: "seefest-demo-ufer",
        eventName: "Seefest am Demo-Ufer",
        endsAt: new Date("2026-08-09T23:59:00+02:00").toISOString(),
        from: "live",
        to: "completed"
      }
    ]);
  });

  it("completes a confirmed booking as well as a live one", () => {
    const transitions = bookingsToComplete(
      [
        booking({ id: "live-one", state: "live" }),
        booking({ id: "confirmed-one", state: "confirmed" })
      ],
      NOW
    );
    expect(transitions.map((item) => item.from).sort()).toEqual(["confirmed", "live"]);
    expect(COMPLETABLE_STATES).toEqual(["live", "confirmed"]);
  });

  it("never touches a cancelled booking — it did not happen, so it cannot have completed", () => {
    expect(bookingsToComplete([booking({ id: "cancelled", state: "cancelled" })], NOW)).toEqual([]);
  });

  it("never re-touches a booking that is already completed", () => {
    expect(bookingsToComplete([booking({ id: "done", state: "completed" })], NOW)).toEqual([]);
  });

  it("leaves a booking that has not ended yet alone, including one ending later today", () => {
    const stillRunning = bookingsToComplete(
      [
        booking({ id: "future", ends_at: "2026-10-01T18:00:00+02:00" }),
        booking({ id: "later-today", ends_at: "2026-09-15T23:59:00+02:00" })
      ],
      NOW
    );
    expect(stillRunning).toEqual([]);
  });

  it("completes a booking the instant its recorded end has passed, and not before", () => {
    const endsAt = "2026-09-15T14:30:00+02:00";
    expect(bookingsToComplete([booking({ id: "edge", ends_at: endsAt })], NOW)).toEqual([]);
    const oneSecondLater = new Date(NOW.getTime() + 1000);
    expect(bookingsToComplete([booking({ id: "edge", ends_at: endsAt })], oneSecondLater)).toHaveLength(
      1
    );
  });

  it("is deterministic — the same rows in any order produce the same receipt", () => {
    const rows = [
      booking({ id: "b", ends_at: "2026-08-20T20:00:00+02:00" }),
      booking({ id: "a", ends_at: "2026-08-09T23:59:00+02:00" })
    ];
    const forward = bookingsToComplete(rows, NOW).map((item) => item.id);
    const backward = bookingsToComplete([...rows].reverse(), NOW).map((item) => item.id);
    expect(forward).toEqual(["a", "b"]);
    expect(backward).toEqual(forward);
  });
});
