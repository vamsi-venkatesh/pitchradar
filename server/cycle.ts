import type { PoolClient } from "pg";
import { runBookingLifecycle } from "./booking-lifecycle";
import { collectRegisteredSources } from "./collector";
import { runContactResolution } from "./contact-resolver";
import {
  databaseConfigured,
  databaseQuery,
  migrateDatabase,
  withDatabaseConnection
} from "./database";
import { runDeadlineMonitor } from "./deadline-monitor";
import { runOrganizerIntelligence } from "./intelligence";
import { normalizePendingOccurrences } from "./normalizer";
import { refreshAvailabilityQueue } from "./outreach";
import { runWeatherEnrichment } from "./weather";

export type OperatingStageName =
  | "booking_lifecycle"
  | "collect"
  | "normalize"
  | "intelligence"
  | "contact_resolution"
  | "owner_queue"
  | "deadline_monitor"
  | "weather";
export type OperatingStageState = "succeeded" | "partial" | "failed";

export interface OperatingStageReceipt {
  name: OperatingStageName;
  state: OperatingStageState;
  startedAt: string;
  completedAt: string;
  summary: unknown;
  error?: string;
}

export interface OperatingCycleExecution {
  state: "succeeded" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  stages: OperatingStageReceipt[];
  externalActions: 0;
}

