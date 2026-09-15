/**
 * PitchRadar — deterministic duplicate re-merge pass.
 *
 *   npm run dedup:merge -- [--apply]
 *
 * The normalizer merges at write time, on the name confidence rule in
 * `server/normalizer.ts`. When that rule is CORRECTED, rows that were written
 * under the old rule stay split — the normalizer never revisits an event it has
 * already created. This script is the catch-up pass: it re-applies the CURRENT
 * rule to the rows already in the database and merges the pairs the corrected
 * rule now matches.
 *
 * The rule, unchanged from the normalizer:
 *   same tenant + same city (case-insensitive) + overlapping dates
 *   + nameMatchConfidence >= 0.65
 *
 * Direction is deterministic: the NEWER event (later created_at, ties broken by
 * id) is merged into the OLDER one. Evidence is never deleted — it moves:
 * source links, evidence rows, the application window (the richer of the two)
 * and weather rows are re-pointed at the keeper before the duplicate row is
 * removed. Every merge prints a receipt naming exactly what moved.
 *
 * Default is a DRY RUN. Nothing is written without `--apply`.
 */

import "dotenv/config";
import path from "node:path";
import type { PoolClient } from "pg";
import { databaseConfigured, withDatabaseTransaction } from "../server/database";
import { nameMatchConfidence } from "../server/normalizer";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";
export const MERGE_THRESHOLD = 0.65;

interface EventRow {
  id: string;
  external_id: string;
  canonical_name: string;
  city: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export interface MergePair {
  keeper: EventRow;
  duplicate: EventRow;
  confidence: number;
}

export interface HeldPair {
  left: EventRow;
  right: EventRow;
  confidence: number;
  reason: string;
}

/**
 * The registered source an event was discovered from, read off its external_id
 * (`discovery:<source-id>:<hash>`). A seeded row has no discovery prefix and is
 * reported as its own origin, which can never collide with a discovery source.
 */
export function discoverySourceOf(event: Pick<EventRow, "external_id">): string {
  const match = /^discovery:([^:]+):/.exec(event.external_id);
  return match ? match[1] : `seed:${event.external_id}`;
}

/**
 * ONE PUBLISHER, TWO LISTINGS = TWO EVENTS.
 *
 * A single registered source does not publish the same event twice under two
 * different head nouns. When it lists both, they are two real events that share
 * a venue and a day — Leipzig's "Kreativmarkt an der Festwiese / Jahnallee" and
 * "Toepfermarkt an der Festwiese / Jahnallee" on 2026-09-27 are exactly that,
 * and the token rule scores them 0.6667 purely on the shared venue words.
 *
 * Cross-source duplication is the failure this pass exists to repair;
 * same-source pairs are held back and reported instead of merged, because
 * merging them would DELETE an opportunity rather than consolidate one.
 */
export function sameSourcePublishedBoth(a: EventRow, b: EventRow): boolean {
  return discoverySourceOf(a) === discoverySourceOf(b);
}

/**
 * Same city (case-insensitive) and overlapping dates. Date overlap — not an
 * identical start day — because a two-source duplicate often differs by a day
 * at one end; the name confidence is what decides identity.
 */
function overlaps(a: EventRow, b: EventRow): boolean {
  return (
    new Date(a.starts_at) <= new Date(b.ends_at) && new Date(b.starts_at) <= new Date(a.ends_at)
  );
}

/**
 * Which of two rows is the keeper: the one created first. A stable tiebreak on
 * id means the same database always produces the same merge direction.
 */
function olderFirst(a: EventRow, b: EventRow): [EventRow, EventRow] {
  const left = new Date(a.created_at).getTime();
  const right = new Date(b.created_at).getTime();
  if (left !== right) return left < right ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/**
 * Every pair the CURRENT rule matches, as the merge direction to apply. Pure
 * and exported so the regression suite can drive it on constructed rows without
 * a database.
 */
export function mergePairsFor(events: EventRow[]): { merge: MergePair[]; held: HeldPair[] } {
  const merge: MergePair[] = [];
  const held: HeldPair[] = [];
  const sorted = [...events].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.city.toLowerCase() !== b.city.toLowerCase()) continue;
      if (!overlaps(a, b)) continue;
      const confidence = nameMatchConfidence(a.canonical_name, b.canonical_name);
      if (confidence < MERGE_THRESHOLD) continue;
      const [keeper, duplicate] = olderFirst(a, b);
      if (sameSourcePublishedBoth(a, b)) {
        held.push({
          left: keeper,
          right: duplicate,
          confidence,
          reason: `both listed separately by ${discoverySourceOf(a)} — two events at one venue, not one event twice`
        });
        continue;
      }
      merge.push({ keeper, duplicate, confidence });
    }
  }
  // Deterministic order: oldest keeper first, then the duplicate's id.
  merge.sort(
    (x, y) =>
      new Date(x.keeper.created_at).getTime() - new Date(y.keeper.created_at).getTime() ||
      x.duplicate.id.localeCompare(y.duplicate.id)
  );
  held.sort((x, y) => x.left.id.localeCompare(y.left.id) || x.right.id.localeCompare(y.right.id));
  return { merge, held };
}

