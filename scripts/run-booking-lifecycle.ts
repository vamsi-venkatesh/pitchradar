/**
 * Runs the booking lifecycle stage on its own, with a receipt.
 *
 *   npm run bookings:lifecycle
 *
 * The stage also runs first in every operating cycle (`server/cycle.ts`); this
 * entry point exists so the correction can be applied and inspected without a
 * full collection pass, which would reach the network.
 */
import { closeDatabase } from "../server/database";
import { runBookingLifecycle } from "../server/booking-lifecycle";

try {
  const receipt = await runBookingLifecycle();
  console.log(
    `${receipt.bookingsExamined} booking(s) examined at ${receipt.checkedAt} · ` +
      `${receipt.transitions.length} transitioned to completed.`
  );
  receipt.transitions.forEach((transition) =>
    console.log(`  ${transition.eventName} — ended ${transition.endsAt} · ${transition.from} -> completed`)
  );
} finally {
  await closeDatabase();
}
