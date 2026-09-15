/**
 * Deadline monitor — the stage that finally reads what the rest of the system
 * has been writing.
 *
 * Two jobs, both deterministic and both receipted:
 *
 * 1. Evidence state. `application_windows.deadline_at is null` used to conflate
 *    "no deadline published yet" with "no deadline exists, applications are
 *    rolling". Migration 012 added `deadline_evidence`; this stage keeps it
 *    true on every pass with single UPDATE statements.
 * 2. Alerts. For every window with a *published* future deadline, one alert row
 *    per configured threshold once the deadline is that close. The unique key
 *    (event_id, threshold_days, deadline_at) makes the pass idempotent: running
 *    it twice creates nothing; a changed deadline is a different value and so
 *    earns a fresh set of alerts.
 *
 * What this stage deliberately does NOT do: fetch anything. Due windows are
 * counted and reported; re-verification stays the intelligence stage's job, so
 * `next_check_at` is left exactly as it was found.
 */
import { databaseConfigured, withDatabaseTransaction } from "./database";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";
const MS_DAY = 86_400_000;
export const DEFAULT_DEADLINE_ALERT_DAYS = [30, 14, 7, 2] as const;

/** Minimal surface of a `pg` client, so the pass is testable without a socket. */
export interface DeadlineQueryRunner {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export type DeadlineEvidence = "published" | "not_found" | "none_rolling";

export interface DeadlineMonitorReceipt {
  startedAt: string;
  completedAt: string;
  /** Windows whose next_check_at has come due. Counted, never fetched here. */
  dueWindows: number;
  alertsCreated: number;
  alertsByThreshold: Record<string, number>;
  deadlinePassedCount: number;
  evidenceUpdated: Record<DeadlineEvidence, number>;
  thresholds: number[];
  skipped?: "database_not_configured";
}

const BERLIN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/** The Europe/Berlin calendar day an instant falls on, as `YYYY-MM-DD`. */
export function berlinDayKey(instant: Date): string {
  const parts = Object.fromEntries(
    BERLIN_DAY.formatToParts(instant)
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, part.value])
  ) as { year: string; month: string; day: string };
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Whole calendar days between two Berlin day keys. Day keys are compared as
 * plain calendar dates, so no DST transition can turn 30 days into 29.5.
 */
export function daysBetweenDayKeys(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_DAY);
}

/**
 * Parses PITCHRADAR_DEADLINE_ALERT_DAYS. Invalid entries are rejected rather
 * than silently coerced — a typo must not quietly disable an alert — and the
 * default list stands when the variable is absent or empty.
 */
export function parseAlertThresholds(raw: string | undefined): number[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [...DEFAULT_DEADLINE_ALERT_DAYS];
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  const thresholds = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(`PITCHRADAR_DEADLINE_ALERT_DAYS must be whole positive day counts; got "${part}".`);
    }
    const value = Number(part);
    if (value < 1 || value > 365) {
      throw new Error(`PITCHRADAR_DEADLINE_ALERT_DAYS entries must be between 1 and 365; got "${part}".`);
    }
    return value;
  });
  if (!thresholds.length) return [...DEFAULT_DEADLINE_ALERT_DAYS];
  return [...new Set(thresholds)].sort((a, b) => b - a);
}

interface PublishedWindowRow {
  window_id: string;
  event_id: string;
  tenant_id: string;
  deadline_at: Date | string;
}

/**
 * Keeps deadline_evidence true to what the row proves. Three single statements,
 * each returning the rows it actually changed so the receipt cannot overstate.
 */