/**
 * How much an application_windows row actually carries. Used to choose between
 * the keeper's window and the duplicate's — one per event is allowed, so the
 * poorer of the two is dropped rather than both being kept.
 */
interface WindowRow {
  id: string;
  event_id: string;
  route_type: string;
  capacity: string;
  opens_at: string | null;
  deadline_at: string | null;
  route_owner: string | null;
  application_url: string | null;
  source_url: string | null;
  route_reachable: boolean | null;
  requirements: string[];
  deadline_evidence: string;
}

export function windowRichness(row: WindowRow): number {
  let score = 0;
  if (row.deadline_at) score += 3;
  if (row.deadline_evidence !== "not_found") score += 2;
  if (row.application_url) score += 2;
  if (row.route_owner) score += 2;
  if (row.source_url) score += 1;
  if (row.opens_at) score += 1;
  if (row.route_type !== "unknown") score += 1;
  if (row.capacity !== "unknown") score += 1;
  if (row.route_reachable !== null) score += 1;
  if ((row.requirements ?? []).length) score += 1;
  return score;
}

interface MergeReceipt {
  keeperId: string;
  keeperName: string;
  duplicateId: string;
  duplicateName: string;
  city: string;
  confidence: number;
  sourceLinksMoved: number;
  evidenceMoved: number;
  evidenceAlreadyPresent: number;
  weatherMoved: number;
  weatherAlreadyPresent: number;
  applicationWindow: "kept_keeper" | "took_duplicate" | "moved_duplicate" | "none";
  otherReferencesMoved: Record<string, number>;
}

/**
 * Every other table that points at an event, with the columns its own unique
 * key is built from. A row is re-pointed at the keeper unless the keeper
 * already carries a row with the same key — in which case the keeper already
 * records that exact fact and the duplicate's copy is not a second fact. The
 * keys are read off the live constraints, never guessed: a missing one would
 * abort the whole transaction rather than lose a row silently.
 */
const REFERENCE_TABLES: Array<{ table: string; key: string[] }> = [
  { table: "event_actions", key: [] },
  { table: "event_selections", key: ["tenant_id"] },
  { table: "event_outcomes", key: [] },
  { table: "application_window_checks", key: ["source_url", "source_hash"] },
  { table: "availability_verification_requests", key: ["tenant_id", "week_key"] },
  { table: "deadline_alerts", key: ["threshold_days", "deadline_at"] },
  { table: "client_bookings", key: [] }
];

