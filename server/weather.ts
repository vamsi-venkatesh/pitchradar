/**
 * Weather enrichment — display and alert only.
 *
 * Three rules, set by the owner and enforced here:
 *  1. Weather activates ONLY for events starting inside
 *     PITCHRADAR_WEATHER_WINDOW_DAYS (default 10). A forecast further out is
 *     not information, it is noise.
 *  2. It NEVER changes the fit score. Nothing in src/ranking.ts reads these
 *     fields, and server/weather.test.ts asserts that scoring is byte-identical
 *     with and without a forecast attached.
 *  3. Every stored forecast carries its own receipt: the exact request URL, the
 *     source, and the raw daily arrays it was derived from.
 *
 * Coordinates come from Open-Meteo's geocoding API at CITY precision. That is
 * what `geocode_source` records; it is not the pitch location and must never be
 * presented as one.
 */
import { databaseConfigured, withDatabaseConnection } from "./database";
import { berlinDayKey } from "./deadline-monitor";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";
const MS_DAY = 86_400_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 200_000;
/**
 * Bounded per cycle run, but the bound must comfortably exceed a busy season's
 * 10-day window (measured 2026-09-15: 160 relevant events in window — a cap of
 * 50 silently starved two-thirds of them, including the week's Primary).
 * Open-Meteo's free tier allows far more than this per day.
 */
const MAX_EVENTS_PER_PASS = 400;
/** Open-Meteo publishes at most 16 forecast days. */
const MAX_FORECAST_HORIZON_DAYS = 16;
export const DEFAULT_WEATHER_WINDOW_DAYS = 10;
export const GEOCODE_SOURCE = "open-meteo-geocoding";
export const FORECAST_SOURCE = "open-meteo-forecast";
const GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const DAILY_FIELDS = [
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "temperature_2m_max",
  "temperature_2m_min"
] as const;

/** Thresholds are fixed constants so a flag always means the same thing. */
export const RISK_THRESHOLDS = {
  rainProbabilityPercent: 60,
  rainSumMm: 5,
  windKmh: 40,
  heatCelsius: 32,
  coldCelsius: 5
} as const;

export type WeatherRiskFlag = "rain" | "wind" | "heat" | "cold";

export interface DailyForecast {
  time: string[];
  precipitation_sum?: Array<number | null>;
  precipitation_probability_max?: Array<number | null>;
  wind_speed_10m_max?: Array<number | null>;
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
}

export interface WeatherFailure {
  eventId: string;
  eventName: string;
  stage: "geocode" | "forecast" | "store";
  error: string;
}

export interface WeatherReceipt {
  startedAt: string;
  completedAt: string;
  eventsInWindow: number;
  geocoded: number;
  forecastsFetched: number;
  riskFlagged: number;
  windowDays: number;
  failures: WeatherFailure[];
  skipped?: "database_not_configured";
}

export interface WeatherQueryRunner {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Single network seam, same shape as webInternals in server/web.ts. Both
 * hostnames are fixed constants, so no user- or web-supplied value ever selects
 * the target. Tests replace this and never touch the network.
 */
export const weatherInternals = {
  fetchImpl: ((input: string, init?: RequestInit) => fetch(input, init)) as (
    input: string,
    init?: RequestInit
  ) => Promise<Response>
};

export function parseWeatherWindowDays(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_WEATHER_WINDOW_DAYS;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`PITCHRADAR_WEATHER_WINDOW_DAYS must be a whole day count; got "${trimmed}".`);
  }
  const value = Number(trimmed);
  if (value < 1 || value > MAX_FORECAST_HORIZON_DAYS) {
    throw new Error(
      `PITCHRADAR_WEATHER_WINDOW_DAYS must be between 1 and ${MAX_FORECAST_HORIZON_DAYS}; got "${trimmed}".`
    );
  }
  return value;
}

function maxOf(values: Array<number | null> | undefined): number | null {
  const numbers = (values || []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) : null;
}

function minOf(values: Array<number | null> | undefined): number | null {
  const numbers = (values || []).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length ? Math.min(...numbers) : null;
}

/**
 * Deterministic flags from the daily arrays. A missing measurement raises no
 * flag — "not measured" is not "safe", and the absence is visible in the stored
 * raw forecast rather than guessed at here.
 */
