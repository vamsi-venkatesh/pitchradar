import { clientBookings } from "../src/bookings";
import { eventLeads } from "../src/events";
import { clientProfile, missingProfileInputs } from "../src/profile";
import type { RegisteredSource } from "../src/source-registry";
import { sourceRegistry } from "../src/source-registry";
import type {
  ApplicationIntelligence,
  AvailabilityVerificationRequest,
  ClientBooking,
  ClientProfile,
  EventOpportunity,
  SourceEvidence
} from "../src/types";
import { databaseConfigured, withDatabaseTransaction } from "./database";
import { berlinDayKey, daysBetweenDayKeys, type DeadlineEvidence } from "./deadline-monitor";
import { currentProfileTruth, recomputeMissingInputs, type IntakeRecord } from "./profile";
import type {
  CatalogueEventOpportunity,
  CatalogueSnapshot,
  DeadlineAlertView,
  EventWeatherView
} from "./types";
import { asVendorRelevance, classifyVendorRelevance } from "./vendor-relevance";
import type { WeatherRiskFlag } from "./weather";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

type ProfileRow = {
  home_region: string;
  home_postcode: string | null;
  normal_days: number[];
  optional_thursday: boolean;
  preferred_max_travel_minutes: number;
  exceptional_max_travel_minutes: number;
  menu: ClientProfile["menu"];
  operating_inputs: ClientProfile["operatingInputs"];
  missing_inputs: string[];
  /** Migration 011. Absent on rows read before the intake shipped. */
  intake?: unknown;
  menu_confirmed_at?: Date | string | null;
};

type SourceRow = {
  id: string;
  name: string;
  base_url: string;
  source_kind: RegisteredSource["kind"];
  source_layer: RegisteredSource["layer"];
  official_for: string[];
  extraction_mode: RegisteredSource["extractionMode"];
  priority: RegisteredSource["priority"];
  cadence: RegisteredSource["cadence"];
  trust_rule: string;
  business_value: string;
  last_checked_at: Date | string | null;
  last_success_at: Date | string | null;
  last_http_status: number | null;
};

type EvidenceRow = {
  owner_id: string;
  label: string | null;
  source_url: string;
  publisher: string;
  is_official: boolean;
  observed_at: Date | string;
  supports_fields: string[];
};

type EventRow = {
  db_id: string;
  external_id: string;
  canonical_name: string;
  city: string;
  federal_state: string;
  starts_at: Date | string;
  ends_at: Date | string;
  event_type: EventOpportunity["eventType"];
  verification: EventOpportunity["verification"];
  application_status: EventOpportunity["applicationState"];
  application_deadline: Date | string | null;
  application_url: string | null;
  organizer_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  // Optional on the type, always present in the query: a row assembled by a
  // test (or read before migration 015 has run) must degrade to "no named
  // contact", never crash the catalogue read.
  contact_person?: string | null;
  contact_role?: string | null;
  contact_source_url?: string | null;
  contact_observed_at?: Date | null;
  expected_visitors: number | null;
  pitch_fee_eur: string | number | null;
  travel_minutes: number | null;
  travel_km: string | number | null;
  infrastructure: EventOpportunity["infrastructure"];
  fit_signals: string[];
  risk_signals: string[];
  missing_fields: string[];
  /** Absent until migration 014 has run; read defensively below. */
  vendor_relevance?: string | null;
  current_score: number | null;
  current_tier: EventOpportunity["tier"] | null;
  score_breakdown: Record<string, number> | null;
  pipeline: EventOpportunity["pipeline"];
  route_type: ApplicationIntelligence["route"] | null;
  capacity: ApplicationIntelligence["capacityState"] | null;
  opens_at: Date | string | null;
  deadline_at: Date | string | null;
  expected_next_window: string | null;
  route_owner: string | null;
  window_application_url: string | null;
  status_note: string | null;
  last_checked_at: Date | string | null;
  next_check_at: Date | string | null;
  route_scope: ApplicationIntelligence["routeScope"] | null;
  route_reachable: boolean | null;
  requirements: string[] | null;
  application_source_url: string | null;
  /** Migration 012. Null on rows read before it ran. */
  deadline_evidence?: DeadlineEvidence | null;
  /** Migration 013. The most recent stored forecast, if any. */
  weather_fetched_at?: Date | string | null;
  weather_source?: string | null;
  weather_risk_flags?: string[] | null;
  weather_forecast?: { geocodePrecision?: string; summary?: EventWeatherView["summary"] } | null;
};