async function mergeOne(
  client: PoolClient,
  pair: MergePair
): Promise<MergeReceipt> {
  const { keeper, duplicate } = pair;

  // 1. Source links. The PK is (raw_occurrence_id, event_id), so a link the
  //    keeper already holds is simply dropped rather than duplicated.
  const links = await client.query(
    `with moved as (
       update event_source_links l
       set event_id = $1
       where l.event_id = $2
         and not exists (
           select 1 from event_source_links k
           where k.event_id = $1 and k.raw_occurrence_id = l.raw_occurrence_id
         )
       returning 1
     ) select count(*)::int as moved from moved`,
    [keeper.id, duplicate.id]
  );
  const leftoverLinks = await client.query(
    `delete from event_source_links where event_id = $1 returning 1`,
    [duplicate.id]
  );

  // 2. Evidence. A duplicate content_hash on the keeper would violate the
  //    partial unique index, so an evidence record the keeper already holds is
  //    counted as already-present rather than moved. Nothing is lost: the fact
  //    it records is on the keeper.
  const evidence = await client.query(
    `with moved as (
       update event_evidence e
       set event_id = $1
       where e.event_id = $2
         and (
           e.content_hash is null
           or not exists (
             select 1 from event_evidence k
             where k.event_id = $1 and k.content_hash = e.content_hash
           )
         )
       returning 1
     ) select count(*)::int as moved from moved`,
    [keeper.id, duplicate.id]
  );
  const evidenceLeft = await client.query<{ id: string }>(
    `select id from event_evidence where event_id = $1`,
    [duplicate.id]
  );

  // 3. The application window — one per event. The richer of the two survives.
  const windows = await client.query<WindowRow>(
    `select id, event_id, route_type, capacity::text as capacity, opens_at, deadline_at,
       route_owner, application_url, source_url, route_reachable, requirements, deadline_evidence
     from application_windows where event_id in ($1, $2)`,
    [keeper.id, duplicate.id]
  );
  const keeperWindow = windows.rows.find((row) => row.event_id === keeper.id);
  const duplicateWindow = windows.rows.find((row) => row.event_id === duplicate.id);
  let applicationWindow: MergeReceipt["applicationWindow"] = "none";
  if (duplicateWindow && !keeperWindow) {
    await client.query(`update application_windows set event_id = $1 where id = $2`, [
      keeper.id,
      duplicateWindow.id
    ]);
    applicationWindow = "moved_duplicate";
  } else if (duplicateWindow && keeperWindow) {
    if (windowRichness(duplicateWindow) > windowRichness(keeperWindow)) {
      // Drop the poorer row FIRST so the one-window-per-event constraint holds
      // at every point in the transaction.
      await client.query(`delete from application_windows where id = $1`, [keeperWindow.id]);
      await client.query(`update application_windows set event_id = $1 where id = $2`, [
        keeper.id,
        duplicateWindow.id
      ]);
      applicationWindow = "took_duplicate";
    } else {
      applicationWindow = "kept_keeper";
    }
  } else if (keeperWindow) {
    applicationWindow = "kept_keeper";
  }

  // 4. Weather. Unique on (event_id, fetched_on): a day the keeper already has
  //    a forecast for keeps the keeper's row.
  const weather = await client.query(
    `with moved as (
       update event_weather w
       set event_id = $1
       where w.event_id = $2
         and not exists (
           select 1 from event_weather k
           where k.event_id = $1 and k.fetched_on = w.fetched_on
         )
       returning 1
     ) select count(*)::int as moved from moved`,
    [keeper.id, duplicate.id]
  );
  const weatherLeft = await client.query<{ id: string }>(
    `select id from event_weather where event_id = $1`,
    [duplicate.id]
  );

  // 5. Everything else that points at the event.
  const otherReferencesMoved: Record<string, number> = {};
  for (const { table, key } of REFERENCE_TABLES) {
    const guard = key.length
      ? ` and not exists (select 1 from ${table} k where k.event_id = $1 and ${key
          .map((column) => `k.${column} is not distinct from t.${column}`)
          .join(" and ")})`
      : "";
    const moved = await client.query(
      `update ${table} t set event_id = $1 where t.event_id = $2${guard} returning 1`,
      [keeper.id, duplicate.id]
    );
    if (moved.rowCount) otherReferencesMoved[table] = moved.rowCount;
    if (key.length) {
      // Whatever is left carries a key the keeper already holds: the same check,
      // the same alert, the same request. It goes with the duplicate row.
      const left = await client.query<{ id: string }>(
        `select 1 as id from ${table} where event_id = $1`,
        [duplicate.id]
      );
      if (left.rowCount) otherReferencesMoved[`${table}_already_on_keeper`] = left.rowCount;
    }
  }

  await client.query(`delete from events where id = $1 and tenant_id = $2`, [
    duplicate.id,
    TENANT_ID
  ]);

  return {
    keeperId: keeper.id,
    keeperName: keeper.canonical_name,
    duplicateId: duplicate.id,
    duplicateName: duplicate.canonical_name,
    city: keeper.city,
    confidence: pair.confidence,
    sourceLinksMoved: links.rows[0].moved,
    evidenceMoved: evidence.rows[0].moved,
    evidenceAlreadyPresent: evidenceLeft.rowCount ?? 0,
    weatherMoved: weather.rows[0].moved,
    weatherAlreadyPresent: weatherLeft.rowCount ?? 0,
    applicationWindow,
    otherReferencesMoved: {
      ...otherReferencesMoved,
      ...(leftoverLinks.rowCount ? { event_source_links_duplicate_dropped: leftoverLinks.rowCount } : {})
    }
  };
}