export interface OperatingCycleDependencies {
  /**
   * Booking hygiene, first: an elapsed booking that still reads 'live' blocks
   * weeks the truck is already free, so every later stage — and the report —
   * must see the corrected state, not the stale one.
   */
  bookingLifecycle: () => Promise<object>;
  collect: () => Promise<object & {
    receipts?: Array<{ runState?: string }>;
  }>;
  normalize: () => Promise<object>;
  intelligence: () => Promise<object & { warnings?: string[] }>;
  /**
   * Impressum-grounded contact resolution. Bounded, read-only public GETs
   * through the SSRF-guarded fetcher — the same footprint as collection, so it
   * adds no external action.
   */
  contactResolution: () => Promise<object & { failures?: unknown[] }>;
  /** Reads due windows and generates deadline alerts. Performs no fetch. */
  deadlineMonitor: () => Promise<object>;
  /** Display-only forecast enrichment. Never touches the fit score. */
  weather: () => Promise<object & { failures?: unknown[] }>;
  ownerQueue: () => Promise<object>;
  now?: () => Date;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function executeOperatingCycle(
  dependencies: OperatingCycleDependencies
): Promise<OperatingCycleExecution> {
  const now = dependencies.now || (() => new Date());
  const startedAt = now().toISOString();
  const stages: OperatingStageReceipt[] = [];
  const sequence: Array<{
    name: OperatingStageName;
    run: () => Promise<object>;
    classify?: (result: object) => OperatingStageState;
  }> = [
    { name: "booking_lifecycle", run: dependencies.bookingLifecycle },
    {
      name: "collect",
      run: dependencies.collect,
      classify: (result) => {
        const receipts = "receipts" in result && Array.isArray(result.receipts) ? result.receipts : [];
        return receipts.some((receipt) => receipt?.runState !== "succeeded") ? "partial" : "succeeded";
      }
    },
    { name: "normalize", run: dependencies.normalize },
    {
      name: "intelligence",
      run: dependencies.intelligence,
      classify: (result) =>
        "warnings" in result && Array.isArray(result.warnings) && result.warnings.length
          ? "partial"
          : "succeeded"
    },
    {
      name: "contact_resolution",
      run: dependencies.contactResolution,
      classify: (result) =>
        "failures" in result && Array.isArray(result.failures) && result.failures.length
          ? "partial"
          : "succeeded"
    },
    { name: "owner_queue", run: dependencies.ownerQueue },
    { name: "deadline_monitor", run: dependencies.deadlineMonitor },
    {
      name: "weather",
      run: dependencies.weather,
      classify: (result) =>
        "failures" in result && Array.isArray(result.failures) && result.failures.length
          ? "partial"
          : "succeeded"
    }
  ];

  for (const stage of sequence) {
    const stageStartedAt = now().toISOString();
    try {
      const result = await stage.run();
      stages.push({
        name: stage.name,
        state: stage.classify?.(result) || "succeeded",
        startedAt: stageStartedAt,
        completedAt: now().toISOString(),
        summary: result
      });
    } catch (error) {
      stages.push({
        name: stage.name,
        state: "failed",
        startedAt: stageStartedAt,
        completedAt: now().toISOString(),
        summary: {},
        error: errorText(error)
      });
    }
  }

  const failed = stages.filter((stage) => stage.state === "failed").length;
  const partial = stages.some((stage) => stage.state === "partial");
  return {
    state: failed === stages.length ? "failed" : failed || partial ? "partial" : "succeeded",
    startedAt,
    completedAt: now().toISOString(),
    stages,
    externalActions: 0
  };
}

async function persistCycle(
  client: PoolClient,
  trigger: "manual" | "schedule",
  operation: () => Promise<OperatingCycleExecution>
) {
  const inserted = await client.query<{ id: string }>(
    `insert into operating_cycles (trigger, state)
     values ($1, 'running')
     returning id`,
    [trigger]
  );
  const id = inserted.rows[0].id;
  try {
    const result = await operation();
    await client.query(
      `update operating_cycles
       set completed_at = $2, state = $3, stages = $4::jsonb,
         error_summary = $5, external_actions = 0
       where id = $1`,
      [
        id,
        result.completedAt,
        result.state,
        JSON.stringify(result.stages),
        result.stages.filter((stage) => stage.error).map((stage) => `${stage.name}: ${stage.error}`).join("; ") || null
      ]
    );
    return { id, trigger, ...result };
  } catch (error) {
    await client.query(
      `update operating_cycles
       set completed_at = now(), state = 'failed', error_summary = $2, external_actions = 0
       where id = $1`,
      [id, errorText(error)]
    );
    throw error;
  }
}

export async function runOperatingCycle(
  trigger: "manual" | "schedule" = "manual"
) {
  if (!databaseConfigured()) {
    throw new Error("PITCHRADAR_DATABASE_URL is required for the recurring operating cycle.");
  }
  await migrateDatabase();
  return withDatabaseConnection(async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('pitchradar-operating-cycle')) as acquired"
    );
    if (!lock.rows[0]?.acquired) {
      return {
        id: null,
        trigger,
        state: "skipped_locked" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        stages: [],
        externalActions: 0 as const
      };
    }
    try {
      return await persistCycle(client, trigger, () =>
        executeOperatingCycle({
          bookingLifecycle: async () => runBookingLifecycle(),
          collect: async () => collectRegisteredSources({ dueOnly: true }),
          normalize: async () => normalizePendingOccurrences(),
          intelligence: async () => runOrganizerIntelligence(),
          contactResolution: async () => runContactResolution(),
          ownerQueue: async () => refreshAvailabilityQueue(),
          deadlineMonitor: async () => runDeadlineMonitor(),
          weather: async () => runWeatherEnrichment()
        })
      );
    } finally {
      await client.query("select pg_advisory_unlock(hashtext('pitchradar-operating-cycle'))");
    }
  });
}

export async function latestOperatingCycle() {
  if (!databaseConfigured()) return null;
  const result = await databaseQuery<{
    id: string;
    trigger: "manual" | "schedule";
    started_at: Date;
    completed_at: Date | null;
    state: string;
    stages: OperatingStageReceipt[];
    error_summary: string | null;
    external_actions: number;
  }>(
    `select id, trigger, started_at, completed_at, state, stages,
       error_summary, external_actions
     from operating_cycles
     order by started_at desc
     limit 1`
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    trigger: row.trigger,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    state: row.state,
    stages: row.stages,
    error: row.error_summary || undefined,
    externalActions: row.external_actions
  } : null;
}
