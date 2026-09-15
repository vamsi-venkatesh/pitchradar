/**
 * WHAT A BOOKING IS, ON ONE CLOCK.
 *
 * The stored `bookingState` is the starting point, not the answer: a booking
 * that ended weeks ago and still reads 'live' is a row nobody transitioned, and
 * repeating it is how the product told the owner the truck was committed to an
 * event that finished in August.
 *
 * Every surface — the brief, the command centre, the week chips, the drawer —
 * reads THIS derivation. Two independent derivations are two answers, and the
 * web has been showing the wrong one.
 */
import type { ClientBooking } from "./types";

export type BookingLifecycle =
  | "upcoming"
  | "live"
  | "completed_outcome_pending"
  | "completed_outcome_recorded"
  | "cancelled";

export function bookingLifecycleFor(
  booking: Pick<ClientBooking, "bookingState" | "startsAt" | "endsAt" | "outcomesRecorded">,
  now: Date
): BookingLifecycle {
  if (booking.bookingState === "cancelled") return "cancelled";
  const ended = new Date(booking.endsAt).getTime() < now.getTime();
  if (ended || booking.bookingState === "completed") {
    return (booking.outcomesRecorded ?? 0) > 0
      ? "completed_outcome_recorded"
      : "completed_outcome_pending";
  }
  return new Date(booking.startsAt).getTime() <= now.getTime() ? "live" : "upcoming";
}

/**
 * True only while the booking still commits the truck. A completed or cancelled
 * booking holds nothing — and must not block a week the truck is free for, nor
 * occupy the current-week hero.
 */
export function bookingHoldsTruck(
  booking: Pick<ClientBooking, "bookingState" | "startsAt" | "endsAt" | "outcomesRecorded">,
  now: Date
): boolean {
  const lifecycle = bookingLifecycleFor(booking, now);
  return lifecycle === "live" || lifecycle === "upcoming";
}

/** The short badge every surface prints. Owner vocabulary, never free-written. */
export function bookingBadgeFor(lifecycle: BookingLifecycle): string {
  switch (lifecycle) {
    case "live":
      return "LIVE · CLIENT OPERATION";
    case "upcoming":
      return "CONFIRMED · UPCOMING";
    case "completed_outcome_pending":
      return "COMPLETED · OUTCOME PENDING";
    case "completed_outcome_recorded":
      return "COMPLETED · OUTCOME RECORDED";
    case "cancelled":
      return "CANCELLED";
  }
}