type DeadlineAlertRow = {
  id: string;
  event_id: string;
  event_name: string;
  city: string;
  deadline_at: Date | string;
  threshold_days: number;
  alert_state: "pending" | "surfaced";
  created_at: Date | string;
};

type BookingRow = {
  db_id: string;
  external_id: string;
  event_name: string;
  city: string;
  federal_state: string;
  starts_at: Date | string;
  ends_at: Date | string;
  booking_state: ClientBooking["bookingState"];
  organizer_name: string | null;
  operating_partner_name: string | null;
  relationship_note: string;
  stand_or_zone: string | null;
  confirmed_facts: string[];
  missing_outcome_inputs: string[];
  /** Trading days the owner has captured an outcome for. Never null. */
  outcomes_recorded?: number | null;
};

type DiscoveryRow = {
  raw_occurrences: number;
  pending: number;
  linked: number;
  ignored: number;
  rejected: number;
  last_observed_at: Date | string | null;
};

type VerificationQueueRow = {
  id: string;
  event_external_id: string;
  event_name: string;
  city: string;
  starts_at: Date | string;
  ends_at: Date | string;
  week_key: string;
  weekly_role: AvailabilityVerificationRequest["weeklyRole"];
  channel: AvailabilityVerificationRequest["channel"];
  status: AvailabilityVerificationRequest["status"];
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  application_url: string | null;
  route_verified: boolean;
  subject: string;
  draft_de: string;
  draft_en: string;
  verification_questions: string[];
  approval_required: true;
  approved_at: Date | string | null;
  approved_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateOnly(value: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/**
 * A PostgreSQL `date` arrives as a JS Date built from LOCAL calendar parts, so
 * reading it back through toISOString() can slide it a day backwards east of
 * UTC. Deadlines are read from the local components instead.
 */
function dateColumn(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function numberOrUndefined(value: string | number | null) {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sourceHealthState(source: SourceRow): RegisteredSource["healthState"] {
  if (!source.last_checked_at) return "never_checked";
  if (source.last_http_status === null) return "unavailable";
  if ([401, 403, 429].includes(source.last_http_status)) return "restricted";
  if ([404, 410].includes(source.last_http_status)) return "broken";
  if (source.last_http_status >= 400) return "degraded";
  return "healthy";
}

function groupEvidence(rows: EvidenceRow[]) {
  const grouped = new Map<string, SourceEvidence[]>();
  for (const row of rows) {
    const evidence: SourceEvidence = {
      label: row.label || row.publisher,
      url: row.source_url,
      publisher: row.publisher,
      official: row.is_official,
      observedAt: iso(row.observed_at),
      supports: row.supports_fields || []
    };
    grouped.set(row.owner_id, [...(grouped.get(row.owner_id) || []), evidence]);
  }
  return grouped;
}

export function fixtureProductSnapshot(): CatalogueSnapshot {
  return {
    mode: "fixtures",
    loadedAt: new Date().toISOString(),
    // The fixture leads predate the vendor-relevance column, so they carry no
    // stored verdict. It is derived here by the same deterministic classifier
    // the normalizer runs on database rows, rather than hand-written into each
    // fixture: one rule decides relevance everywhere, and the committed sample
    // report therefore exercises the real classifier instead of a transcription
    // of it. Any verdict a fixture does record is respected.
    events: eventLeads.map((event) => ({
      ...event,
      vendorRelevance:
        event.vendorRelevance ?? classifyVendorRelevance(event.name, event.eventType)
    })),
    bookings: clientBookings,
    profile: clientProfile,
    missingProfileInputs,
    sources: sourceRegistry,
    discovery: {
      rawOccurrences: 0,
      pending: 0,
      linked: 0,
      ignored: 0,
      rejected: 0
    },
    verificationQueue: [],
    alerts: []
  };
}

/**
 * The client intake is the only source of truth for what is still missing.
 * Once migration 011 has run, the stored `missing_inputs` column is treated as
 * a cache and the answer is recomputed from the intake on every read, so the
 * dashboards and the agent can never report a stale gap list — including the
 * fact that the client has confirmed no menu line yet.
 *
 * Pre-011 rows carry no `intake` key at all (see the to_jsonb read below); for
 * those the stored column stands unchanged.
 */
function missingInputsFromRow(profile: ProfileRow) {
  if (profile.intake === undefined || profile.intake === null) return profile.missing_inputs;
  const menuConfirmedAt = profile.menu_confirmed_at
    ? profile.menu_confirmed_at instanceof Date
      ? profile.menu_confirmed_at.toISOString()
      : new Date(profile.menu_confirmed_at).toISOString()
    : null;
  return recomputeMissingInputs(profile.intake as IntakeRecord, menuConfirmedAt);
}

export function mapCatalogueRows(input: {
  profile: ProfileRow;
  sources: SourceRow[];
  events: EventRow[];
  eventEvidence: EvidenceRow[];
  bookings: BookingRow[];
  bookingEvidence: EvidenceRow[];
  discovery: DiscoveryRow;
  verificationQueue?: VerificationQueueRow[];
  deadlineAlerts?: DeadlineAlertRow[];
  /** Pinned in tests so "days remaining" can never rot on the wall clock. */
  now?: Date;
}): Omit<CatalogueSnapshot, "mode" | "loadedAt"> {
  const eventEvidence = groupEvidence(input.eventEvidence);
  const bookingEvidence = groupEvidence(input.bookingEvidence);
  const today = berlinDayKey(input.now ?? new Date());

  return {
    profile: {
      homeRegion: input.profile.home_region,
      homePostcode: input.profile.home_postcode ?? undefined,
      normalDays: input.profile.normal_days,
      optionalThursday: input.profile.optional_thursday,
      preferredMaxTravelMinutes: input.profile.preferred_max_travel_minutes,
      exceptionalMaxTravelMinutes: input.profile.exceptional_max_travel_minutes,
      menu: input.profile.menu,
      operatingInputs: input.profile.operating_inputs
    },
    missingProfileInputs: missingInputsFromRow(input.profile),
    discovery: {
      rawOccurrences: input.discovery.raw_occurrences,
      pending: input.discovery.pending,
      linked: input.discovery.linked,
      ignored: input.discovery.ignored,
      rejected: input.discovery.rejected,
      lastObservedAt: input.discovery.last_observed_at
        ? iso(input.discovery.last_observed_at)
        : undefined
    },
    sources: input.sources.map((source) => ({
      id: source.id,
      name: source.name,
      baseUrl: source.base_url,
      kind: source.source_kind,
      layer: source.source_layer,
      officialFor: source.official_for,
      extractionMode: source.extraction_mode,
      priority: source.priority,
      cadence: source.cadence,
      trustRule: source.trust_rule,
      businessValue: source.business_value,
      healthState: sourceHealthState(source),
      lastCheckedAt: source.last_checked_at ? iso(source.last_checked_at) : undefined,
      lastSuccessAt: source.last_success_at ? iso(source.last_success_at) : undefined,
      lastHttpStatus: source.last_http_status ?? undefined
    })),
    events: input.events.map((event) => {
      const application = event.route_type && event.capacity && event.last_checked_at && event.next_check_at
        ? {
            route: event.route_type,
            capacityState: event.capacity,
            opensAt: event.opens_at ? iso(event.opens_at) : undefined,
            deadline: event.deadline_at ? iso(event.deadline_at) : undefined,
            expectedNextWindow: event.expected_next_window ?? undefined,
            lastCheckedAt: iso(event.last_checked_at),
            nextCheckAt: iso(event.next_check_at),
            routeOwner: event.route_owner ?? undefined,
            routeScope: event.route_scope ?? undefined,
            routeReachable: event.route_reachable ?? undefined,
            requirements: event.requirements ?? [],
            sourceUrl: event.application_source_url ?? undefined,
            note: event.status_note || "Application state requires verification."
          }
        : undefined;
      const weather: EventWeatherView | undefined = event.weather_fetched_at && event.weather_source
        ? {
            fetchedAt: iso(event.weather_fetched_at),
            source: event.weather_source,
            riskFlags: (event.weather_risk_flags || []) as WeatherRiskFlag[],
            geocodePrecision: event.weather_forecast?.geocodePrecision,
            summary: event.weather_forecast?.summary
          }
        : undefined;
      const mapped: CatalogueEventOpportunity = {
        id: event.external_id,
        name: event.canonical_name,
        city: event.city,
        state: event.federal_state,
        startsAt: iso(event.starts_at),
        endsAt: iso(event.ends_at),
        eventType: event.event_type,
        verification: event.verification,
        applicationState: event.application_status,
        applicationDeadline: dateOnly(event.application_deadline),
        applicationUrl: event.window_application_url ?? event.application_url ?? undefined,
        application,
        organizer: event.organizer_name ?? undefined,
        contactEmail: event.contact_email ?? undefined,
        contactPhone: event.contact_phone ?? undefined,
        contactPerson: event.contact_person ?? undefined,
        contactRole: event.contact_role ?? undefined,
        contactSourceUrl: event.contact_source_url ?? undefined,
        contactObservedAt: event.contact_observed_at ? iso(event.contact_observed_at) : undefined,
        expectedVisitors: event.expected_visitors ?? undefined,
        pitchFeeEur: numberOrUndefined(event.pitch_fee_eur),
        travelMinutes: event.travel_minutes ?? undefined,
        travelKm: numberOrUndefined(event.travel_km),
        infrastructure: event.infrastructure || {},
        fitSignals: event.fit_signals || [],
        riskSignals: event.risk_signals || [],
        missingFields: event.missing_fields || [],
        vendorRelevance: asVendorRelevance(event.vendor_relevance),
        sources: eventEvidence.get(event.db_id) || [],
        pipeline: event.pipeline,
        score: event.current_score ?? undefined,
        tier: event.current_tier ?? undefined,
        scoreBreakdown: event.score_breakdown ?? undefined,
        deadlineEvidence: event.deadline_evidence ?? undefined,
        weather
      };
      return mapped;
    }),
    bookings: input.bookings.map((booking) => ({
      id: booking.external_id,
      eventName: booking.event_name,
      city: booking.city,
      state: booking.federal_state,
      startsAt: iso(booking.starts_at),
      endsAt: iso(booking.ends_at),
      bookingState: booking.booking_state,
      organizer: booking.organizer_name || "Organizer not recorded",
      operatingPartner: booking.operating_partner_name ?? undefined,
      relationshipNote: booking.relationship_note,
      standOrZone: booking.stand_or_zone ?? undefined,
      confirmedFacts: booking.confirmed_facts || [],
      missingOutcomeInputs: booking.missing_outcome_inputs || [],
      outcomesRecorded: booking.outcomes_recorded ?? 0,
      sources: bookingEvidence.get(booking.db_id) || []
    })),
    verificationQueue: (input.verificationQueue || []).map((request) => ({
      id: request.id,
      eventId: request.event_external_id,
      eventName: request.event_name,
      city: request.city,
      startsAt: iso(request.starts_at),
      endsAt: iso(request.ends_at),
      weekKey: request.week_key,
      weeklyRole: request.weekly_role,
      channel: request.channel,
      status: request.status,
      recipientName: request.recipient_name ?? undefined,
      recipientEmail: request.recipient_email ?? undefined,
      recipientPhone: request.recipient_phone ?? undefined,
      applicationUrl: request.application_url ?? undefined,
      routeVerified: request.route_verified,
      subject: request.subject,
      draftDe: request.draft_de,
      draftEn: request.draft_en,
      verificationQuestions: request.verification_questions || [],
      approvalRequired: true,
      approvedAt: request.approved_at ? iso(request.approved_at) : undefined,
      approvedBy: request.approved_by ?? undefined,
      createdAt: iso(request.created_at),
      updatedAt: iso(request.updated_at)
    })),
    alerts: (input.deadlineAlerts || []).map((alert) => {
      const deadline = dateColumn(alert.deadline_at);
      return {
        id: alert.id,
        eventId: alert.event_id,
        eventName: alert.event_name,
        city: alert.city,
        deadline,
        thresholdDays: alert.threshold_days,
        daysRemaining: daysBetweenDayKeys(today, deadline),
        alertState: alert.alert_state,
        createdAt: iso(alert.created_at)
      } satisfies DeadlineAlertView;
    })
  };
}

export async function loadProductSnapshot(): Promise<CatalogueSnapshot> {
  if (!databaseConfigured()) {
    // Without an operating database the intake still persists locally, so the
    // fixture snapshot must reflect the client's real answers rather than the
    // static gap list in src/profile.ts.
    const snapshot = fixtureProductSnapshot();
    const truth = await currentProfileTruth();
    return {
      ...snapshot,
      profile: { ...snapshot.profile, menu: truth.menu },
      missingProfileInputs: truth.missingInputs
    };
  }

  const rows = await withDatabaseTransaction(async (client) => {
    await client.query("set transaction isolation level repeatable read read only");
    const profileResult = await client.query<ProfileRow>(
      // The intake columns are read through to_jsonb(cp) on purpose: deploy
      // brings the new container up (gate 4) before it runs migrations (gate 5),
      // so for a few seconds this query runs against the pre-011 schema. A
      // missing key yields NULL here instead of "column does not exist", and
      // mapCatalogueRows then falls back to the stored missing_inputs column.
      `select cp.home_region, cp.home_postcode, cp.normal_days, cp.optional_thursday,
        cp.preferred_max_travel_minutes, cp.exceptional_max_travel_minutes,
        cp.menu, cp.operating_inputs, cp.missing_inputs,
        to_jsonb(cp) -> 'intake' as intake,
        to_jsonb(cp) ->> 'menu_confirmed_at' as menu_confirmed_at
       from client_profiles cp where cp.tenant_id = $1 and cp.profile_key = 'primary'`,
      [TENANT_ID]
    );
    const sourceResult = await client.query<SourceRow>(
      `select id, name, base_url, source_kind, source_layer, official_for,
        extraction_mode, priority, cadence, trust_rule, business_value,
        last_checked_at, last_success_at, last_http_status
       from registered_sources where enabled order by priority, name`
    );
    const eventResult = await client.query<EventRow>(
      `select e.id as db_id, e.external_id, e.canonical_name, e.city, e.federal_state,
        e.starts_at, e.ends_at, e.event_type, e.verification, e.application_status,
        e.application_deadline, e.application_url, e.organizer_name,
        contact.email as contact_email, contact.phone as contact_phone,
        contact.contact_name as contact_person, contact.responsibility as contact_role,
        contact.source_url as contact_source_url,
        contact.last_verified_at as contact_observed_at,
        e.expected_visitors, e.pitch_fee_eur, e.travel_minutes, e.travel_km,
        e.infrastructure, e.fit_signals, e.risk_signals, e.missing_fields,
        -- Read through to_jsonb for the same reason as the deadline evidence
        -- below: the container can come up minutes before migration 014 has
        -- run, and a missing column must degrade to "unclear", not to a crash.
        to_jsonb(e) ->> 'vendor_relevance' as vendor_relevance,
        e.current_score, e.current_tier, e.score_breakdown, e.pipeline,
        aw.route_type, aw.capacity, aw.opens_at, aw.deadline_at,
        aw.expected_next_window, aw.route_owner,
        aw.application_url as window_application_url, aw.status_note,
        aw.last_checked_at, aw.next_check_at, aw.route_scope,
        aw.route_reachable, aw.requirements,
        aw.source_url as application_source_url,
        -- Read through to_jsonb for the same reason as the profile query above:
        -- the container can come up minutes before migration 012 has run.
        to_jsonb(aw) ->> 'deadline_evidence' as deadline_evidence,
        weather.fetched_at as weather_fetched_at,
        weather.source as weather_source,
        weather.risk_flags as weather_risk_flags,
        weather.forecast as weather_forecast
       from events e
       left join application_windows aw on aw.event_id = e.id
       left join lateral (
         select ew.fetched_at, ew.source, ew.risk_flags, ew.forecast
         from event_weather ew
         where ew.event_id = e.id
         order by ew.fetched_at desc
         limit 1
       ) weather on true
       left join lateral (
         -- The MOST COMPLETE contact, not merely the newest. A row is ranked by
         -- how much of a route it carries — a person, an address, a number —
         -- so a freshly resolved row that names a person but has no email can
         -- never displace an older row that carries all three. Ties fall back
         -- to the freshest check. Fields are never mixed ACROSS rows: one row
         -- is one page of evidence, and a merged contact would have no source.
         select oc.email, oc.phone, oc.contact_name, oc.responsibility,
           oc.source_url, oc.last_verified_at
         from organizer_contacts oc
         where oc.organizer_id = e.organizer_id
         order by (
             (oc.contact_name is not null)::int
             + (oc.email is not null)::int
             + (oc.phone is not null)::int
           ) desc,
           (oc.contact_name is not null) desc,
           oc.last_verified_at desc
         limit 1
       ) contact on true
       where e.tenant_id = $1
       order by e.starts_at, e.canonical_name`,
      [TENANT_ID]
    );
    const eventEvidenceResult = await client.query<EvidenceRow>(
      `select event_id as owner_id, evidence_excerpt as label, source_url,
        publisher, is_official, observed_at, supports_fields
       from event_evidence
       where event_id in (select id from events where tenant_id = $1)
       order by created_at`,
      [TENANT_ID]
    );
    const bookingResult = await client.query<BookingRow>(
      `select b.id as db_id, b.external_id, b.event_name, b.city, b.federal_state,
        b.starts_at, b.ends_at, b.state as booking_state,
        organizer.canonical_name as organizer_name,
        partner.canonical_name as operating_partner_name,
        b.relationship_note, b.stand_or_zone, b.confirmed_facts,
        b.missing_outcome_inputs,
        (select count(*)::int from booking_outcomes o where o.booking_id = b.id)
          as outcomes_recorded
       from client_bookings b
       left join organizers organizer on organizer.id = b.organizer_id
       left join organizers partner on partner.id = b.operating_partner_id
       where b.tenant_id = $1
       order by b.starts_at`,
      [TENANT_ID]
    );
    const bookingEvidenceResult = await client.query<EvidenceRow>(
      `select booking_id as owner_id, label, source_url, publisher,
        is_official, observed_at, supports_fields
       from booking_evidence
       where booking_id in (select id from client_bookings where tenant_id = $1)
       order by observed_at`,
      [TENANT_ID]
    );
    const discoveryResult = await client.query<DiscoveryRow>(
      `select
        count(*)::int as raw_occurrences,
        count(*) filter (where normalization_state = 'pending')::int as pending,
        count(*) filter (where normalization_state = 'linked')::int as linked,
        count(*) filter (where normalization_state = 'ignored')::int as ignored,
        count(*) filter (where normalization_state = 'rejected')::int as rejected,
        max(observed_at) as last_observed_at
       from raw_event_occurrences`
    );
    const verificationQueueResult = await client.query<VerificationQueueRow>(
      `select request.id, event.external_id as event_external_id,
        event.canonical_name as event_name, event.city, event.starts_at, event.ends_at,
        request.week_key, request.weekly_role, request.channel, request.status,
        request.recipient_name, request.recipient_email, request.recipient_phone,
        request.application_url, request.route_verified, request.subject,
        request.draft_de, request.draft_en, request.verification_questions,
        request.approval_required, request.approved_at, request.approved_by,
        request.created_at, request.updated_at
       from availability_verification_requests request
       join events event on event.id = request.event_id
       where request.tenant_id = $1
         and request.status <> 'cancelled'
         and event.ends_at >= now()
       order by request.week_key,
         case request.weekly_role
           when 'primary' then 1
           when 'backup' then 2
           else 3
         end,
         event.starts_at,
         event.canonical_name`,
      [TENANT_ID]
    );
    const deadlineAlertResult = await client.query<DeadlineAlertRow>(
      `select a.id, a.event_id, e.canonical_name as event_name, e.city,
        a.deadline_at, a.threshold_days, a.alert_state, a.created_at
       from deadline_alerts a
       join events e on e.id = a.event_id
       where a.tenant_id = $1
         and a.alert_state = 'pending'
         and e.ends_at >= now()
       order by a.deadline_at, a.threshold_days`,
      [TENANT_ID]
    );
    return {
      profile: profileResult.rows[0],
      sources: sourceResult.rows,
      events: eventResult.rows,
      eventEvidence: eventEvidenceResult.rows,
      bookings: bookingResult.rows,
      bookingEvidence: bookingEvidenceResult.rows,
      discovery: discoveryResult.rows[0],
      verificationQueue: verificationQueueResult.rows,
      deadlineAlerts: deadlineAlertResult.rows
    };
  });

  if (!rows.profile) {
    throw new Error("PitchRadar operating profile is missing from PostgreSQL. Run the seed command before starting the product.");
  }

  return {
    mode: "postgres",
    loadedAt: new Date().toISOString(),
    ...mapCatalogueRows({
      ...rows,
      profile: rows.profile
    })
  };
}