export function deriveRiskFlags(daily: DailyForecast): WeatherRiskFlag[] {
  const flags: WeatherRiskFlag[] = [];
  const probability = maxOf(daily.precipitation_probability_max);
  const precipitation = maxOf(daily.precipitation_sum);
  const wind = maxOf(daily.wind_speed_10m_max);
  const high = maxOf(daily.temperature_2m_max);
  if (
    (probability !== null && probability >= RISK_THRESHOLDS.rainProbabilityPercent) ||
    (precipitation !== null && precipitation >= RISK_THRESHOLDS.rainSumMm)
  ) {
    flags.push("rain");
  }
  if (wind !== null && wind >= RISK_THRESHOLDS.windKmh) flags.push("wind");
  if (high !== null && high >= RISK_THRESHOLDS.heatCelsius) flags.push("heat");
  // Cold uses the same daily high: a day that never gets above 5 °C is a cold
  // trading day, whatever the night did.
  if (high !== null && high <= RISK_THRESHOLDS.coldCelsius) flags.push("cold");
  return flags;
}

export function summariseForecast(daily: DailyForecast) {
  return {
    days: (daily.time || []).length,
    precipitationSumMaxMm: maxOf(daily.precipitation_sum),
    precipitationProbabilityMaxPercent: maxOf(daily.precipitation_probability_max),
    windSpeedMaxKmh: maxOf(daily.wind_speed_10m_max),
    temperatureMaxC: maxOf(daily.temperature_2m_max),
    temperatureMinC: minOf(daily.temperature_2m_min)
  };
}

async function readJson(url: string): Promise<unknown> {
  const response = await weatherInternals.fetchImpl(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error("Weather response exceeded the size limit.");
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error("Weather response exceeded the size limit.");
  return JSON.parse(body) as unknown;
}

export function geocodeUrl(city: string): string {
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set("name", city);
  url.searchParams.set("country_code", "DE");
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "de");
  url.searchParams.set("format", "json");
  return url.toString();
}

export function forecastUrl(input: {
  latitude: number;
  longitude: number;
  startDate: string;
  endDate: string;
}): string {
  const url = new URL(FORECAST_ENDPOINT);
  url.searchParams.set("latitude", String(input.latitude));
  url.searchParams.set("longitude", String(input.longitude));
  url.searchParams.set("daily", DAILY_FIELDS.join(","));
  url.searchParams.set("timezone", "Europe/Berlin");
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("start_date", input.startDate);
  url.searchParams.set("end_date", input.endDate);
  return url.toString();
}

/**
 * Deterministic query variants for names the geocoder rejects verbatim,
 * tried in order (measured failures 2026-09-15): "St. Goarshausen" needs the
 * unabbreviated "Sankt"; "Kornmarkt Bad Kreuznach" carries a venue word before
 * the city, recovered by dropping leading tokens. Never more than 3 lookups.
 */
export function geocodeCandidates(city: string): string[] {
  const trimmed = city.trim().replace(/\s+/g, " ");
  const candidates = [trimmed];
  const expanded = trimmed.replace(/\bSt\.\s*/gi, "Sankt ");
  if (expanded !== trimmed) candidates.push(expanded);
  const tokens = trimmed.split(" ");
  if (tokens.length >= 3) candidates.push(tokens.slice(1).join(" "));
  else if (tokens.length === 2) candidates.push(tokens[1]);
  return [...new Set(candidates)].slice(0, 3);
}

export async function geocodeCity(city: string): Promise<{ latitude: number; longitude: number }> {
  const candidates = geocodeCandidates(city);
  for (const candidate of candidates) {
    const body = await readJson(geocodeUrl(candidate)) as {
      results?: Array<{ latitude?: number; longitude?: number }>;
    };
    const first = body.results?.[0];
    if (typeof first?.latitude === "number" && typeof first?.longitude === "number") {
      return { latitude: first.latitude, longitude: first.longitude };
    }
  }
  throw new Error(`No German geocoding result for "${city}" (tried: ${candidates.join(" | ")}).`);
}

