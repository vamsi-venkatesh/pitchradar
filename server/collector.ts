import type { QueryResultRow } from "pg";
import type { RegisteredSource } from "../src/source-registry";
import {
  databaseConfigured,
  databaseQuery,
  withDatabaseTransaction
} from "./database";
import {
  extractTribeEvents,
  probeSource,
  type ExtractedOccurrence,
  type SourceProbeResult
} from "./source-probe";
import {
  extractAdapterEvents,
  extractIcsEvents,
  extractJsonLdEvents,
  sourceRouteHints
} from "./source-adapters";

type DatabaseSourceRow = QueryResultRow & {
  id: string;
  name: string;
  base_url: string;
  collector_url: string | null;
  source_kind: RegisteredSource["kind"];
  source_layer: RegisteredSource["layer"];
  priority: RegisteredSource["priority"];
  cadence: RegisteredSource["cadence"];
  extraction_mode: RegisteredSource["extractionMode"];
  official_for: string[];
  trust_rule: string;
  business_value: string;
  last_checked_at: Date | string | null;
};

export interface SourceCollectionReceipt {
  sourceId: string;
  sourceName: string;
  runId: string;
  runState: "succeeded" | "partial" | "failed";
  healthState: SourceProbeResult["state"];
  httpStatus: number | null;
  startedAt: string;
  completedAt: string;
  recordsSeen: number;
  recordsChanged: number;
  finalUrl: string;
  error?: string;
}

export interface CollectorRun {
  startedAt: string;
  completedAt: string;
  dueOnly: boolean;
  sourcesAvailable: number;
  sourcesSelected: number;
  receipts: SourceCollectionReceipt[];
  summary: Record<string, number>;
}

function asSource(row: DatabaseSourceRow): RegisteredSource {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    collectorUrl: row.collector_url ?? undefined,
    kind: row.source_kind,
    layer: row.source_layer,
    priority: row.priority,
    cadence: row.cadence,
    extractionMode: row.extraction_mode,
    officialFor: row.official_for,
    trustRule: row.trust_rule,
    businessValue: row.business_value
  };
}

export function sourceNextDueAt(
  lastCheckedAt: Date | string | null,
  cadence: RegisteredSource["cadence"]
) {
  if (!lastCheckedAt) return 0;
  const due = new Date(lastCheckedAt);
  if (cadence === "daily") due.setUTCDate(due.getUTCDate() + 1);
  if (cadence === "weekly") due.setUTCDate(due.getUTCDate() + 7);
  if (cadence === "monthly") due.setUTCMonth(due.getUTCMonth() + 1);
  if (cadence === "manual") due.setUTCDate(due.getUTCDate() + 14);
  return due.getTime();
}

function runState(probe: SourceProbeResult): SourceCollectionReceipt["runState"] {
  if (probe.state === "healthy") return "succeeded";
  if (probe.state === "restricted") return "partial";
  return "failed";
}

export function sourceCollectionUrl(source: RegisteredSource, now = new Date()) {
  if (!source.collectorUrl) return source.baseUrl;
  const url = new URL(source.collectorUrl);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 14);
  const end = new Date(now);
  end.setUTCMonth(end.getUTCMonth() + 18);
  url.searchParams.set("per_page", "50");
  url.searchParams.set("start_date", start.toISOString().slice(0, 10));
  url.searchParams.set("end_date", end.toISOString().slice(0, 10));
  return url.toString();
}

/** A WordPress "The Events Calendar" REST feed, whatever site publishes it. */
function isTribeFeed(source: RegisteredSource) {
  return Boolean(source.collectorUrl?.includes("/wp-json/tribe/events"));
}

export function extractOccurrences(
  source: RegisteredSource,
  probe: SourceProbeResult,
  now?: Date
): ExtractedOccurrence[] {
  if (!probe.bodyText) return [];
  const hints = sourceRouteHints[source.id] || {};
  if (isTribeFeed(source)) {
    return extractTribeEvents(probe.bodyText).map((event) => ({
      ...event,
      rawPayload: {
        ...event.rawPayload,
        eventUrl: typeof event.rawPayload.url === "string"
          ? event.rawPayload.url
          : source.baseUrl,
        ...hints
      }
    }));
  }
  if (source.extractionMode === "ics") {
    return extractIcsEvents(probe.bodyText, {
      now,
      sourceUrl: source.baseUrl,
      payload: hints
    });
  }
  const adapted = extractAdapterEvents(source.id, probe.bodyText, { now });
  if (adapted.length) return adapted;
  return extractJsonLdEvents(probe.bodyText, {
    now,
    sourceUrl: source.baseUrl,
    payload: hints
  });
}

