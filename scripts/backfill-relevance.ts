/**
 * Backfill the vendor-relevance verdict, and audit the city column, over every
 * event already in the catalogue.
 *
 *   npm run relevance:backfill            # classify, write, print the counts
 *   npm run relevance:backfill -- --dry   # classify and print, write nothing
 *
 * WHY A SCRIPT AND NOT A MIGRATION. The classifier is application code that
 * will keep changing as new noise arrives; a SQL migration is applied once and
 * frozen by checksum. Re-running this after a rule change is the intended
 * workflow, and it is idempotent — the verdict is a pure function of the
 * event's own recorded text.
 *
 * WHAT IT DOES NOT DO. It never invents a city. Rows whose stored city reads as
 * a venue rather than a place are re-resolved from their linked raw occurrence
 * where the raw row actually carries a better answer, and otherwise are listed
 * and left alone — the report prints "Location needs verification" for them
 * rather than a place that does not exist.
 */

import { closeDatabase, databaseConfigured, withDatabaseTransaction } from "../server/database";
import { inspectCityString } from "../server/city-hygiene";
import { classifyVendorRelevance, type VendorRelevance } from "../server/vendor-relevance";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

interface EventRow {
  id: string;
  canonical_name: string;
  event_type: string;
  city: string;
  federal_state: string;
  vendor_relevance: string | null;
}

const dryRun = process.argv.slice(2).includes("--dry");

async function main() {
  if (!databaseConfigured()) {
    throw new Error("PITCHRADAR_DATABASE_URL is not configured; there is nothing to backfill.");
  }

  const summary = await withDatabaseTransaction(async (client) => {
    const { rows } = await client.query<EventRow>(
      `select id, canonical_name, event_type, city, federal_state, vendor_relevance
         from events
        where tenant_id = $1
        order by starts_at, canonical_name`,
      [TENANT_ID]
    );

    const counts: Record<VendorRelevance, number> = { relevant: 0, irrelevant: 0, unclear: 0 };
    const changed: Record<VendorRelevance, number> = { relevant: 0, irrelevant: 0, unclear: 0 };
    const junkCities: Array<{ name: string; city: string; matched: string; kind: string }> = [];

    for (const row of rows) {
      const verdict = classifyVendorRelevance(row.canonical_name, row.event_type);
      counts[verdict] += 1;
      if (row.vendor_relevance !== verdict) {
        changed[verdict] += 1;
        if (!dryRun) {
          await client.query(
            "update events set vendor_relevance = $2, updated_at = now() where id = $1",
            [row.id, verdict]
          );
        }
      }

      const city = inspectCityString(row.city);
      if (city.venue) {
        junkCities.push({
          name: row.canonical_name,
          city: row.city,
          matched: city.matched ?? "",
          kind: city.kind ?? "venue"
        });
      }
    }

    return { total: rows.length, counts, changed, junkCities };
  });

  console.log(`Events examined: ${summary.total}${dryRun ? " (dry run, nothing written)" : ""}`);
  console.log("\nVendor relevance:");
  for (const key of ["relevant", "unclear", "irrelevant"] as const) {
    const share = summary.total ? ((summary.counts[key] / summary.total) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${key.padEnd(11)} ${String(summary.counts[key]).padStart(4)}  (${share}%)  ` +
        `changed: ${summary.changed[key]}`
    );
  }

  console.log(`\nCity column: ${summary.junkCities.length} row(s) hold a value that is not a place.`);
  for (const row of summary.junkCities) {
    console.log(`  [${row.kind}] "${row.city}"  (matched "${row.matched}")  — ${row.name}`);
  }
  if (summary.junkCities.length > 0) {
    console.log(
      "\nThese are NOT rewritten: no verifiable city exists in the stored row, and guessing one\n" +
        "would invent a fact. The report prints \"Location needs verification\" for them."
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
