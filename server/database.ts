import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { RuntimeState } from "./types";

// Tests must never mutate the owner's real operating database, even when a local
// .env is present. Vitest sets VITEST=true before loading application modules.
const connectionString = process.env.VITEST === "true"
  ? undefined
  : process.env.PITCHRADAR_DATABASE_URL?.trim();
const pool = connectionString
  ? new Pool({
      connectionString,
      max: Number(process.env.PITCHRADAR_DATABASE_POOL_SIZE || 6),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    })
  : null;

export function databaseConfigured() {
  return Boolean(pool);
}

export async function databaseQuery<T extends QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  if (!pool) throw new Error("PITCHRADAR_DATABASE_URL is not configured.");
  return pool.query<T>(text, values);
}

export async function withDatabaseTransaction<T>(
  operation: (client: PoolClient) => Promise<T>
) {
  if (!pool) throw new Error("PITCHRADAR_DATABASE_URL is not configured.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function withDatabaseConnection<T>(
  operation: (client: PoolClient) => Promise<T>
) {
  if (!pool) throw new Error("PITCHRADAR_DATABASE_URL is not configured.");
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function migrateDatabase() {
  if (!pool) throw new Error("PITCHRADAR_DATABASE_URL is not configured.");
  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  const migrationDirectory = path.join(process.cwd(), "db", "migrations");
  const migrations = [
    { filename: "000_initial_schema.sql", path: path.join(process.cwd(), "db", "schema.sql") },
    ...(await readdir(migrationDirectory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => ({ filename: entry.name, path: path.join(migrationDirectory, entry.name) }))
      .sort((a, b) => a.filename.localeCompare(b.filename))
  ];

  for (const migration of migrations) {
    const sql = await readFile(migration.path, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ checksum: string }>(
      "select checksum from schema_migrations where filename = $1",
      [migration.filename]
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${migration.filename} was modified.`);
      }
      continue;
    }
    await withDatabaseTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename, checksum) values ($1, $2)",
        [migration.filename, checksum]
      );
    });
  }
}

export async function databaseHealth() {
  if (!pool) return { configured: false, reachable: false, mode: "local_json" as const };
  const started = performance.now();
  const result = await pool.query<{ database: string; migrations: number }>(`
    select current_database() as database,
      (select count(*)::int from schema_migrations) as migrations
  `);
  return {
    configured: true,
    reachable: true,
    mode: "postgres" as const,
    database: result.rows[0].database,
    migrations: result.rows[0].migrations,
    latencyMs: Math.round(performance.now() - started)
  };
}

export async function readDatabaseRuntimeState(): Promise<RuntimeState | null> {
  if (!pool) return null;
  const result = await pool.query<{ state: RuntimeState }>(
    "select state from agent_runtime_state where tenant_id = $1 and app_id = $2",
    ["demo-operator", "event_ops"]
  );
  return result.rows[0]?.state ?? null;
}

const RUNTIME_STATE_UPSERT_SQL = `insert into agent_runtime_state (tenant_id, app_id, state, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (tenant_id, app_id)
     do update set state = excluded.state, updated_at = now()`;

/**
 * Runs a read-modify-write of the runtime state row inside a single
 * transaction, holding a row lock (`select ... for update`) for its duration
 * so concurrent processes (deploy overlap, a second instance) cannot clobber
 * each other's updates. The in-process write queue in store.ts still
 * serializes callers within one process; this closes the cross-process race.
 */
export async function withRuntimeStateLock(
  updater: (current: RuntimeState | null) => RuntimeState | Promise<RuntimeState>
): Promise<RuntimeState> {
  return withDatabaseTransaction(async (client) => {
    const result = await client.query<{ state: RuntimeState }>(
      "select state from agent_runtime_state where tenant_id = $1 and app_id = $2 for update",
      ["demo-operator", "event_ops"]
    );
    const next = await updater(result.rows[0]?.state ?? null);
    await client.query(RUNTIME_STATE_UPSERT_SQL, [
      "demo-operator",
      "event_ops",
      JSON.stringify(next)
    ]);
    return next;
  });
}

export async function writeDatabaseRuntimeState(state: RuntimeState) {
  if (!pool) return false;
  await pool.query(RUNTIME_STATE_UPSERT_SQL, [
    "demo-operator",
    "event_ops",
    JSON.stringify(state)
  ]);
  return true;
}

export async function insertOwnerSession(id: string, expiresAt: string) {
  if (!pool) return false;
  await pool.query(
    "insert into owner_sessions (id, expires_at) values ($1, $2) on conflict (id) do nothing",
    [id, expiresAt]
  );
  return true;
}

export async function revokeOwnerSession(id: string) {
  if (!pool) return false;
  // Idempotent: revoking an already-revoked or expired session keeps the
  // original revoked_at and never errors.
  await pool.query(
    "update owner_sessions set revoked_at = coalesce(revoked_at, now()) where id = $1",
    [id]
  );
  return true;
}

export async function ownerSessionActive(id: string) {
  if (!pool) return false;
  const result = await pool.query<{ active: boolean }>(
    "select (revoked_at is null and expires_at > now()) as active from owner_sessions where id = $1",
    [id]
  );
  return result.rows[0]?.active === true;
}

/* ------------------------------------------------------------------ *
 * Client intake (migration 011). The profile row carries the structured
 * intake answers, their per-section status, and the two confirmation
 * timestamps. Everything above this line is unchanged.
 * ------------------------------------------------------------------ */

const PROFILE_TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";
const PROFILE_KEY = "primary";

/** jsonb payloads stay `unknown` here; server/profile.ts owns their shape. */
export interface ClientProfileIntakeRow {
  intake: unknown;
  intake_status: unknown;
  menu: unknown;
  menu_confirmed_at: Date | string | null;
  intake_completed_at: Date | string | null;
  missing_inputs: string[];
  home_postcode: string | null;
  normal_days: number[];
  optional_thursday: boolean;
  preferred_max_travel_minutes: number;
  exceptional_max_travel_minutes: number;
}

export interface ClientProfileIntakeUpdate {
  intake: unknown;
  intake_status: unknown;
  menu: unknown;
  menu_confirmed_at: string | null;
  intake_completed_at: string | null;
  missing_inputs: string[];
  home_postcode: string | null;
  normal_days: number[];
  optional_thursday: boolean;
  preferred_max_travel_minutes: number;
  exceptional_max_travel_minutes: number;
}

const CLIENT_PROFILE_INTAKE_COLUMNS = `intake, intake_status, menu, menu_confirmed_at,
        intake_completed_at, missing_inputs, home_postcode, normal_days,
        optional_thursday, preferred_max_travel_minutes, exceptional_max_travel_minutes`;

export async function readClientProfileIntakeRow(): Promise<ClientProfileIntakeRow | null> {
  if (!pool) return null;
  const result = await pool.query<ClientProfileIntakeRow>(
    `select ${CLIENT_PROFILE_INTAKE_COLUMNS}
       from client_profiles where tenant_id = $1 and profile_key = $2`,
    [PROFILE_TENANT_ID, PROFILE_KEY]
  );
  return result.rows[0] ?? null;
}

/**
 * Read-modify-write of the intake columns inside one transaction holding a row
 * lock, so two section saves (two tabs, two devices) can never clobber each
 * other's jsonb. Same shape as withRuntimeStateLock above.
 */
export async function withClientProfileIntakeLock(
  updater: (current: ClientProfileIntakeRow) => ClientProfileIntakeUpdate | Promise<ClientProfileIntakeUpdate>
): Promise<ClientProfileIntakeRow | null> {
  return withDatabaseTransaction(async (client) => {
    const current = await client.query<ClientProfileIntakeRow>(
      `select ${CLIENT_PROFILE_INTAKE_COLUMNS}
         from client_profiles where tenant_id = $1 and profile_key = $2 for update`,
      [PROFILE_TENANT_ID, PROFILE_KEY]
    );
    if (!current.rows[0]) return null;
    const next = await updater(current.rows[0]);
    const updated = await client.query<ClientProfileIntakeRow>(
      `update client_profiles
          set intake = $3::jsonb,
              intake_status = $4::jsonb,
              menu = $5::jsonb,
              menu_confirmed_at = $6,
              intake_completed_at = $7,
              missing_inputs = $8::text[],
              home_postcode = $9,
              normal_days = $10::smallint[],
              optional_thursday = $11,
              preferred_max_travel_minutes = $12,
              exceptional_max_travel_minutes = $13,
              updated_at = now()
        where tenant_id = $1 and profile_key = $2
      returning ${CLIENT_PROFILE_INTAKE_COLUMNS}`,
      [
        PROFILE_TENANT_ID,
        PROFILE_KEY,
        JSON.stringify(next.intake ?? {}),
        JSON.stringify(next.intake_status ?? {}),
        JSON.stringify(next.menu ?? []),
        next.menu_confirmed_at,
        next.intake_completed_at,
        next.missing_inputs,
        next.home_postcode,
        next.normal_days,
        next.optional_thursday,
        next.preferred_max_travel_minutes,
        next.exceptional_max_travel_minutes
      ]
    );
    return updated.rows[0] ?? null;
  });
}

export async function closeDatabase() {
  await pool?.end();
}
