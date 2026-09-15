import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { databaseConfigured, withDatabaseTransaction } from "./database";
import { isVenueString, NO_VERIFIABLE_CITY_NOTE } from "./city-hygiene";
import { classifyVendorRelevance, type VendorRelevance } from "./vendor-relevance";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";
const EVENT_TYPES = new Set([
  "street_food",
  "city_festival",
  "market",
  "sports",
  "christmas",
  "private"
]);

const FEDERAL_STATES: Record<string, string> = {
  amberg: "Bayern",
  asbach: "Rheinland-Pfalz",
  badbreisig: "Rheinland-Pfalz",
  badschwalbach: "Hessen",
  baesweiler: "Nordrhein-Westfalen",
  balingen: "Baden-Württemberg",
  bayreuth: "Bayern",
  bendorf: "Rheinland-Pfalz",
  bergheim: "Nordrhein-Westfalen",
  betzdorf: "Rheinland-Pfalz",
  bonen: "Nordrhein-Westfalen",
  borken: "Nordrhein-Westfalen",
  coburg: "Bayern",
  coesfeld: "Nordrhein-Westfalen",
  darmstadt: "Hessen",
  dinkelsbuhl: "Bayern",
  dresden: "Sachsen",
  duisburgbucholz: "Nordrhein-Westfalen",
  erlangen: "Bayern",
  forchheim: "Bayern",
  grefrath: "Nordrhein-Westfalen",
  heidenau: "Sachsen",
  hof: "Bayern",
  hoxter: "Nordrhein-Westfalen",
  kirchlengern: "Nordrhein-Westfalen",
  kreuztal: "Nordrhein-Westfalen",
  lahstein: "Rheinland-Pfalz",
  lahnstein: "Rheinland-Pfalz",
  langen: "Hessen",
  laufanderpegnitz: "Bayern",
  linzamrhein: "Rheinland-Pfalz",
  ludenscheid: "Nordrhein-Westfalen",
  nettetalhinsbeck: "Nordrhein-Westfalen",
  neuotting: "Bayern",
  oberasbach: "Bayern",
  oberhausen: "Nordrhein-Westfalen",
  oberhausensterkrade: "Nordrhein-Westfalen",
  parsberg: "Bayern",
  plauen: "Sachsen",
  remscheid: "Nordrhein-Westfalen",
  rheine: "Nordrhein-Westfalen",
  sanktaugustin: "Nordrhein-Westfalen",
  siegen: "Nordrhein-Westfalen",
  singen: "Baden-Württemberg",
  stadtallendorf: "Hessen",
  stgoarshausen: "Rheinland-Pfalz",
  suhl: "Thüringen"
};

export type NormalizationState = "linked" | "ignored" | "rejected";

export interface RawOccurrence {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceBaseUrl: string;
  sourceKind: string;
  sourceLayer: string;
  sourceRecordKey?: string;
  rawName: string;
  rawLocation?: string;
  rawStartsAt?: string;
  rawEndsAt?: string;
  rawPayload: Record<string, unknown>;
  contentHash: string;
  observedAt: string;
}

export interface CanonicalCandidate {
  name: string;
  city: string;
  federalState: string;
  startsAt: string;
  endsAt: string;
  eventType: string;
  organizerName: string;
  organizerWebsite: string;
  eventUrl: string;
  applicationUrl?: string;
  applicationDeadline?: string;
  applicationRoute: "public_form" | "operator_network";
  applicationNote: string;
  verification: "partial";
  missingFields: string[];
  /**
   * Whether this occurrence is a food-vendor opportunity at all. A municipal
   * calendar publishes guided tours and lectures in the same feed as markets,
   * so the verdict is recorded per event rather than inferred from eventType —
   * which defaults to "street_food" below and therefore proves nothing.
   */
  vendorRelevance: VendorRelevance;
}

export type NormalizationDecision =
  | { state: "linked"; note: string; candidate: CanonicalCandidate }
  | { state: "ignored" | "rejected"; note: string };