function printReceipt(receipt: MergeReceipt, index: number) {
  console.log(`\nMERGE ${index + 1}`);
  console.log(`  keeper     ${receipt.keeperName}`);
  console.log(`             ${receipt.keeperId}`);
  console.log(`  duplicate  ${receipt.duplicateName}`);
  console.log(`             ${receipt.duplicateId}`);
  console.log(`  city       ${receipt.city}`);
  console.log(`  confidence ${receipt.confidence.toFixed(4)} (gate ${MERGE_THRESHOLD})`);
  console.log(
    `  moved      ${receipt.sourceLinksMoved} source link(s) · ${receipt.evidenceMoved} evidence row(s) · ` +
      `${receipt.weatherMoved} weather row(s) · application window: ${receipt.applicationWindow}`
  );
  if (receipt.evidenceAlreadyPresent || receipt.weatherAlreadyPresent) {
    console.log(
      `  already on the keeper: ${receipt.evidenceAlreadyPresent} evidence row(s), ` +
        `${receipt.weatherAlreadyPresent} weather row(s) — the same fact, not a second one`
    );
  }
  const others = Object.entries(receipt.otherReferencesMoved);
  if (others.length) {
    console.log(`  other refs ${others.map(([table, count]) => `${table}=${count}`).join(" · ")}`);
  }
}

async function main() {
  if (!databaseConfigured()) {
    console.error("PITCHRADAR_DATABASE_URL is not configured; nothing to re-merge.");
    process.exitCode = 1;
    return;
  }
  const apply = process.argv.slice(2).includes("--apply");

  const receipts = await withDatabaseTransaction(async (client) => {
    const events = await client.query<EventRow>(
      `select id, external_id, canonical_name, city, starts_at, ends_at, created_at
       from events where tenant_id = $1 order by id`,
      [TENANT_ID]
    );
    const { merge: pairs, held } = mergePairsFor(events.rows);
    console.log(
      `${events.rows.length} events scanned · ${pairs.length} pair(s) match the current rule ` +
        `(same city, overlapping dates, name confidence >= ${MERGE_THRESHOLD}, two different publishers).`
    );
    held.forEach((pair) => {
      console.log(
        `\nHELD BACK (${pair.confidence.toFixed(4)}) — ${pair.reason}\n` +
          `  ${pair.left.canonical_name} (${pair.left.id})\n` +
          `  ${pair.right.canonical_name} (${pair.right.id})`
      );
    });

    // A three-way duplicate would otherwise try to merge into a row that has
    // already been removed. Redirect every later pair onto the surviving keeper.
    const redirect = new Map<string, string>();
    const resolved = new Map<string, EventRow>(events.rows.map((row) => [row.id, row]));
    const done: MergeReceipt[] = [];
    for (const pair of pairs) {
      let keeperId = pair.keeper.id;
      while (redirect.has(keeperId)) keeperId = redirect.get(keeperId)!;
      if (redirect.has(pair.duplicate.id)) continue;
      if (keeperId === pair.duplicate.id) continue;
      const keeper = resolved.get(keeperId)!;
      const receipt = apply
        ? await mergeOne(client, { ...pair, keeper })
        : ({
            keeperId: keeper.id,
            keeperName: keeper.canonical_name,
            duplicateId: pair.duplicate.id,
            duplicateName: pair.duplicate.canonical_name,
            city: keeper.city,
            confidence: pair.confidence,
            sourceLinksMoved: 0,
            evidenceMoved: 0,
            evidenceAlreadyPresent: 0,
            weatherMoved: 0,
            weatherAlreadyPresent: 0,
            applicationWindow: "none",
            otherReferencesMoved: {}
          } satisfies MergeReceipt);
      redirect.set(pair.duplicate.id, keeper.id);
      done.push(receipt);
    }

    // A dry run issues no write at all — the transaction commits an empty unit
    // of work, which is exactly what "nothing was changed" should look like.
    return done;
  });

  receipts.forEach(printReceipt);
  console.log(
    `\n${receipts.length} merge(s) ${apply ? "applied" : "identified — DRY RUN, nothing was written"}.`
  );
  if (!apply) console.log("Re-run with --apply to perform them.");
}

/**
 * The pure half of this module (`mergePairsFor`, `windowRichness`) is imported
 * by its regression suite, so the pass only runs when the file is the process
 * entry point — importing it must never touch the database or exit the process.
 */
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("merge-duplicates.ts");

if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode ?? 0));
}