interface WeatherEventRow {
  id: string;
  canonical_name: string;
  city: string;
  starts_at: Date | string;
  ends_at: Date | string;
  latitude: number | string | null;
  longitude: number | string | null;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface WeatherEnrichmentOptions {
  now?: Date;
  windowDays?: number;
}

export async function runWeatherEnrichmentOn(
  client: WeatherQueryRunner,
  options: WeatherEnrichmentOptions = {}
): Promise<WeatherReceipt> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const windowDays = options.windowDays
    ?? parseWeatherWindowDays(process.env.PITCHRADAR_WEATHER_WINDOW_DAYS);
  const horizon = new Date(now.getTime() + windowDays * MS_DAY);
  const today = berlinDayKey(now);
  const failures: WeatherFailure[] = [];
  let geocoded = 0;
  let forecastsFetched = 0;
  let riskFlagged = 0;

  const events = await client.query<WeatherEventRow>(
    `select e.id, e.canonical_name, e.city, e.starts_at, e.ends_at,
       e.latitude, e.longitude
       from events e
      where e.tenant_id = $1
        and e.pipeline <> 'rejected'
        and e.vendor_relevance <> 'irrelevant'
        and e.ends_at >= $2
        and e.starts_at <= $3
      order by e.starts_at
      limit ${MAX_EVENTS_PER_PASS}`,
    [TENANT_ID, now.toISOString(), horizon.toISOString()]
  );

  for (const event of events.rows) {
    let latitude = numberOrNull(event.latitude);
    let longitude = numberOrNull(event.longitude);
    if (latitude === null || longitude === null) {
      try {
        const located = await geocodeCity(event.city);
        latitude = located.latitude;
        longitude = located.longitude;
        await client.query(
          `update events
              set latitude = $2, longitude = $3, geocode_source = $4, updated_at = now()
            where id = $1`,
          [event.id, latitude, longitude, GEOCODE_SOURCE]
        );
        geocoded += 1;
      } catch (error) {
        // A city we cannot locate is skipped and recorded. The cycle continues.
        failures.push({
          eventId: event.id,
          eventName: event.canonical_name,
          stage: "geocode",
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
    }

    const startDate = berlinDayKey(asDate(event.starts_at));
    const lastForecastDay = berlinDayKey(new Date(now.getTime() + MAX_FORECAST_HORIZON_DAYS * MS_DAY));
    const eventEnd = berlinDayKey(asDate(event.ends_at));
    const endDate = eventEnd > lastForecastDay ? lastForecastDay : eventEnd;
    const url = forecastUrl({ latitude, longitude, startDate, endDate });
    let daily: DailyForecast;
    try {
      const body = await readJson(url) as { daily?: DailyForecast };
      if (!body.daily || !Array.isArray(body.daily.time)) {
        throw new Error("Forecast response carried no daily series.");
      }
      daily = body.daily;
      forecastsFetched += 1;
    } catch (error) {
      failures.push({
        eventId: event.id,
        eventName: event.canonical_name,
        stage: "forecast",
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const riskFlags = deriveRiskFlags(daily);
    if (riskFlags.length) riskFlagged += 1;
    try {
      await client.query(
        `insert into event_weather (
           event_id, fetched_at, fetched_on, source, forecast, risk_flags
         ) values ($1, $2, $3::date, $4, $5::jsonb, $6::text[])
         on conflict (event_id, fetched_on) do update set
           fetched_at = excluded.fetched_at,
           source = excluded.source,
           forecast = excluded.forecast,
           risk_flags = excluded.risk_flags`,
        [
          event.id,
          now.toISOString(),
          today,
          FORECAST_SOURCE,
          JSON.stringify({
            requestUrl: url,
            fetchedAt: now.toISOString(),
            source: FORECAST_SOURCE,
            geocodePrecision: "city",
            startDate,
            endDate,
            daily,
            summary: summariseForecast(daily)
          }),
          riskFlags
        ]
      );
    } catch (error) {
      failures.push({
        eventId: event.id,
        eventName: event.canonical_name,
        stage: "store",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    eventsInWindow: events.rows.length,
    geocoded,
    forecastsFetched,
    riskFlagged,
    windowDays,
    failures
  };
}

export async function runWeatherEnrichment(now = new Date()): Promise<WeatherReceipt> {
  const startedAt = now.toISOString();
  if (!databaseConfigured()) {
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      eventsInWindow: 0,
      geocoded: 0,
      forecastsFetched: 0,
      riskFlagged: 0,
      windowDays: parseWeatherWindowDays(process.env.PITCHRADAR_WEATHER_WINDOW_DAYS),
      failures: [],
      skipped: "database_not_configured"
    };
  }
  return withDatabaseConnection((client) => runWeatherEnrichmentOn(client, { now }));
}
