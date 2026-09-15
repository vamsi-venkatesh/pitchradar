/**
 * Runs the contact-resolution stage on its own.
 *
 *   npm run contacts:resolve -- --now=2026-09-15T16:30:00+02:00
 *
 * Bounded, read-only public GETs through the SSRF-guarded fetcher. Prints the
 * stage receipt verbatim: what was targeted, what was fetched, what was found
 * and every failure.
 */
import { closeDatabase, databaseConfigured, migrateDatabase } from "../server/database";
import { runContactResolution } from "../server/contact-resolver";

if (!databaseConfigured()) {
  throw new Error("PITCHRADAR_DATABASE_URL is required for contact resolution.");
}

const nowArg = process.argv.slice(2).find((arg) => arg.startsWith("--now="))?.slice("--now=".length);
const now = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(now.getTime())) {
  throw new Error(`--now is not a valid ISO timestamp: ${nowArg}`);
}

try {
  await migrateDatabase();
  const result = await runContactResolution(now);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDatabase();
}