async function storeProbe(
  source: RegisteredSource,
  probe: SourceProbeResult,
  startedAt: string,
  now?: Date
): Promise<SourceCollectionReceipt> {
  const completedAt = new Date().toISOString();
  const occurrences = extractOccurrences(source, probe, now);
  return withDatabaseTransaction(async (client) => {
    const run = await client.query<{ id: string }>(
      `insert into source_runs (
        source_id, started_at, completed_at, run_state, records_seen,
        records_changed, error_summary, run_receipt
      ) values ($1,$2,$3,$4,$5,0,$6,$7::jsonb)
      returning id`,
      [
        source.id,
        startedAt,
        completedAt,
        runState(probe),
        occurrences.length,
        probe.error ?? null,
        JSON.stringify({
          healthState: probe.state,
          httpStatus: probe.status,
          finalUrl: probe.finalUrl,
          contentType: probe.contentType,
          title: probe.title,
          bodyHash: probe.bodyHash,
          bytesReviewed: probe.bytesReviewed
        })
      ]
    );
    const runId = run.rows[0].id;
    let recordsChanged = 0;
    for (const occurrence of occurrences) {
      const inserted = await client.query(
        `insert into raw_event_occurrences (
          source_run_id, source_id, source_record_key, raw_name, raw_location,
          raw_starts_at, raw_ends_at, raw_payload, content_hash, observed_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
        on conflict (source_id, content_hash) do update set
          source_run_id = excluded.source_run_id,
          raw_payload = excluded.raw_payload,
          observed_at = excluded.observed_at,
          normalization_state = 'pending',
          normalized_at = null,
          normalization_note = null
        where raw_event_occurrences.raw_payload is distinct from excluded.raw_payload
        returning id`,
        [
          runId,
          source.id,
          occurrence.sourceRecordKey ?? null,
          occurrence.rawName,
          occurrence.rawLocation ?? null,
          occurrence.rawStartsAt ?? null,
          occurrence.rawEndsAt ?? null,
          JSON.stringify(occurrence.rawPayload),
          occurrence.contentHash,
          probe.checkedAt
        ]
      );
      recordsChanged += inserted.rowCount || 0;
    }
    await client.query(
      `update source_runs set records_changed = $2 where id = $1`,
      [runId, recordsChanged]
    );
    await client.query(
      `update registered_sources set
        last_checked_at = $2,
        last_success_at = case when $3 = 'healthy' then $2 else last_success_at end,
        last_http_status = $4
       where id = $1`,
      [source.id, probe.checkedAt, probe.state, probe.status]
    );
    return {
      sourceId: source.id,
      sourceName: source.name,
      runId,
      runState: runState(probe),
      healthState: probe.state,
      httpStatus: probe.status,
      startedAt,
      completedAt,
      recordsSeen: occurrences.length,
      recordsChanged,
      finalUrl: probe.finalUrl,
      error: probe.error
    };
  });
}

async function collectOne(row: DatabaseSourceRow, now: Date) {
  const source = asSource(row);
  const startedAt = new Date().toISOString();
  const probe = await probeSource({
    id: source.id,
    name: source.name,
    baseUrl: sourceCollectionUrl(source, now)
  });
  return storeProbe(source, probe, startedAt, now);
}

export async function collectRegisteredSources(options: {
  dueOnly?: boolean;
  sourceIds?: string[];
  concurrency?: number;
  now?: Date;
} = {}): Promise<CollectorRun> {
  if (!databaseConfigured()) {
    throw new Error("PostgreSQL is required for durable source collection receipts.");
  }
  const startedAt = new Date().toISOString();
  const now = options.now || new Date();
  const sourceResult = await databaseQuery<DatabaseSourceRow>(
    `select id, name, base_url, collector_url, source_kind, source_layer, priority, cadence,
      extraction_mode, official_for, trust_rule, business_value, last_checked_at
     from registered_sources where enabled order by priority, name`
  );
  const requested = new Set(options.sourceIds || []);
  const dueOnly = options.dueOnly !== false;
  const selected = sourceResult.rows.filter((source) =>
    (!requested.size || requested.has(source.id)) &&
    (!dueOnly || sourceNextDueAt(source.last_checked_at, source.cadence) <= now.getTime())
  );
  const concurrency = Math.max(1, Math.min(4, options.concurrency || 3));
  const receipts: SourceCollectionReceipt[] = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      receipts[index] = await collectOne(selected[index], now);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));

  const summary = receipts.reduce<Record<string, number>>((result, receipt) => {
    result[receipt.healthState] = (result[receipt.healthState] || 0) + 1;
    result.recordsSeen = (result.recordsSeen || 0) + receipt.recordsSeen;
    result.recordsChanged = (result.recordsChanged || 0) + receipt.recordsChanged;
    return result;
  }, {});
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    dueOnly,
    sourcesAvailable: sourceResult.rows.length,
    sourcesSelected: selected.length,
    receipts,
    summary
  };
}