type RawOccurrenceRow = QueryResultRow & {
  id: string;
  source_id: string;
  source_name: string;
  source_base_url: string;
  source_kind: string;
  source_layer: string;
  source_record_key: string | null;
  raw_name: string;
  raw_location: string | null;
  raw_starts_at: string | null;
  raw_ends_at: string | null;
  raw_payload: Record<string, unknown>;
  content_hash: string;
  observed_at: Date | string;
};

export interface NormalizationRun {
  startedAt: string;
  completedAt: string;
  selected: number;
  linked: number;
  created: number;
  matched: number;
  ignored: number;
  rejected: number;
}

function cleanKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "");
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function venuePayload(payload: Record<string, unknown>) {
  return payload.venue && typeof payload.venue === "object"
    ? payload.venue as Record<string, unknown>
    : {};
}

/**
 * Resolve the city, refusing venue strings.
 *
 * A source's "location" is sometimes the town and sometimes the square inside
 * it, and the two arrive in the same field. Candidates that read as a venue
 * ("Kirchplatz", "Vorplatz Einkaufszentrum", "Alter Messplatz Landau") are
 * dropped from the chain rather than accepted, so the next candidate — or the
 * name-derived fallback, or an honest refusal — gets its turn. A known city
 * always wins: the venue test never sees "Halle" or "Frankfurt (Oder)".
 *
 * `venueRejected` reports whether anything was dropped, so the caller can give
 * the specific reason instead of the generic "missing city" one.
 */
function inferredCity(occurrence: RawOccurrence): {
  city?: string;
  venueRejected: boolean;
} {
  const venue = venuePayload(occurrence.rawPayload);
  const rawCandidates = [
    stringValue(occurrence.rawPayload.city),
    stringValue(venue.city),
    occurrence.rawLocation?.split(",").map((part) => part.trim())
      .filter((part) => /[A-Za-zÄÖÜäöüß]/.test(part))
      .at(-1)
  ].filter((candidate): candidate is string => Boolean(candidate) && !/^\d+$/.test(candidate!));

  // A candidate already in the known-city map is a city, full stop.
  const known = rawCandidates.find((candidate) => FEDERAL_STATES[cleanKey(candidate)]);
  if (known) return { city: known, venueRejected: false };

  const usable = rawCandidates.filter((candidate) => !isVenueString(candidate));
  const venueRejected = usable.length < rawCandidates.length;
  const direct = usable[0];

  const fromName = occurrence.rawName
    .replace(/\b20\d{2}\b/g, "")
    .replace(/^(?:Schummeltag\s+)?(?:Street\s+Food|Food\s+Truck|Foodtruckmeile)(?:\s+Drink\s+&\s+Music)?\s+Festival\s*/i, "")
    .replace(/^Foodtruckmeile\s+/i, "")
    .trim();
  if (fromName && FEDERAL_STATES[cleanKey(fromName)]) {
    return { city: fromName, venueRejected };
  }

  const fallback = direct || (fromName && !isVenueString(fromName) ? fromName : undefined);
  return { city: fallback, venueRejected };
}

function dateParts(value: string) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] || 0),
    minute: Number(match[5] || 0),
    second: Number(match[6] || 0),
    hasTime: Boolean(match[4])
  };
}

