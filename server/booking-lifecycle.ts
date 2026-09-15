/**
 * BOOKING LIFECYCLE — a booking that has ended is not a live booking.
 *
 * Symptom (pitchradar_dev, found 2026-09-15): the client booking "Seefest am
 * Demo-Ufer" ended 2026-08-09 and still carried `state = 'live'`. It rendered in
 * the weekly report under "Live bookings", and — worse — every week it touched
 * was still marked Blocked, so the report kept recommending against work in
 * weeks the truck was already free.
 *
 * Root cause: nothing ever transitioned a booking. `client_bookings.state` was
 * only ever written by the owner at intake; no stage read the clock against
 * `ends_at`.
 *
 * Fix: this stage, at the data layer, where the fact lives — not in the
 * renderer, which would leave the database wrong for every other reader. A
 * booking whose `ends_at` is in the past and whose state is still 'live' or
 * 'confirmed' becomes 'completed'. 'cancelled' is never touched: a cancelled
 * booking did not happen, so it cannot have completed.
 *
 * The enum already carries 'completed' (migration 001), so no migration is
 * needed — verified against the live type before this stage was written.
 *
 * What COMPLETED does NOT mean: it does not mean the outcome is known. The
 * report derives "Completed — outcome pending" from the absence of a
 * `booking_outcomes` row, and keeps asking for the numbers that are still
 * wanted. Transitioning the state is not the same as closing the loop.
 */

import { databaseConfigured, withDatabaseTransaction } from "./database";
import type { BookingState } from "../src/types";

/** The states a completed booking can be reached from. */
export const COMPLETABLE_STATES: BookingState[] = ["live", "confirmed"];

export interface BookingLifecycleRow {
  id: string;
  event_name: string;
  ends_at: string | Date;
  state: BookingState;
}

export interface BookingTransition {
  id: string;
  eventName: string;
  endsAt: string;
  from: BookingState;
  to: "completed";
}

export interface BookingLifecycleReceipt {
  checkedAt: string;
  bookingsExamined: number;
  transitions: BookingTransition[];
}

/**
 * The rule, pure and clock-injected so the suite can pin every boundary. A
 * booking that ends today has NOT ended: the comparison is against the recorded
 * end instant, and a booking is only completed once that instant has passed.
 */
export function bookingsToComplete(
  rows: BookingLifecycleRow[],
  now: Date
): BookingTransition[] {
  return rows
    .filter((row) => COMPLETABLE_STATES.includes(row.state))
    .filter((row) => new Date(row.ends_at).getTime() < now.getTime())
    .map((row) => ({
      id: row.id,
      eventName: row.event_name,
      endsAt: new Date(row.ends_at).toISOString(),
      from: row.state,
      to: "completed" as const
    }))
    .sort((a, b) => a.endsAt.localeCompare(b.endsAt) || a.id.localeCompare(b.id));
}

/**
 * Applies the rule to the operating database and returns a receipt naming every
 * booking it moved. Writing nothing is a normal, reported outcome — an empty
 * transition list is the honest answer on a database with no elapsed booking.
 */
export async function runBookingLifecycle(now = new Date()): Promise<BookingLifecycleReceipt> {
  if (!databaseConfigured()) {
    throw new Error("PITCHRADAR_DATABASE_URL is required for the booking lifecycle stage.");
  }
  return withDatabaseTransaction(async (client) => {
    const rows = await client.query<BookingLifecycleRow>(
      `select id, event_name, ends_at, state from client_bookings order by ends_at, id`
    );
    const transitions = bookingsToComplete(rows.rows, now);
    for (const transition of transitions) {
      await client.query(
        `update client_bookings set state = 'completed', updated_at = now() where id = $1`,
        [transition.id]
      );
    }
    return {
      checkedAt: now.toISOString(),
      bookingsExamined: rows.rowCount ?? 0,
      transitions
    };
  });
}