async function refreshEvidence(client: DeadlineQueryRunner) {
  const published = await client.query(
    `update application_windows
        set deadline_evidence = 'published', updated_at = now()
      where deadline_at is not null
        and deadline_evidence <> 'published'`
  );
  const rolling = await client.query(
    `update application_windows
        set deadline_evidence = 'none_rolling', updated_at = now()
      where deadline_at is null
        and capacity = 'rolling'
        and deadline_evidence <> 'none_rolling'`
  );
  // A window that stops being rolling without a published deadline is back to
  // "we have not found one", not "there is none".
  const notFound = await client.query(
    `update application_windows
        set deadline_evidence = 'not_found', updated_at = now()
      where deadline_at is null
        and capacity <> 'rolling'
        and deadline_evidence <> 'not_found'`
  );
  return {
    published: published.rowCount ?? 0,
    none_rolling: rolling.rowCount ?? 0,
    not_found: notFound.rowCount ?? 0
  } satisfies Record<DeadlineEvidence, number>;
}

export interface DeadlineMonitorOptions {
  now?: Date;
  thresholds?: number[];
}

/** The whole pass against one client. Exported so tests can drive it directly. */
export async function runDeadlineMonitorOn(
  client: DeadlineQueryRunner,
  options: DeadlineMonitorOptions = {}
): Promise<DeadlineMonitorReceipt> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const thresholds = options.thresholds
    ?? parseAlertThresholds(process.env.PITCHRADAR_DEADLINE_ALERT_DAYS);
  const today = berlinDayKey(now);

  const evidenceUpdated = await refreshEvidence(client);

  // (a) Due windows are recorded, not acted on. next_check_at is untouched:
  // fetching and re-verification belong to the intelligence stage.
  const due = await client.query<{ due: number }>(
    `select count(*)::int as due
       from application_windows
      where next_check_at <= $1`,
    [now.toISOString()]
  );
  const dueWindows = due.rows[0]?.due ?? 0;

  // (b) Alerts for published deadlines only. An unpublished or rolling window
  // has no date to count down to, and inventing one would be a fabrication.
  const windows = await client.query<PublishedWindowRow>(
    `select aw.id as window_id, aw.event_id, e.tenant_id, aw.deadline_at
       from application_windows aw
       join events e on e.id = aw.event_id
      where aw.deadline_evidence = 'published'
        and aw.deadline_at is not null
      order by aw.deadline_at`
  );

  const alertsByThreshold: Record<string, number> = {};
  let alertsCreated = 0;
  let deadlinePassedCount = 0;

  for (const window of windows.rows) {
    const deadlineKey = berlinDayKey(
      window.deadline_at instanceof Date ? window.deadline_at : new Date(window.deadline_at)
    );
    const daysRemaining = daysBetweenDayKeys(today, deadlineKey);
    if (daysRemaining < 0) {
      deadlinePassedCount += 1;
      continue;
    }
    for (const threshold of thresholds) {
      if (daysRemaining > threshold) continue;
      const inserted = await client.query<{ id: string }>(
        `insert into deadline_alerts (
           tenant_id, event_id, window_id, threshold_days, deadline_at, alert_state
         ) values ($1, $2, $3, $4, $5::date, 'pending')
         on conflict (event_id, threshold_days, deadline_at) do nothing
         returning id`,
        [window.tenant_id ?? TENANT_ID, window.event_id, window.window_id, threshold, deadlineKey]
      );
      if (inserted.rowCount) {
        alertsCreated += 1;
        alertsByThreshold[String(threshold)] = (alertsByThreshold[String(threshold)] ?? 0) + 1;
      }
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    dueWindows,
    alertsCreated,
    alertsByThreshold,
    deadlinePassedCount,
    evidenceUpdated,
    thresholds
  };
}

/** Cycle entry point. Without a database there is nothing to monitor. */
export async function runDeadlineMonitor(now = new Date()): Promise<DeadlineMonitorReceipt> {
  const startedAt = now.toISOString();
  if (!databaseConfigured()) {
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      dueWindows: 0,
      alertsCreated: 0,
      alertsByThreshold: {},
      deadlinePassedCount: 0,
      evidenceUpdated: { published: 0, not_found: 0, none_rolling: 0 },
      thresholds: parseAlertThresholds(process.env.PITCHRADAR_DEADLINE_ALERT_DAYS),
      skipped: "database_not_configured"
    };
  }
  return withDatabaseTransaction((client) => runDeadlineMonitorOn(client, { now }));
}