function berlinInstant(value: string, endOfDay = false) {
  const parts = dateParts(value);
  if (!parts) return undefined;
  if (endOfDay && !parts.hasTime) {
    parts.hour = 23;
    parts.minute = 59;
    parts.second = 59;
  }
  const assumedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const displayed = Object.fromEntries(
    formatter.formatToParts(new Date(assumedUtc))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const offset = Date.UTC(
    displayed.year,
    displayed.month - 1,
    displayed.day,
    displayed.hour,
    displayed.minute,
    displayed.second
  ) - assumedUtc;
  return new Date(assumedUtc - offset).toISOString();
}

function isOutsideGermany(occurrence: RawOccurrence, city: string) {
  const venue = venuePayload(occurrence.rawPayload);
  const country = stringValue(venue.country) || stringValue(occurrence.rawPayload.country);
  if (country && !/^(?:de|deu|germany|deutschland)$/i.test(country)) return true;
  if (FEDERAL_STATES[cleanKey(city)]) return false;
  const location = occurrence.rawLocation || "";
  return /\b\d{4}\b/.test(location) && !/\b\d{5}\b/.test(location);
}

function organizerName(occurrence: RawOccurrence) {
  return stringValue(occurrence.rawPayload.routeOwner) || occurrence.sourceName;
}

function applicationRoute(occurrence: RawOccurrence): CanonicalCandidate["applicationRoute"] {
  return occurrence.sourceKind === "trader_portal" ? "public_form" : "operator_network";
}

export function normalizeOccurrence(
  occurrence: RawOccurrence,
  now = new Date()
): NormalizationDecision {
  const { city, venueRejected } = inferredCity(occurrence);
  const startsAt = occurrence.rawStartsAt ? berlinInstant(occurrence.rawStartsAt) : undefined;
  const endsAt = occurrence.rawEndsAt ? berlinInstant(occurrence.rawEndsAt, true) : undefined;
  if (!city && venueRejected && startsAt && endsAt) {
    // The row had a location, but it named a venue rather than a place. That is
    // a different failure from "no location at all", and it is kept as ignored
    // with the specific reason instead of being given an invented city.
    return { state: "ignored", note: NO_VERIFIABLE_CITY_NOTE };
  }
  if (!city || !startsAt || !endsAt) {
    return {
      state: "rejected",
      note: "The source row is missing a usable German city or event date."
    };
  }
  if (isOutsideGermany(occurrence, city)) {
    return { state: "ignored", note: "The event is outside Germany." };
  }
  const today = now.toISOString().slice(0, 10);
  if (endsAt.slice(0, 10) < today) {
    return { state: "ignored", note: "The event ended before the current planning window." };
  }

  const eventUrl = stringValue(occurrence.rawPayload.eventUrl)
    || stringValue(occurrence.rawPayload.url)
    || occurrence.sourceBaseUrl;
  const applicationUrl = stringValue(occurrence.rawPayload.applicationUrl);
  const deadline = stringValue(occurrence.rawPayload.applicationDeadline);
  const state = FEDERAL_STATES[cleanKey(city)] || "Federal state unverified";
  const missingFields = [
    "Event-specific speciality capacity",
    "Pitch fee",
    "Expected visitors",
    "Power and water requirements",
    "Organizer contact"
  ];
  if (state === "Federal state unverified") missingFields.push("Federal state");
  if (!dateParts(occurrence.rawStartsAt || "")?.hasTime) missingFields.push("Opening hours");

  const eventType = EVENT_TYPES.has(String(occurrence.rawPayload.eventType))
    ? String(occurrence.rawPayload.eventType)
    : "street_food";
  const vendorRelevance = classifyVendorRelevance(
    occurrence.rawName,
    eventType,
    stringValue(occurrence.rawPayload.description)
  );

  return {
    state: "linked",
    note: "Normalized from an official source occurrence; vendor capacity remains unverified.",
    candidate: {
      name: occurrence.rawName.trim(),
      city,
      federalState: state,
      startsAt,
      endsAt,
      eventType,
      organizerName: organizerName(occurrence),
      organizerWebsite: occurrence.sourceBaseUrl,
      eventUrl,
      applicationUrl,
      applicationDeadline: deadline,
      applicationRoute: applicationRoute(occurrence),
      applicationNote: applicationUrl
        ? "A general organizer application route exists; event-specific speciality capacity has not been confirmed."
        : "No current public application route has been verified for this event.",
      verification: "partial",
      missingFields,
      vendorRelevance
    }
  };
}

function matchName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    // German event names write the same compound both ways — "Streetfood
    // Festival" and "Street Food Festival" are one event, not two. The token
    // comparison below cannot see inside a word, so the compounds are split to
    // their two-word form BEFORE tokenizing. This is reverse-safe by
    // construction: both spellings normalize to the split form, so the rule
    // never depends on which spelling a given source happened to publish.
    // Symptom it fixes: "Street Food Drink & Music Festival Sankt Augustin" vs
    // "Streetfood Drink & Music Festival Sankt Augustin" scored 0.625 — below
    // the 0.65 dedup gate — and ranked as two separate opportunities.
    .replace(/\bstreetfoods?\b/g, "street food")
    .replace(/\bfoodtrucks?\b/g, "food truck")
    .replace(/\bdresdner\b/g, "dresden")
    .replace(/\bcity\b/g, "stadt")
    .replace(/\bstadtfest\b/g, "stadt fest")
    .replace(/\bfestival\b/g, "fest")
    .replace(/\b(das|der|die|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameMatchConfidence(left: string, right: string) {
  const a = matchName(left);
  const b = matchName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const leftTokens = new Set(a.split(" "));
  const rightTokens = new Set(b.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function asOccurrence(row: RawOccurrenceRow): RawOccurrence {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceBaseUrl: row.source_base_url,
    sourceKind: row.source_kind,
    sourceLayer: row.source_layer,
    sourceRecordKey: row.source_record_key ?? undefined,
    rawName: row.raw_name,
    rawLocation: row.raw_location ?? undefined,
    rawStartsAt: row.raw_starts_at ?? undefined,
    rawEndsAt: row.raw_ends_at ?? undefined,
    rawPayload: row.raw_payload,
    contentHash: row.content_hash,
    observedAt: new Date(row.observed_at).toISOString()
  };
}

/**
 * Exported for `server/dedup.test.ts` only. The behaviour is unchanged: the
 * cross-source dedup suite drives the real city/date query and the real 0.65
 * name-confidence gate against mocked rows, and a module-private function
 * cannot be driven at all.
 */
export async function findMatchingEvent(client: PoolClient, candidate: CanonicalCandidate) {
  const result = await client.query<{
    id: string;
    canonical_name: string;
  }>(
    `select id, canonical_name
     from events
     where tenant_id = $1
       and lower(city) = lower($2)
       and (starts_at at time zone 'Europe/Berlin')::date = $3::date`,
    [TENANT_ID, candidate.city, candidate.startsAt.slice(0, 10)]
  );
  const candidates = result.rows
    .map((row) => ({ ...row, confidence: nameMatchConfidence(row.canonical_name, candidate.name) }))
    .filter((row) => row.confidence >= 0.65)
    .sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

/** Exported for `server/dedup.test.ts` only; behaviour unchanged. */
export async function findLinkedEvent(client: PoolClient, occurrenceId: string) {
  const result = await client.query<{ id: string; canonical_name: string }>(
    `select event.id, event.canonical_name
     from event_source_links link
     join events event on event.id = link.event_id
     where link.raw_occurrence_id = $1 and event.tenant_id = $2
     limit 1`,
    [occurrenceId, TENANT_ID]
  );
  return result.rows[0]
    ? { ...result.rows[0], confidence: 1 }
    : undefined;
}

async function upsertOrganizer(client: PoolClient, candidate: CanonicalCandidate) {
  const result = await client.query<{ id: string }>(
    `insert into organizers (
      canonical_name, organizer_type, website_url, verification, notes, updated_at
    ) values ($1,'festival_operator',$2,'partial',$3,now())
    on conflict (canonical_name) do update set
      website_url = coalesce(organizers.website_url, excluded.website_url),
      updated_at = now()
    returning id`,
    [
      candidate.organizerName,
      candidate.organizerWebsite,
      "Organizer identity is sourced from its own tour or application portal; direct contact remains to be verified."
    ]
  );
  return result.rows[0].id;
}

async function createEvent(
  client: PoolClient,
  occurrence: RawOccurrence,
  candidate: CanonicalCandidate,
  organizerId: string
) {
  const externalId = `discovery:${occurrence.sourceId}:${createHash("sha256")
    .update(occurrence.sourceRecordKey || occurrence.contentHash)
    .digest("hex")
    .slice(0, 16)}`;
  const result = await client.query<{ id: string }>(
    `insert into events (
      tenant_id, external_id, canonical_name, city, federal_state, starts_at, ends_at,
      event_type, organizer_id, organizer_name, verification, application_status,
      application_deadline, application_url, fit_signals, risk_signals, missing_fields,
      pipeline, last_verified_at, vendor_relevance, updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'partial','unknown',$11,$12,
      $13,$14,$15,'discovered',$16,$17,now()
    )
    on conflict (tenant_id, canonical_name, starts_at, city) do update set
      vendor_relevance = excluded.vendor_relevance,
      updated_at = now()
    returning id`,
    [
      TENANT_ID,
      externalId,
      candidate.name,
      candidate.city,
      candidate.federalState,
      candidate.startsAt,
      candidate.endsAt,
      candidate.eventType,
      organizerId,
      candidate.organizerName,
      candidate.applicationDeadline ?? null,
      candidate.applicationUrl ?? null,
      ["Official event occurrence found", "Multi-day trading opportunity"],
      ["Vendor-category capacity is not confirmed"],
      candidate.missingFields,
      occurrence.observedAt,
      candidate.vendorRelevance
    ]
  );
  return result.rows[0].id;
}

async function refreshDiscoveryEvent(
  client: PoolClient,
  eventId: string,
  occurrence: RawOccurrence,
  candidate: CanonicalCandidate,
  organizerId: string
) {
  await client.query(
    `update events set
      canonical_name = $2,
      city = $3,
      federal_state = $4,
      starts_at = $5,
      ends_at = $6,
      event_type = $7,
      organizer_id = $8,
      organizer_name = $9,
      application_deadline = coalesce($10, application_deadline),
      application_url = coalesce($11, application_url),
      missing_fields = $12,
      last_verified_at = greatest(coalesce(last_verified_at, $13), $13),
      vendor_relevance = $14,
      updated_at = now()
     where id = $1
       and external_id like 'discovery:%'
       and verification <> 'verified'`,
    [
      eventId,
      candidate.name,
      candidate.city,
      candidate.federalState,
      candidate.startsAt,
      candidate.endsAt,
      candidate.eventType,
      organizerId,
      candidate.organizerName,
      candidate.applicationDeadline ?? null,
      candidate.applicationUrl ?? null,
      candidate.missingFields,
      occurrence.observedAt,
      candidate.vendorRelevance
    ]
  );
}

async function storeEvidence(
  client: PoolClient,
  occurrence: RawOccurrence,
  candidate: CanonicalCandidate,
  eventId: string
) {
  const supports = ["event name", "event dates", "city", "event occurrence"];
  if (candidate.applicationUrl) supports.push("general application route");
  const result = await client.query<{ id: string }>(
    `insert into event_evidence (
      event_id, source_id, source_url, publisher, is_official, observed_at,
      supports_fields, evidence_excerpt, content_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (event_id, content_hash) where content_hash is not null
    do update set
      source_url = excluded.source_url,
      observed_at = greatest(event_evidence.observed_at, excluded.observed_at),
      supports_fields = excluded.supports_fields,
      evidence_excerpt = excluded.evidence_excerpt
    returning id`,
    [
      eventId,
      occurrence.sourceId,
      candidate.eventUrl,
      occurrence.sourceName,
      ["organizer", "trader_portal", "municipal", "official_service"].includes(occurrence.sourceKind),
      occurrence.observedAt,
      supports,
      candidate.applicationUrl
        ? "Official occurrence plus a general application route; no category availability claim."
        : "Official event occurrence; application route not verified.",
      occurrence.contentHash
    ]
  );
  return result.rows[0].id;
}

async function storeApplicationWindow(
  client: PoolClient,
  occurrence: RawOccurrence,
  candidate: CanonicalCandidate,
  eventId: string,
  evidenceId: string
) {
  if (!candidate.applicationUrl) return;
  const nextCheck = new Date(occurrence.observedAt);
  nextCheck.setUTCDate(nextCheck.getUTCDate() + 7);
  await client.query(
    `insert into application_windows (
      event_id, route_type, capacity, deadline_at, route_owner, application_url,
      status_note, last_checked_at, next_check_at, evidence_id
    ) values ($1,$2,'unknown',$3,$4,$5,$6,$7,$8,$9)
    on conflict (event_id) do update set
      route_type = excluded.route_type,
      deadline_at = coalesce(excluded.deadline_at, application_windows.deadline_at),
      route_owner = coalesce(excluded.route_owner, application_windows.route_owner),
      application_url = coalesce(excluded.application_url, application_windows.application_url),
      status_note = case
        when application_windows.capacity = 'unknown' then excluded.status_note
        else application_windows.status_note
      end,
      last_checked_at = greatest(application_windows.last_checked_at, excluded.last_checked_at),
      next_check_at = excluded.next_check_at,
      evidence_id = excluded.evidence_id,
      updated_at = now()`,
    [
      eventId,
      candidate.applicationRoute,
      candidate.applicationDeadline
        ? `${candidate.applicationDeadline}T23:59:59+01:00`
        : null,
      candidate.organizerName,
      candidate.applicationUrl,
      candidate.applicationNote,
      occurrence.observedAt,
      nextCheck.toISOString(),
      evidenceId
    ]
  );
}

async function markOccurrence(
  client: PoolClient,
  id: string,
  state: NormalizationState,
  note: string
) {
  await client.query(
    `update raw_event_occurrences
     set normalization_state = $2, normalized_at = now(), normalization_note = $3
     where id = $1`,
    [id, state, note]
  );
}

export async function normalizePendingOccurrences(options: {
  limit?: number;
  now?: Date;
} = {}): Promise<NormalizationRun> {
  if (!databaseConfigured()) {
    throw new Error("PostgreSQL is required for durable event normalization.");
  }
  const startedAt = new Date().toISOString();
  const now = options.now || new Date();
  const counts = await withDatabaseTransaction(async (client) => {
    const result = await client.query<RawOccurrenceRow>(
      `select raw.id, raw.source_id, source.name as source_name,
        source.base_url as source_base_url, source.source_kind, source.source_layer,
        raw.source_record_key, raw.raw_name, raw.raw_location, raw.raw_starts_at,
        raw.raw_ends_at, raw.raw_payload, raw.content_hash, raw.observed_at
       from raw_event_occurrences raw
       join registered_sources source on source.id = raw.source_id
       where raw.normalization_state = 'pending'
       order by raw.observed_at, raw.id
       limit $1
       for update of raw skip locked`,
      [Math.max(1, Math.min(options.limit || 500, 2_000))]
    );
    const summary = {
      selected: result.rows.length,
      linked: 0,
      created: 0,
      matched: 0,
      ignored: 0,
      rejected: 0
    };

    for (const row of result.rows) {
      const occurrence = asOccurrence(row);
      const decision = normalizeOccurrence(occurrence, now);
      if (decision.state !== "linked") {
        summary[decision.state] += 1;
        await markOccurrence(client, occurrence.id, decision.state, decision.note);
        continue;
      }

      const organizerId = await upsertOrganizer(client, decision.candidate);
      const previouslyLinked = await findLinkedEvent(client, occurrence.id);
      const matched = previouslyLinked
        || await findMatchingEvent(client, decision.candidate);
      const eventId = matched?.id
        || await createEvent(client, occurrence, decision.candidate, organizerId);
      if (previouslyLinked) {
        await refreshDiscoveryEvent(
          client,
          eventId,
          occurrence,
          decision.candidate,
          organizerId
        );
      }
      const evidenceId = await storeEvidence(
        client,
        occurrence,
        decision.candidate,
        eventId
      );
      await storeApplicationWindow(
        client,
        occurrence,
        decision.candidate,
        eventId,
        evidenceId
      );
      await client.query(
        `insert into event_source_links (
          raw_occurrence_id, event_id, match_method, match_confidence
        ) values ($1,$2,$3,$4)
        on conflict (raw_occurrence_id, event_id) do nothing`,
        [
          occurrence.id,
          eventId,
          matched ? (matched.confidence === 1 ? "exact" : "rules") : "exact",
          matched?.confidence ?? 1
        ]
      );
      await markOccurrence(client, occurrence.id, "linked", decision.note);
      summary.linked += 1;
      summary[matched ? "matched" : "created"] += 1;
    }
    return summary;
  });

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    ...counts
  };
}
