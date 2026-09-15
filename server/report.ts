/**
 * PitchRadar — the weekly decision product.
 *
 * ONE question governs everything in this file:
 *
 *     "Where should we try to get the truck booked next,
 *      and what do we need to do now?"
 *
 * One deterministic pass over a ProductSnapshot produces a typed report object
 * carrying both the facts and the DERIVED DECISION FIELDS (recommendation,
 * confidence, pipeline label, required action, why it fits). Two renderers turn
 * that object into the two artifacts the owner actually uses:
 *
 *   1. THE BRIEF   — `renderBriefHtml`, 2–4 A4 pages. What to do, in order.
 *   2. THE REGISTER — `renderRegisterXlsx`, the operational workbook. Every
 *      non-irrelevant event, every score component, every draft, every source.
 *
 * Nothing moves from the register to nowhere: evidence that leaves the brief
 * lands in a workbook sheet. The brief is a decision; the register is the
 * audit trail. Neither invents a fact — where one is missing, the report says
 * so in words instead of estimating it.
 *
 * Determinism is a hard requirement — the same snapshot and the same injected
 * `now` must produce byte-identical HTML. No Date.now(), no locale defaults, no
 * snapshot.loadedAt (the fixture snapshot stamps that at read time).
 */

import { createRequire } from "node:module";
import { applicationDecision, applicationIntelligenceFor, type ApplicationPhase } from "../src/application-intelligence";
import { rankOpportunities, tradingDays as tradingDaysOf, vendorRelevanceOf, VENDOR_UNCLEAR_TAG } from "../src/ranking";
import type {
  ClientBooking,
  EventOpportunity,
  OpportunityTier,
  PipelineState,
  VendorRelevance
} from "../src/types";
import { isVenueString, LOCATION_NEEDS_VERIFICATION } from "./city-hygiene";
import { groupByCalendarWeek, type WeeklyRole } from "../src/week-planning";
import type { CatalogueMode, ProductSnapshot } from "../src/product-data";
import { createVerificationDraft } from "./outreach";
import {
  bookingLifecycleFor,
  bookingHoldsTruck,
  type BookingLifecycle
} from "../src/booking-state";
import type {
  ActionLabel,
  ActionSeverity,
  BriefingKpis,
  BriefingOrganizer,
  BriefingView,
  ConfidenceLevel,
  PipelineLabel,
  Recommendation
} from "../src/briefing";
import {
  buildActionTasks,
  buildSeriesRows,
  organizerIdentityFor,
  seriesKeyFor,
  seriesLabelFor,
  type ReportSeriesRow,
  type ReportTask
} from "./report-grouping";

export type { BookingLifecycle } from "../src/booking-state";
export type { ReportSeriesRow, ReportTask, ReportTaskMember } from "./report-grouping";
export { seriesKeyFor, seriesNameOf, organizerIdentityFor } from "./report-grouping";

/**
 * exceljs ships as CommonJS and its named exports are not visible to Node's ESM
 * loader, so it is required rather than imported — and required lazily, only
 * when a workbook is actually rendered. Building the report and rendering the
 * brief must not pay for, or depend on, the spreadsheet library.
 */
function loadExcelJs(): typeof import("exceljs") {
  return createRequire(import.meta.url)("exceljs") as typeof import("exceljs");
}

const MS_DAY = 86_400_000;
const HORIZON_WEEKS = 12;
const MAX_DRAFTS = 5;
/** The brief carries at most five opportunity cards; the register carries all. */
export const MAX_TOP_OPPORTUNITIES = 5;
/** The compact radar in the brief; everything beyond it lives in the register. */
export const MAX_RADAR_ROWS = 20;
/** The weather lane only reaches ten days ahead; a flag outside that is stale. */
const FORECAST_WINDOW_DAYS = 10;

export const PRODUCT_NAME = "PitchRadar";
export const PRODUCT_TAGLINE = "Weekly Opportunity Brief";
export const APPROVAL_NOTICE =
  "Draft — nothing has been sent; owner approval required before any contact.";
export const EVIDENCE_STATEMENT =
  "Every fact above links to its recorded source; unknowns are stated, never estimated.";
export const REGISTER_POINTER =
  "Full arithmetic, every event, every source URL and the complete organizer drafts are in the operational register workbook that accompanies this brief.";

/* ------------------------------------------------------------------ types */

export type DeadlineEvidenceState = "published" | "none_rolling" | "unknown";

/**
 * THE OWNER VOCABULARY — the fit verdict, the separate confidence axis, the
 * action labels and the pipeline labels.
 *
 * It is declared ONCE, in `src/briefing.ts`, because the private web prints the
 * same words and a second copy of a vocabulary is a vocabulary that drifts.
 * A strong fit we know almost nothing about and a weak fit we have verified are
 * different situations, and collapsing them into one number is exactly how a
 * report starts lying — which is why fit and confidence stay two axes here.
 */
export type {
  ActionLabel,
  ActionSeverity,
  ConfidenceLevel,
  PipelineLabel,
  Recommendation
} from "../src/briefing";

export interface ReportAction {
  action: ActionLabel;
  severity: ActionSeverity;
  /** The recorded fact that triggered this action. Never a generality. */
  because: string;
}

/**
 * Every `pipeline_state` the operating database can hold, mapped to the label
 * the owner reads. Typed as a total Record, so adding a state to the enum
 * WITHOUT deciding what it means to the owner is a BUILD ERROR — never a silent
 * fallback to "Discovered".
 */
const PIPELINE_LABELS: Record<PipelineState, PipelineLabel> = {
  // Found by a source; nothing has been established about it yet.
  discovered: "Discovered",
  // Facts are being established — dates, organizer, whether a pitch exists.
  verifying: "Verifying",
  // Known and tracked, but the application route is not yet established.
  watching: "Verifying",
  // A draft is prepared and waiting for the owner; nothing has been sent.
  owner_review: "Ready to contact",
  applied: "Applied",
  // An application accepted is a pitch held: the truck has somewhere to be.
  accepted: "Booked",
  // Applied, and on the organizer's waiting list — the application stands.
  waitlist: "Applied",
  rejected: "Lost",
  completed: "Completed"
};

export function pipelineLabelFor(pipeline: PipelineState): PipelineLabel {
  return PIPELINE_LABELS[pipeline];
}

export interface ReportScoreComponent {
  label: string;
  value: number;
}

export interface ReportDeadline {
  /** What the recorded evidence says about the deadline, never what we assume. */
  evidence: DeadlineEvidenceState;
  line: string;
  deadline?: string;
  daysRemaining?: number;
  /** URGENT <= 7 days, SOON <= 30 days, WATCH beyond — or no deadline at all. */
  severity: ActionSeverity;
}

export interface ReportWeather {
  /** False when the snapshot carries no weather record for this event. */
  present: boolean;
  riskFlags: string[];
  fetchedAt?: string;
  source?: string;
  note: string;
}

export interface ReportSource {
  label: string;
  url: string;
  publisher: string;
  official: boolean;
  observedAt: string;
}

/**
 * Which rung of the contact-route fallback chain the recorded data reaches.
 * The chain is decided here, once, so the renderer only prints what was found
 * and can never claim "nothing recorded" while a usable route sits in the data.
 */
export type ContactRouteKind =
  | "named"
  | "application_url"
  | "organizer_site"
  | "listing_only"
  | "none";

/**
 * The page a route was read from. A route without its evidence is a claim, so
 * the card prints this next to the route and links it.
 */
export interface ReportRouteEvidence {
  url: string;
  publisher: string;
  observedAt: string;
}

export interface ReportContactRoute {
  kind: ContactRouteKind;
  channel: string;
  recipient?: string;
  /** The named PERSON behind the route, where the catalogue records one. */
  person?: string;
  /** What that person is recorded as being responsible for. */
  personRole?: string;
  email?: string;
  phone?: string;
  url?: string;
  /** The publisher behind an organizer-site fallback, so the line can name it. */
  urlPublisher?: string;
  /** The page this route was read from — printed and linked on every card. */
  evidence?: ReportRouteEvidence;
  /** Honest: true only when the recorded route has been confirmed reachable. */
  verified: boolean;
  /** The one line the report prints for this route. */
  line: string;
  /** The short status the brief's compact rows print instead of a URL. */
  statusLine: string;
}

export interface ReportEvent {
  id: string;
  name: string;
  city: string;
  state: string;
  /**
   * What the report prints for the place. Normally "City, State" — but a
   * stored city that reads as a venue rather than a place is never presented
   * as one, so this becomes "Location needs verification" instead.
   */
  locationLine: string;
  /** True when the stored city could not be trusted as a place name. */
  locationVerified: boolean;
  /** "relevant" or "unclear"; "irrelevant" events never reach the report. */
  vendorRelevance: VendorRelevance;
  category: string;
  startsAt: string;
  endsAt: string;
  dateRange: string;
  tier: OpportunityTier;
  score: number;
  scoreBreakdown: ReportScoreComponent[];
  /** The ISO week the event first occupies, and that week's date range. */
  weekKey: string;
  weekRangeLabel: string;
  /** The internal weekly role. REGISTER ONLY — the brief never prints it. */
  role: WeeklyRole;
  /** Trading days inside the event's first week. */
  tradingDaysInWeek: number;
  /** Trading days across the whole event. */
  tradingDays: number;
  actionable: boolean;
  rejected: boolean;
  rejectionReason?: string;
  applicationPhase: ApplicationPhase;
  applicationLabel: string;
  applicationNextAction: string;
  deadline: ReportDeadline;
  organizer?: string;
  /**
   * What the report prints on the Organizer line. When no organizer is
   * recorded but an official publisher discovered the event, that publisher is
   * named — an official source is a real lead, not an absence.
   */
  organizerLine: string;
  contactRoute: ReportContactRoute;
  sources: ReportSource[];
  missingFields: string[];
  weather: ReportWeather;

  /* ------------------------------------------- derived decision fields */

  pipeline: PipelineState;
  pipelineLabel: PipelineLabel;
  recommendation: Recommendation;
  confidence: ConfidenceLevel;
  /** The recorded reason the confidence landed where it did. */
  confidenceReason: string;
  /**
   * The reason AS PRINTED: the recorded cause plus the facts still open. A
   * confidence level without its cause is a verdict the reader cannot act on,
   * so no renderer is allowed to print the level alone.
   */
  confidenceCause: string;
  action: ReportAction;
  /** Plain-language phrases derived from the score components, never written per event. */
  whyItFits: string[];
  /** True when the event's dates overlap a booking that holds the truck. */
  overlapsBooking: boolean;
  /** True when the event starts inside the weather lane's 10-day reach. */
  insideForecastWindow: boolean;

  /**
   * The tour this event belongs to, where it belongs to one — same organizer,
   * same name once the city and the year are taken out. DISPLAY ONLY: no record
   * is merged and every event keeps its own register row.
   */
  seriesKey: string;
  /** The printed series name. Empty when the event stands alone. */
  seriesLabel: string;
}

export interface ReportBooking {
  id: string;
  eventName: string;
  city: string;
  state: string;
  dateRange: string;
  startsAt: string;
  endsAt: string;
  bookingState: ClientBooking["bookingState"];
  /** What the booking IS, on the report's clock — not only what the row says. */
  lifecycle: BookingLifecycle;
  /** The one line the brief prints for this booking's state. */
  statusLine: string;
  organizer: string;
  standOrZone?: string;
  /** Weeks this booking holds the truck. Empty once it is completed. */
  blockedWeeks: string[];
  outcomesRecorded: number;
  /** The outcome facts still wanted. Printed, not summarised away. */
  missingOutcomeInputs: string[];
}

export interface ReportDeadlineRadarItem {
  eventId: string;
  eventName: string;
  city: string;
  /** Same honest place rule as the register; see {@link ReportEvent}. */
  locationLine: string;
  weekKey: string;
  deadline: string;
  deadlineLabel: string;
  daysRemaining: number;
  severity: ActionSeverity;
  /** "Verified contact" / "Portal" / "Research needed" — never a raw URL. */
  routeStatus: string;
  recommendedAction: ActionLabel;
}

export interface ReportWeatherRow {
  eventId: string;
  eventName: string;
  dateRange: string;
  riskFlags: string[];
  fetchedAt?: string;
  source?: string;
  /** Why this row is decision-relevant: booked, top opportunity, or in-window. */
  relevance: string;
}

export interface ReportDraft {
  eventId: string;
  eventName: string;
  weekKey: string;
  weeklyRole: string;
  channel: string;
  recipient?: string;
  routeVerified: boolean;
  routeNote: string;
  subject: string;
  draftDe: string;
  draftEn: string;
  approvalNotice: string;
}

/**
 * The business numbers. Declared in `src/briefing.ts` with the vocabulary, so
 * the command centre's KPI row and the brief's KPI row are the same eight
 * numbers by construction — `actionNow` counts TASKS, `actionNowEvents` the
 * events behind them, and no surface may invent a ninth reading.
 */
export type ReportKpis = BriefingKpis;

export interface ReportSystemHealth {
  eventsCollected: number;
  registeredSources: number;
  noiseExcluded: number;
  organizerCoverage: string;
  verifiedRoutes: string;
  deadlineEvidence: string;
  weatherCoverage: string;
  evidenceRecords: number;
  unresolvedLocations: number;
  relevanceUnverified: number;
  mode: CatalogueMode;
  modeStatement: string;
  /** Source health as counts by state, deterministic order. */
  sourceHealth: Array<{ state: string; count: number }>;
}

export interface WeeklyReport {
  product: typeof PRODUCT_NAME;
  tagline: string;
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  weekRangeLabel: string;
  reportDateLabel: string;
  generatedAt: string;
  generatedAtLabel: string;
  /** Who the brief is written for, in one line. */
  operatorProfileLine: string;
  /** How old the newest source collection is. Stated, never assumed fresh. */
  dataFreshness: string;
  mode: CatalogueMode;
  modeStatement: string;
  horizonWeeks: number;

  kpis: ReportKpis;
  /** One sentence computed from the KPI numbers. Nothing in it is written by hand. */
  summarySentence: string;

  /** Everything with an action. Ordered URGENT → SOON → WATCH, then by deadline. */
  actionNow: ReportEvent[];
  /** The same work, grouped into organizer-level tasks. The brief prints THESE. */
  actionQueue: ReportTask[];
  /** At most five. Never an unclear-relevance event, never a rejected one. */
  topOpportunities: ReportEvent[];
  /** The compact secondary table: what is on the radar but not on the shortlist. */
  radar: ReportEvent[];
  /** The same radar, one row per tour. Singles are rows of one. */
  radarSeries: ReportSeriesRow[];
  /** EVERY non-irrelevant event in the snapshot. The register's spine. */
  register: ReportEvent[];

  pipelineCounts: Array<{ label: PipelineLabel; count: number }>;
  bookings: ReportBooking[];
  /** Weeks a booking still holds the truck. Completed bookings block nothing. */
  blockedWeeks: string[];
  /** Non-rejected events whose dates collide with a booking that holds the truck. */
  conflicts: ReportEvent[];

  deadlineRadar: ReportDeadlineRadarItem[];
  /** Only the weather rows a decision turns on. */
  weatherDecisionRows: ReportWeatherRow[];
  /** Every recorded forecast. Register only. */
  weatherAllRows: ReportWeatherRow[];

  systemHealth: ReportSystemHealth;
  drafts: ReportDraft[];

  totals: {
    events: number;
    actionableEvents: number;
    sources: number;
    evidenceRecords: number;
    /** Consumer-calendar entries removed by the vendor-relevance gate. */
    excludedIrrelevant: number;
    /** Events shown but carrying the "relevance unverified" tag. */
    unclearRelevance: number;
  };
  /** The footer sentence naming what the relevance gate removed. */
  relevanceStatement: string;
  evidenceStatement: string;
  registerPointer: string;
}

/* ------------------------------------------------------- Berlin calendar */

const BERLIN_YMD = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const BERLIN_DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "short"
});
const BERLIN_FULL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "short",
  year: "numeric"
});
const BERLIN_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function berlinYmd(instant: Date): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    BERLIN_YMD.formatToParts(instant)
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, Number(part.value)])
  ) as { year: number; month: number; day: number };
  return parts;
}

/** ISO week of a calendar day, computed on the Berlin civil date. */
function isoWeekOfCivilDay(year: number, month: number, day: number) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  const weekNumber = Math.ceil(((utc.getTime() - yearStart) / MS_DAY + 1) / 7);
  return {
    year: utc.getUTCFullYear(),
    weekNumber,
    key: `${utc.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`
  };
}

/** Monday 00:00 (as a civil day key) of the ISO week holding this instant in Berlin. */
function berlinIsoWeekBounds(instant: Date) {
  const { year, month, day } = berlinYmd(instant);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay() || 7;
  const monday = new Date(utc.getTime() - (weekday - 1) * MS_DAY);
  const sunday = new Date(monday.getTime() + 6 * MS_DAY);
  const iso = isoWeekOfCivilDay(year, month, day);
  return { monday, sunday, ...iso };
}

function civilDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

/** An instant as its Berlin calendar day, `YYYY-MM-DD`. */
function berlinDayKey(instant: Date): string {
  const { year, month, day } = berlinYmd(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fullDate(value: string | Date): string {
  return BERLIN_FULL.format(value instanceof Date ? value : new Date(value));
}

function dayMonth(value: string | Date): string {
  return BERLIN_DAY_MONTH.format(value instanceof Date ? value : new Date(value));
}

function rangeLabel(start: string | Date, end: string | Date): string {
  const from = fullDate(start);
  const to = fullDate(end);
  return from === to ? from : `${from} – ${to}`;
}

/** "18 Sep – 20 Sep". The series row carries a date, not a paragraph. */
function compactRange(start: string | Date, end: string | Date): string {
  const from = dayMonth(start);
  const to = dayMonth(end);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * Days between a deadline and `now`, on the Berlin calendar. Date-only values
 * ("2026-08-15") are compared day-to-day so a timezone can never shift a
 * deadline by one day.
 */
function deadlineDaysRemaining(value: string, now: Date): number {
  const today = berlinYmd(now);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return Math.round((Date.UTC(year, month - 1, day) - todayUtc) / MS_DAY);
  }
  const target = berlinYmd(new Date(value));
  return Math.round((Date.UTC(target.year, target.month - 1, target.day) - todayUtc) / MS_DAY);
}

/** Whole days between two instants, on the Berlin calendar. */
function daysBetweenDays(from: string | Date, to: Date): number {
  const a = berlinYmd(from instanceof Date ? from : new Date(from));
  const b = berlinYmd(to);
  return Math.round(
    (Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / MS_DAY
  );
}

/* ------------------------------------------------------- defensive reads */

/**
 * The deadline-evidence field is owned by the application-window work and may
 * or may not be present on a given snapshot. Read it without asserting it
 * exists, and never infer an evidence state we were not told.
 */
function readDeadlineEvidence(event: EventOpportunity): DeadlineEvidenceState | undefined {
  const candidates: unknown[] = [
    (event as unknown as Record<string, unknown>).deadlineEvidence,
    (event.application as unknown as Record<string, unknown> | undefined)?.deadlineEvidence
  ];
  for (const candidate of candidates) {
    if (candidate === "published" || candidate === "none_rolling") return candidate;
    // The window lane calls the third state "not_found"; older shapes may say
    // "unknown". Both mean the same thing: no deadline has been found yet.
    if (candidate === "not_found" || candidate === "unknown") return "unknown";
  }
  return undefined;
}

interface RawWeather {
  riskFlags?: unknown;
  fetchedAt?: unknown;
  observedAt?: unknown;
  source?: unknown;
}

/**
 * Weather enrichment is written by the weather lane close to an event. If no
 * record exists we say the enrichment has not activated — we never model it.
 */
function readWeather(event: EventOpportunity): ReportWeather {
  const raw = (event as unknown as Record<string, unknown>).weather as RawWeather | undefined;
  if (!raw || typeof raw !== "object") {
    return {
      present: false,
      riskFlags: [],
      note: "Weather enrichment activates within 10 days of an event"
    };
  }
  const riskFlags = Array.isArray(raw.riskFlags) ? raw.riskFlags.map((flag) => String(flag)) : [];
  const fetchedAt =
    typeof raw.fetchedAt === "string" ? raw.fetchedAt : typeof raw.observedAt === "string" ? raw.observedAt : undefined;
  const source = typeof raw.source === "string" ? raw.source : undefined;
  return {
    present: true,
    riskFlags,
    fetchedAt,
    source,
    note: riskFlags.length ? "Recorded weather risk" : "Weather recorded, no risk flag raised"
  };
}

const CATEGORY_LABELS: Record<EventOpportunity["eventType"], string> = {
  street_food: "Street food",
  city_festival: "City festival",
  market: "Market",
  sports: "Sports",
  christmas: "Christmas market",
  private: "Private event"
};

/* ---------------------------------------------------- the deadline bands */

/** URGENT <= 7 days, SOON <= 30 days, WATCH beyond — and WATCH with no deadline. */
export function deadlineSeverity(daysRemaining: number | undefined): ActionSeverity {
  if (daysRemaining === undefined || daysRemaining < 0) return "WATCH";
  if (daysRemaining <= 7) return "URGENT";
  if (daysRemaining <= 30) return "SOON";
  return "WATCH";
}

function deadlineFor(event: EventOpportunity, now: Date): ReportDeadline {
  const evidence = readDeadlineEvidence(event);
  const intel = applicationIntelligenceFor(event);
  const value = intel.deadline ?? event.applicationDeadline;

  // The three evidence states are kept VERBATIM. "No deadline published — not
  // yet found" and "Rolling — no deadline exists" are different facts and the
  // owner is entitled to tell them apart.
  if (evidence === "none_rolling") {
    return { evidence: "none_rolling", line: "Rolling — no deadline exists", severity: "WATCH" };
  }

  const published = evidence === "published" || (evidence === undefined && Boolean(value));
  if (published && value) {
    const daysRemaining = deadlineDaysRemaining(value, now);
    const days = Math.abs(daysRemaining);
    const line =
      daysRemaining >= 0
        ? `Deadline ${dayMonth(value)} — ${daysRemaining} days left`
        : `Deadline ${dayMonth(value)} — closed ${days} days ago`;
    return {
      evidence: "published",
      line,
      deadline: value,
      daysRemaining,
      severity: deadlineSeverity(daysRemaining)
    };
  }

  return { evidence: "unknown", line: "No deadline published — not yet found", severity: "WATCH" };
}

/* --------------------------------------------------- the routes and names */

/**
 * The first official publisher that discovered the event. An official source is
 * a municipal or tourism body: naming it is a real next step, which is why an
 * unpublished organizer is reported as "source: <publisher>" and not as a blank.
 */
function officialSourceFor(event: EventOpportunity) {
  return event.sources.find((source) => source.official);
}

/**
 * The page a contact route was read from.
 *
 * A resolved contact carries its OWN page (the impressum or contact page the
 * resolver read it from); everything else falls back to the official source the
 * event was discovered on, and only then to the first recorded source. A route
 * printed without the page it came from is a claim the reader cannot check.
 */
function routeEvidenceFor(event: EventOpportunity): ReportRouteEvidence | undefined {
  if (event.contactSourceUrl) {
    return {
      url: event.contactSourceUrl,
      publisher: event.contactSourcePublisher ?? hostLabel(event.contactSourceUrl),
      observedAt: event.contactObservedAt ?? ""
    };
  }
  const source = officialSourceFor(event) ?? event.sources[0];
  return source
    ? { url: source.url, publisher: source.publisher, observedAt: source.observedAt }
    : undefined;
}

/**
 * The short, readable stand-in for a URL: host plus at most one path segment.
 * An A4 column cannot carry a 120-character portal URL, and a wrapped URL reads
 * as noise — but the real href is always the full URL, never this label.
 */
export function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return host;
    const first = segments[0].length > 24 ? `${segments[0].slice(0, 24)}…` : segments[0];
    return `${host}/${first}${segments.length > 1 ? "/…" : ""}`;
  } catch {
    return url.length > 48 ? `${url.slice(0, 48)}…` : url;
  }
}

function organizerLineFor(event: EventOpportunity): string {
  const organizer = event.organizer ?? event.application?.routeOwner;
  if (organizer) return organizer;
  const official = officialSourceFor(event);
  if (official) return `Organizer unpublished — source: ${official.publisher}`;
  return "Not yet identified";
}

/**
 * The contact-route fallback chain, decided once on the recorded data:
 *
 *   named contact (email / phone) → application URL → organizer website → none
 *
 * The report may only say a route is missing when every rung is empty. A
 * recorded application URL is a route the owner can walk today, so printing
 * "no decision-maker recorded" over the top of one is a false negative, and a
 * false negative in this product costs an application window.
 *
 * `statusLine` is the SHORT form: the brief's compact rows print it instead of
 * a raw URL, which never fits an A4 column and reads as noise on a decision page.
 */
function contactRouteFor(event: EventOpportunity, weekKey: string, role: WeeklyRole): ReportContactRoute {
  const plan = createVerificationDraft(event, weekKey, roleKeyFor(role));
  const recipient = event.application?.routeOwner ?? event.organizer;
  const reachable = event.application?.routeReachable === true;
  const evidence = routeEvidenceFor(event);

  // Rung 1 — a named way to reach a person.
  if (event.contactEmail || event.contactPhone) {
    const parts = [
      event.contactPerson,
      recipient,
      event.contactEmail,
      event.contactPhone
    ].filter(Boolean) as string[];
    return {
      kind: "named",
      channel: plan.channel,
      recipient,
      person: event.contactPerson,
      personRole: event.contactRole,
      email: event.contactEmail,
      phone: event.contactPhone,
      url: event.applicationUrl,
      evidence,
      verified: plan.routeVerified,
      line: `${plan.channel} · ${parts.join(" · ")} · ${
        plan.routeVerified ? "route confirmed reachable" : "reachability not yet confirmed"
      }`,
      statusLine: plan.routeVerified ? "Verified contact" : "Named contact, unconfirmed"
    };
  }

  // Rung 2 — the published application route.
  if (event.applicationUrl) {
    return {
      kind: "application_url",
      channel: plan.channel === "research" ? "portal" : plan.channel,
      recipient,
      person: event.contactPerson,
      personRole: event.contactRole,
      url: event.applicationUrl,
      evidence,
      verified: reachable,
      line: `Apply via ${event.applicationUrl}${recipient ? ` · ${recipient}` : ""} · ${
        reachable ? "route confirmed reachable" : "reachability not yet confirmed"
      }`,
      statusLine: reachable ? "Application portal, confirmed" : "Application portal, unconfirmed"
    };
  }

  // Rung 3 — the official page the event was discovered on.
  const official = officialSourceFor(event);
  const organizerSite = event.application?.sourceUrl ?? official?.url;
  if (organizerSite) {
    const publisher = event.application?.sourceUrl ? recipient ?? official?.publisher : official?.publisher;
    return {
      kind: "organizer_site",
      channel: "research",
      recipient,
      url: organizerSite,
      urlPublisher: publisher,
      evidence,
      verified: false,
      line: `Organizer website ${organizerSite}${
        publisher ? ` · ${publisher}` : ""
      } · no named decision-maker recorded yet`,
      statusLine: publisher ? `Organizer website · ${publisher}` : "Organizer website"
    };
  }

  // Rung 3b — the event is only known from a non-official listing. That is not
  // a route to the organizer and must not be dressed up as one, but naming the
  // listing is still the honest answer to "where does the search resume?".
  const listing = event.sources[0];
  if (listing) {
    return {
      kind: "listing_only",
      channel: "research",
      recipient,
      url: listing.url,
      urlPublisher: listing.publisher,
      evidence: {
        url: listing.url,
        publisher: listing.publisher,
        observedAt: listing.observedAt
      },
      verified: false,
      line: `No organizer route recorded — listed on ${listing.publisher}, contact still to be researched`,
      statusLine: `Research needed · listed on ${listing.publisher}`
    };
  }

  return {
    kind: "none",
    channel: "research",
    recipient,
    verified: false,
    line: "No contact route recorded yet",
    statusLine: "No route recorded"
  };
}

/**
 * The footer sentence about the relevance gate. It is printed whether or not
 * anything was removed: a reader must be able to tell "nothing was filtered"
 * from "the filter was not applied".
 */
function relevanceStatementFor(count: number): string {
  return count === 0
    ? "No consumer-calendar entries were excluded; every known event is a possible vendor opportunity."
    : `${count} consumer-calendar ${
        count === 1 ? "entry" : "entries"
      } (tours, lectures, …) excluded as not vendor-relevant.`;
}

/**
 * The place line. A venue string that leaked into the city column is not a
 * place, and printing it as one would be the report inventing a location — so
 * it says what is true instead: this needs verification.
 */
function locationFor(event: Pick<EventOpportunity, "city" | "state">): {
  line: string;
  verified: boolean;
} {
  if (isVenueString(event.city)) {
    return { line: LOCATION_NEEDS_VERIFICATION, verified: false };
  }
  return { line: `${event.city}, ${event.state}`, verified: true };
}

function roleKeyFor(role: WeeklyRole): "primary" | "backup" | "verify_first" {
  if (role === "Primary") return "primary";
  if (role === "Backup") return "backup";
  return "verify_first";
}

/* ------------------------------------------- the derived decision fields */

/**
 * THE FIT VERDICT.
 *
 *   REJECTED                      → SKIP
 *   relevance unclear             → WATCH  (a CAP: no score can lift it)
 *   tier A and relevance relevant → STRONG FIT
 *   tier B                        → GOOD FIT
 *   tier C                        → WATCH
 *
 * The unclear cap is the whole point of the vendor-relevance gate reaching the
 * brief: an event we have not established IS a food-vendor opportunity cannot
 * be recommended, however well it scores on demand and logistics.
 */
export function recommendationFor(
  event: Pick<ReportEvent, "tier" | "vendorRelevance" | "rejected">
): Recommendation {
  if (event.rejected || event.tier === "REJECTED") return "SKIP";
  if (event.vendorRelevance === "unclear") return "WATCH";
  if (event.tier === "A") return "STRONG FIT";
  if (event.tier === "B") return "GOOD FIT";
  return "WATCH";
}

export interface ConfidenceInput {
  verification: EventOpportunity["verification"];
  routeVerified: boolean;
  routeKind: ContactRouteKind;
  officialSources: number;
  organizerIdentified: boolean;
  locationVerified: boolean;
}

/**
 * HOW SOLID THE SHOWN FACTS ARE — a separate axis from how good the fit is.
 *
 *   LOW    the event rests on aggregator listings alone, with no official
 *          corroboration — OR the recorded location still needs verification
 *   HIGH   verification 'verified' AND at least one official source
 *          AND (the organizer is identified OR the route is confirmed reachable)
 *   MEDIUM everything else
 *
 * Confidence COUNTS NOTHING. It used to: five open facts dropped a row to LOW
 * whatever its sources said, so an event discovered from a municipal calendar
 * carried the same label as one scraped off a listing aggregator, and the fresh
 * event was punished a second time for the same gap the score had already
 * charged. A count of what we have not asked yet is not a measure of what we
 * hold — the open facts belong in KEY UNKNOWNS, where the owner can close them,
 * and nowhere else.
 *
 * LOW is evaluated FIRST. Where the two definitions could both fire — a
 * verified event whose city is a venue string — the pessimistic reading wins,
 * because the optimistic one would put a place we cannot name on a decision
 * page under a HIGH label.
 */
export function confidenceFor(input: ConfidenceInput): {
  level: ConfidenceLevel;
  reason: string;
} {
  const listingOnly = input.routeKind === "listing_only" || input.routeKind === "none";
  if (listingOnly && input.officialSources === 0) {
    return { level: "LOW", reason: "single aggregator listing, no official corroboration yet" };
  }
  if (!input.locationVerified) {
    return { level: "LOW", reason: "the recorded location still needs verification" };
  }
  if (
    input.verification === "verified" &&
    input.officialSources >= 1 &&
    (input.organizerIdentified || input.routeVerified)
  ) {
    return {
      level: "HIGH",
      reason: input.routeVerified
        ? "official source, organizer route confirmed reachable"
        : "official source, organizer identified"
    };
  }
  return {
    level: "MEDIUM",
    reason:
      input.verification === "verified"
        ? input.officialSources >= 1
          ? "official source, but no organizer identified or route confirmed yet"
          : "verified against the recorded evidence, but no official source among it"
        : input.officialSources >= 1
          ? "official source recorded, but the event is not verified end to end"
          : "the event is recorded but not yet verified end to end"
  };
}

/**
 * The cause string printed next to every confidence label.
 *
 *   "official source (Stadt Schwedt/Oder), organizer identified"
 *
 * Derived, never written per event, and derived from the SAME facts the level
 * is: it states the basis the reader can check, and names the publisher that
 * basis rests on where there is one. It deliberately says nothing about open
 * facts — those are the KEY UNKNOWNS section's job, and repeating them here was
 * what made every card read as low-confidence however solid its sources were.
 */
export function confidenceCauseFor(input: {
  confidenceReason: string;
  officialPublisher?: string;
}): string {
  if (!input.officialPublisher) return input.confidenceReason;
  return input.confidenceReason.replace("official source", `official source (${input.officialPublisher})`);
}

/**
 * A missing fact that NAMES what is blocking the decision — a capacity or
 * category question the owner could resolve with one call. This is the
 * difference between "we do not know much" and "we know exactly the one thing
 * we do not know".
 */
const NAMED_UNKNOWN_PATTERN = /(capacity|kapazit|category|kategorie|places|plätze|platz|vendor|slot|pitch)/i;

export function namedUnknownIn(missingFields: string[]): string | undefined {
  return missingFields.find((field) => NAMED_UNKNOWN_PATTERN.test(field));
}

export interface ActionInput {
  recommendation: Recommendation;
  deadline: ReportDeadline;
  routeKind: ContactRouteKind;
  routeVerified: boolean;
  missingFields: string[];
  overlapsBooking: boolean;
  weatherRiskFlags: string[];
  insideForecastWindow: boolean;
  /** True for a booked event or one on the brief's Top 5. */
  decisionCritical: boolean;
  vendorRelevance: VendorRelevance;
}

/**
 * WHAT TO DO — first matching rule wins, in exactly this order.
 *
 *   1. a published deadline <= 7 days away and ANY route      → APPLY NOW (URGENT)
 *   2. a published deadline <= 30 days away                   → CONTACT ORGANIZER (SOON)
 *   3. STRONG FIT with a confirmed route                      → CONTACT ORGANIZER (SOON)
 *   4. dates collide with a booking that holds the truck      → REVIEW CONFLICT (URGENT)
 *   5. STRONG or GOOD FIT blocked by a NAMED unknown          → VERIFY CATEGORY AVAILABILITY (WATCH)
 *   6. weather risk on a decision-critical event in window    → WEATHER CHECK (SOON)
 *   7. otherwise                                              → NO ACTION (WATCH)
 *
 * The collision rule sits ABOVE the named-unknown rule, which is not where it
 * started. A truck already promised to somebody is a HARDER fact than an open
 * category question, and while almost nothing reached GOOD FIT the ordering
 * never showed: the moment the recalibrated bands let real events through, a
 * double-booked weekend was being reported as "verify category availability,
 * WATCH" instead of "review conflict, URGENT".
 *
 * Two events never reach a rule at all: a SKIP (rejected by the gates) and an
 * event whose vendor relevance is unverified. Neither may occupy a line of
 * ACTION NOW — the first is closed work, the second is not yet known to be work.
 */
export function actionFor(input: ActionInput): ReportAction {
  if (input.recommendation === "SKIP") {
    return { action: "NO ACTION", severity: "WATCH", because: "closed by the ranking gates" };
  }
  if (input.vendorRelevance === "unclear") {
    return {
      action: "NO ACTION",
      severity: "WATCH",
      because: "vendor relevance is unverified — establish that first"
    };
  }

  const days = input.deadline.evidence === "published" ? input.deadline.daysRemaining : undefined;

  if (days !== undefined && days >= 0 && days <= 7 && input.routeKind !== "none") {
    return {
      action: "APPLY NOW",
      severity: "URGENT",
      because: `the published deadline closes in ${days} day${days === 1 ? "" : "s"}`
    };
  }
  if (days !== undefined && days >= 0 && days <= 30) {
    return {
      action: "CONTACT ORGANIZER",
      severity: "SOON",
      because: `the published deadline closes in ${days} days`
    };
  }
  if (input.recommendation === "STRONG FIT" && input.routeVerified) {
    return {
      action: "CONTACT ORGANIZER",
      severity: "SOON",
      because: "a strong fit with a confirmed organizer route"
    };
  }
  if (input.overlapsBooking) {
    return {
      action: "REVIEW CONFLICT",
      severity: "URGENT",
      because: "these dates collide with a booking that already holds the truck"
    };
  }
  if (input.recommendation === "STRONG FIT" || input.recommendation === "GOOD FIT") {
    const unknown = namedUnknownIn(input.missingFields);
    if (unknown) {
      return {
        action: "VERIFY CATEGORY AVAILABILITY",
        severity: "WATCH",
        because: `the fit is there; the open question is: ${unknown}`
      };
    }
  }
  if (input.weatherRiskFlags.length && input.insideForecastWindow && input.decisionCritical) {
    return {
      action: "WEATHER CHECK",
      severity: "SOON",
      because: `the recorded forecast raises ${input.weatherRiskFlags.join(", ")}`
    };
  }
  return { action: "NO ACTION", severity: "WATCH", because: "nothing is due on this one yet" };
}

/**
 * WHY IT FITS — derived from the actual score components, never written per
 * event. Each phrase corresponds to one number the ranking produced, so a card
 * can never claim a strength the arithmetic does not carry.
 */
export function whyItFitsFrom(input: {
  components: Record<string, number>;
  tradingDays: number;
  routeVerified: boolean;
}): string[] {
  const phrases: string[] = [];
  const get = (key: string) => input.components[key];

  const eventTypeFit = get("EventTypeFit") ?? 0;
  if (eventTypeFit >= 30) phrases.push("direct street-food fit");
  else if (eventTypeFit >= 22) phrases.push("market or Christmas-market audience");
  else if (eventTypeFit >= 18) phrases.push("city-festival footfall");

  const calendarFit = get("CalendarFit") ?? 0;
  if (calendarFit >= 20) phrases.push("every trading day is a normal trading day");
  else if (calendarFit >= 12) phrases.push("part of the run falls on normal trading days");

  const regionFit = get("RegionFit") ?? 0;
  if (regionFit >= 15) phrases.push("home region");
  else if (regionFit >= 13) phrases.push("inside the preferred travel time");

  if ((get("ApplicationWindow") ?? 0) >= 10) phrases.push("application window open");

  // The two bonuses. They say evidence EXISTS — their absence says nothing
  // about the event, only about how far the research has got, so there is no
  // opposite phrase to print.
  if ((get("DemandEvidence") ?? 0) >= 7) phrases.push("strong visitor demand evidence");
  else if ((get("DemandEvidence") ?? 0) > 0) phrases.push("visitor numbers on record");
  if ((get("EconomicsEvidence") ?? 0) > 0) phrases.push("pitch fee already recorded");

  if (input.tradingDays >= 3) phrases.push(`multi-day trading (${input.tradingDays} days)`);
  if (input.routeVerified) phrases.push("verified organizer route");
  return phrases;
}

/* ------------------------------------------------------------- the build */

interface Placement {
  weekKey: string;
  weekRangeLabel: string;
  role: WeeklyRole;
  tradingDaysInWeek: number;
}

function toReportEvent(
  event: EventOpportunity,
  placement: Placement,
  context: { overlapsBooking: boolean; now: Date }
): ReportEvent {
  const now = context.now;
  const rejected = event.tier === "REJECTED";
  const decision = applicationDecision(event, now);
  const breakdown = Object.entries(event.scoreBreakdown ?? {}).map(([label, value]) => ({ label, value }));
  const location = locationFor(event);
  const contactRoute = contactRouteFor(event, placement.weekKey, placement.role);
  const weather = readWeather(event);
  const vendorRelevance = vendorRelevanceOf(event);
  const deadline = deadlineFor(event, now);
  const startsInDays = daysBetweenDays(event.startsAt, now);
  const insideForecastWindow = startsInDays >= 0 && startsInDays <= FORECAST_WINDOW_DAYS;
  const tier = event.tier ?? "C";
  const recommendation = recommendationFor({ tier, vendorRelevance, rejected });
  const organizer = event.organizer ?? event.application?.routeOwner;
  const confidence = confidenceFor({
    verification: event.verification,
    routeVerified: contactRoute.verified,
    routeKind: contactRoute.kind,
    officialSources: event.sources.filter((source) => source.official).length,
    organizerIdentified: Boolean(organizer),
    locationVerified: location.verified
  });
  const eventTradingDays = tradingDaysOf(event);
  // An event whose dates have passed is EXPIRED whatever its stored pipeline
  // state says — a row nobody transitioned is not evidence that it is still live.
  const ended = new Date(event.endsAt).getTime() < now.getTime();

  return {
    id: event.id,
    name: event.name,
    city: event.city,
    state: event.state,
    locationLine: location.line,
    locationVerified: location.verified,
    vendorRelevance,
    category: CATEGORY_LABELS[event.eventType] ?? event.eventType,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    dateRange: rangeLabel(event.startsAt, event.endsAt),
    tier,
    score: event.score ?? 0,
    scoreBreakdown: breakdown,
    weekKey: placement.weekKey,
    weekRangeLabel: placement.weekRangeLabel,
    role: placement.role,
    tradingDaysInWeek: placement.tradingDaysInWeek,
    tradingDays: eventTradingDays,
    actionable: !rejected && placement.role !== "Blocked" && placement.role !== "Closed",
    rejected,
    rejectionReason: event.rejectionReason,
    applicationPhase: decision.phase,
    applicationLabel: decision.label,
    applicationNextAction: decision.nextAction,
    deadline,
    organizer,
    organizerLine: organizerLineFor(event),
    contactRoute,
    sources: event.sources.map((source) => ({
      label: source.label,
      url: source.url,
      publisher: source.publisher,
      official: source.official,
      observedAt: source.observedAt
    })),
    missingFields: [...event.missingFields],
    weather,
    pipeline: event.pipeline,
    pipelineLabel: ended ? "Expired" : pipelineLabelFor(event.pipeline),
    recommendation,
    confidence: confidence.level,
    confidenceReason: confidence.reason,
    confidenceCause: confidenceCauseFor({
      confidenceReason: confidence.reason,
      officialPublisher: officialSourceFor(event)?.publisher
    }),
    // Filled in by the second pass, once the Top 5 is known.
    action: { action: "NO ACTION", severity: "WATCH", because: "" },
    whyItFits: whyItFitsFrom({
      components: event.scoreBreakdown ?? {},
      tradingDays: eventTradingDays,
      routeVerified: contactRoute.verified
    }),
    overlapsBooking: context.overlapsBooking,
    insideForecastWindow,
    seriesKey: seriesKeyFor(event),
    // Filled in by the register-wide pass, once it is known whether this event
    // has company. One stop is not a tour.
    seriesLabel: ""
  };
}

const SEVERITY_ORDER: Record<ActionSeverity, number> = { URGENT: 0, SOON: 1, WATCH: 2 };
const RECOMMENDATION_ORDER: Record<Recommendation, number> = {
  "STRONG FIT": 0,
  "GOOD FIT": 1,
  WATCH: 2,
  SKIP: 3
};

function rangesOverlap(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string }
): boolean {
  return new Date(a.startsAt) <= new Date(b.endsAt) && new Date(b.startsAt) <= new Date(a.endsAt);
}

function bookingStatusLine(lifecycle: BookingLifecycle, booking: ReportBooking): string {
  switch (lifecycle) {
    case "live":
      return "Trading now — the truck is committed";
    case "upcoming":
      return "Confirmed and upcoming — the truck is committed for these dates";
    case "completed_outcome_pending":
      return "Completed — outcome pending";
    case "completed_outcome_recorded":
      return `Completed — ${booking.outcomesRecorded} trading day(s) of outcome recorded`;
    case "cancelled":
      return "Cancelled — the truck is free for these dates";
  }
}

function weekdayList(days: number[]): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days.map((day) => names[day] ?? String(day)).join(", ");
}

export function buildWeeklyReport(snapshot: ProductSnapshot, now: Date): WeeklyReport {
  const bounds = berlinIsoWeekBounds(now);

  // The vendor-relevance gate, applied ONCE, here — before ranking, before
  // week grouping, before the radar and the drafts are derived. Everything
  // downstream reads `considered`, so a consumer-calendar entry cannot reappear
  // in one section because that section was written later. The count survives
  // so the footer can state what was removed rather than quietly shrinking.
  const excluded = snapshot.events.filter((event) => vendorRelevanceOf(event) === "irrelevant");
  const considered = snapshot.events.filter((event) => vendorRelevanceOf(event) !== "irrelevant");

  const ranked = rankOpportunities(considered, snapshot.profile, now);
  const allWeeks = groupByCalendarWeek(ranked, snapshot.bookings);

  /* ---------------------------------------------------------- bookings */

  const bookings: ReportBooking[] = snapshot.bookings.map((booking) => {
    const lifecycle = bookingLifecycleFor(booking, now);
    // A completed or cancelled booking holds nothing. Reporting it as blocking
    // a week is what kept the owner out of weeks the truck was already free for.
    const holdsTruck = lifecycle === "live" || lifecycle === "upcoming";
    const row: ReportBooking = {
      id: booking.id,
      eventName: booking.eventName,
      city: booking.city,
      state: booking.state,
      dateRange: rangeLabel(booking.startsAt, booking.endsAt),
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      bookingState: booking.bookingState,
      lifecycle,
      statusLine: "",
      organizer: booking.organizer,
      standOrZone: booking.standOrZone,
      blockedWeeks: holdsTruck
        ? allWeeks
            .filter((week) => week.bookings.some((item) => item.id === booking.id))
            .map((week) => week.key)
        : [],
      outcomesRecorded: booking.outcomesRecorded ?? 0,
      missingOutcomeInputs: [...booking.missingOutcomeInputs]
    };
    row.statusLine = bookingStatusLine(lifecycle, row);
    return row;
  });

  const holdingBookings = snapshot.bookings.filter((booking) => bookingHoldsTruck(booking, now));
  const blockedWeeks = [...new Set(bookings.flatMap((booking) => booking.blockedWeeks))].sort();

  /* ---------------------------------------------------- the register */

  // Where each event first lands on the calendar, and the internal role it
  // carries there. The register keeps this; the brief never prints the role.
  const placements = new Map<string, Placement>();
  allWeeks.forEach((week) => {
    week.events.forEach((item) => {
      if (placements.has(item.event.id)) return;
      placements.set(item.event.id, {
        weekKey: week.key,
        weekRangeLabel: rangeLabel(week.startsAt, week.endsAt),
        role: item.role,
        tradingDaysInWeek: item.tradingDays
      });
    });
  });

  // EVERY non-irrelevant event, exactly once, in ranked order. This is the
  // register's spine and the invariant the suite pins: no event the gate let
  // through may fall out of the report because it sat outside a horizon.
  const register: ReportEvent[] = ranked.map((event) => {
    const placement = placements.get(event.id) ?? {
      weekKey: isoWeekOfCivilDay(
        berlinYmd(new Date(event.startsAt)).year,
        berlinYmd(new Date(event.startsAt)).month,
        berlinYmd(new Date(event.startsAt)).day
      ).key,
      weekRangeLabel: rangeLabel(event.startsAt, event.endsAt),
      role: "Verify first" as WeeklyRole,
      tradingDaysInWeek: tradingDaysOf(event)
    };
    const overlapsBooking = holdingBookings.some((booking) => rangesOverlap(event, booking));
    return toReportEvent(event, placement, { overlapsBooking, now });
  });

  // SERIES, register-wide. A tour is named once, from its earliest stop, so
  // every surface that prints the series prints the same words.
  const seriesMembers = new Map<string, ReportEvent[]>();
  register.forEach((event) => {
    seriesMembers.set(event.seriesKey, [...(seriesMembers.get(event.seriesKey) ?? []), event]);
  });
  seriesMembers.forEach((members) => {
    if (members.length < 2) return;
    const lead = [...members].sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name, "en")
    )[0];
    const label = `${seriesLabelFor(lead)} tour`;
    members.forEach((member) => {
      member.seriesLabel = label;
    });
  });

  /* --------------------------------------- the three decision selections */

  // TOP OPPORTUNITIES: the strongest eligible events. An unclear-relevance row
  // and a rejected row can never appear here, whatever they score — but a WATCH
  // event may: on a real corpus most events lack fee/visitor evidence and sit
  // in WATCH, and an empty "top opportunities" section helps nobody. The card
  // label carries the honest fit and confidence; eligibility does not inflate it.
  const eligible = register.filter(
    (event) =>
      !event.rejected &&
      event.vendorRelevance === "relevant" &&
      new Date(event.endsAt).getTime() >= now.getTime()
  );
  const topOpportunities = [...eligible]
    .sort(
      (a, b) =>
        RECOMMENDATION_ORDER[a.recommendation] - RECOMMENDATION_ORDER[b.recommendation] ||
        b.score - a.score ||
        a.startsAt.localeCompare(b.startsAt) ||
        a.name.localeCompare(b.name, "en")
    )
    .slice(0, MAX_TOP_OPPORTUNITIES);
  const topIds = new Set(topOpportunities.map((event) => event.id));

  // SECOND PASS: the action rules need to know whether an event is on the Top 5
  // (rule 6) and whether it collides with a booking (rule 5), so they run once
  // the selections above exist. The rule table itself is pure and unit-tested.
  register.forEach((event) => {
    event.action = actionFor({
      recommendation: event.recommendation,
      deadline: event.deadline,
      routeKind: event.contactRoute.kind,
      routeVerified: event.contactRoute.verified,
      missingFields: event.missingFields,
      overlapsBooking: event.overlapsBooking,
      weatherRiskFlags: event.weather.riskFlags,
      insideForecastWindow: event.insideForecastWindow,
      decisionCritical: topIds.has(event.id) || event.overlapsBooking,
      vendorRelevance: event.vendorRelevance
    });
  });

  // ACTION NOW: everything that carries an action, severity first. A far-future
  // deadline that closes this month belongs HERE, by its severity — not buried
  // in an appendix because the event itself is in 2027.
  //
  // With ONE exception, and it is the difference between a task list and a
  // pile: VERIFY CATEGORY AVAILABILITY on an event nobody is pursuing this week
  // is radar material. An open capacity question on a WATCH event is something
  // to find out, not something to do — so only a top-opportunity member of that
  // rule reaches the queue. The event keeps its action on its own register row;
  // it simply does not manufacture a task.
  const actionNow = register
    .filter(
      (event) =>
        event.action.action !== "NO ACTION" &&
        (event.action.action !== "VERIFY CATEGORY AVAILABILITY" || topIds.has(event.id))
    )
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.action.severity] - SEVERITY_ORDER[b.action.severity] ||
        (a.deadline.daysRemaining ?? 9_999) - (b.deadline.daysRemaining ?? 9_999) ||
        b.score - a.score ||
        a.name.localeCompare(b.name, "en")
    );

  // THE ACTION QUEUE: the same work, grouped into organizer-level tasks. This
  // is what the brief prints and what "action now" counts.
  const actionQueue = buildActionTasks(actionNow);
  const actionNowIds = new Set(actionNow.map((event) => event.id));

  // RADAR: the compact secondary table. What is being tracked but is neither on
  // the shortlist nor demanding an action this week.
  //
  // A touring operator's eight stops are ONE row here, expandable. Twenty rows
  // of the same festival in twenty towns is not a radar, it is a tour schedule,
  // and it crowded out everything else the owner had not seen.
  const radarCandidates = register
    .filter(
      (event) =>
        !event.rejected &&
        !topIds.has(event.id) &&
        !actionNowIds.has(event.id) &&
        new Date(event.endsAt).getTime() >= now.getTime()
    )
    .sort(
      (a, b) =>
        RECOMMENDATION_ORDER[a.recommendation] - RECOMMENDATION_ORDER[b.recommendation] ||
        b.score - a.score ||
        a.startsAt.localeCompare(b.startsAt) ||
        a.name.localeCompare(b.name, "en")
    );
  const radarSeries = buildSeriesRows(radarCandidates, (event) =>
    compactRange(event.startsAt, event.endsAt)
  ).slice(0, MAX_RADAR_ROWS);
  const radar = radarSeries.flatMap((row) => row.stops);

  const conflicts = register.filter((event) => !event.rejected && event.overlapsBooking);

  /* ------------------------------------------------------ deadline radar */

  // One row per event with a known future deadline, soonest first — drawn from
  // the WHOLE register, not a trading horizon. German applications open 8–11
  // months before the event, so a 2027 event's deadline this autumn is exactly
  // what the radar exists to surface.
  const deadlineRadar: ReportDeadlineRadarItem[] = register
    .filter(
      (event) =>
        !event.rejected &&
        event.deadline.evidence === "published" &&
        event.deadline.deadline !== undefined &&
        (event.deadline.daysRemaining ?? -1) >= 0
    )
    .map((event) => ({
      eventId: event.id,
      eventName: event.name,
      city: event.city,
      locationLine: event.locationLine,
      weekKey: event.weekKey,
      deadline: event.deadline.deadline!,
      deadlineLabel: fullDate(event.deadline.deadline!),
      daysRemaining: event.deadline.daysRemaining!,
      severity: event.deadline.severity,
      routeStatus: event.contactRoute.statusLine,
      recommendedAction: event.action.action
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining || a.eventName.localeCompare(b.eventName, "en"));

  /* ------------------------------------------------------------ weather */

  const weatherRowFor = (event: ReportEvent, relevance: string): ReportWeatherRow => ({
    eventId: event.id,
    eventName: event.name,
    dateRange: event.dateRange,
    riskFlags: event.weather.riskFlags,
    fetchedAt: event.weather.fetchedAt,
    source: event.weather.source,
    relevance
  });

  const weatherAllRows = register
    .filter((event) => event.weather.present)
    .map((event) => weatherRowFor(event, event.weather.note))
    .sort((a, b) => a.eventName.localeCompare(b.eventName, "en"));

  // The brief carries only the rows a decision turns on: a risk flag on
  // something booked, shortlisted, or inside the forecast window. Everything
  // else stays in the workbook — a page of "no risk flag raised" is not a brief.
  //
  // The in-window branch additionally requires the event to be WORK: a rain
  // flag on a theatre performance we have not established as a vendor
  // opportunity is not a decision, and nine of those would crowd out the one
  // market that matters. Booked and shortlisted events always qualify.
  const weatherDecisionRows = register
    .filter(
      (event) =>
        event.weather.present &&
        event.weather.riskFlags.length > 0 &&
        (event.overlapsBooking ||
          topIds.has(event.id) ||
          (event.insideForecastWindow && !event.rejected && event.vendorRelevance === "relevant"))
    )
    .map((event) =>
      weatherRowFor(
        event,
        event.overlapsBooking
          ? "collides with a booking"
          : topIds.has(event.id)
            ? "top opportunity"
            : "inside the 10-day forecast window"
      )
    )
    .sort((a, b) => a.eventName.localeCompare(b.eventName, "en"));

  /* ------------------------------------------------------------- drafts */

  // The strongest eligible events that have a recorded recipient. Whether the
  // route is confirmed reachable is stated, not assumed. The brief prints an
  // INDEX of these; the full German and English text lives in the workbook.
  const draftCandidates = register
    .filter((event) => !event.rejected && event.actionable && event.vendorRelevance === "relevant")
    .filter((event) => new Date(event.endsAt).getTime() >= now.getTime())
    .filter((event) => {
      const source = ranked.find((item) => item.id === event.id)!;
      return createVerificationDraft(source, event.weekKey, roleKeyFor(event.role)).channel !== "research";
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "en"))
    .slice(0, MAX_DRAFTS);

  const drafts: ReportDraft[] = draftCandidates.map((event) => {
    const source = ranked.find((item) => item.id === event.id)!;
    const plan = createVerificationDraft(source, event.weekKey, roleKeyFor(event.role));
    return {
      eventId: event.id,
      eventName: event.name,
      weekKey: event.weekKey,
      weeklyRole: event.role,
      channel: plan.channel,
      recipient: event.contactRoute.recipient,
      routeVerified: plan.routeVerified,
      routeNote: plan.routeVerified
        ? "Route confirmed reachable on the recorded source."
        : "Recipient recorded; the route has not yet been confirmed reachable.",
      subject: plan.subject,
      draftDe: plan.draftDe,
      draftEn: plan.draftEn,
      approvalNotice: APPROVAL_NOTICE
    };
  });

  /* --------------------------------------------------------------- KPIs */

  const kpis: ReportKpis = {
    eventsChecked: snapshot.events.length,
    vendorRelevant: considered.filter((event) => vendorRelevanceOf(event) === "relevant").length,
    shortlisted: register.filter(
      (event) => event.recommendation === "STRONG FIT" || event.recommendation === "GOOD FIT"
    ).length,
    recommended: register.filter((event) => event.recommendation === "STRONG FIT").length,
    actionNow: actionQueue.length,
    actionNowEvents: actionNow.length,
    upcomingDeadlines: deadlineRadar.filter((item) => item.daysRemaining <= 30).length,
    currentBookings: bookings.filter(
      (booking) => booking.lifecycle === "live" || booking.lifecycle === "upcoming"
    ).length,
    conflicts: conflicts.length
  };

  const urgentCount = actionQueue.filter((task) => task.urgency === "URGENT").length;
  const summarySentence =
    `${kpis.eventsChecked} events checked, ${kpis.vendorRelevant} vendor-relevant; ` +
    `${kpis.shortlisted} shortlisted and ${kpis.recommended} recommended outright. ` +
    `${kpis.actionNow} task${kpis.actionNow === 1 ? "" : "s"} covering ${
      kpis.actionNowEvents
    } event${kpis.actionNowEvents === 1 ? "" : "s"} need action now (${urgentCount} urgent), ` +
    `${kpis.upcomingDeadlines} deadline${kpis.upcomingDeadlines === 1 ? " closes" : "s close"} within 30 days, ` +
    `${kpis.currentBookings} booking${kpis.currentBookings === 1 ? "" : "s"} hold${
      kpis.currentBookings === 1 ? "s" : ""
    } the truck and ${kpis.conflicts} prospect${kpis.conflicts === 1 ? "" : "s"} collide${
      kpis.conflicts === 1 ? "s" : ""
    } with ${kpis.currentBookings === 1 ? "it" : "them"}.`;

  /* ----------------------------------------------------- pipeline counts */

  const pipelineOrder: PipelineLabel[] = [
    "Discovered",
    "Verifying",
    "Ready to contact",
    "Contacted",
    "Applied",
    "Booked",
    "Lost",
    "Expired",
    "Completed"
  ];
  const pipelineCounts = pipelineOrder
    .map((label) => ({
      label,
      count: register.filter((event) => event.pipelineLabel === label).length
    }))
    .filter((row) => row.count > 0);

  /* ------------------------------------------------------ system health */

  const evidenceRecords =
    snapshot.events.reduce((total, event) => total + event.sources.length, 0) +
    snapshot.bookings.reduce((total, booking) => total + booking.sources.length, 0);
  const withOrganizer = register.filter((event) => Boolean(event.organizer)).length;
  const withVerifiedRoute = register.filter((event) => event.contactRoute.verified).length;
  const withDeadlineEvidence = register.filter((event) => event.deadline.evidence !== "unknown").length;
  const withWeather = register.filter((event) => event.weather.present).length;
  const sourceHealthCounts = new Map<string, number>();
  snapshot.sources.forEach((source) => {
    const state = source.healthState ?? "never_checked";
    sourceHealthCounts.set(state, (sourceHealthCounts.get(state) ?? 0) + 1);
  });

  const percentage = (part: number, whole: number) =>
    whole === 0 ? `${part} of 0` : `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;

  const systemHealth: ReportSystemHealth = {
    eventsCollected: snapshot.events.length,
    registeredSources: snapshot.sources.length,
    noiseExcluded: excluded.length,
    organizerCoverage: percentage(withOrganizer, register.length),
    verifiedRoutes: percentage(withVerifiedRoute, register.length),
    deadlineEvidence: percentage(withDeadlineEvidence, register.length),
    weatherCoverage: percentage(withWeather, register.length),
    evidenceRecords,
    unresolvedLocations: register.filter((event) => !event.locationVerified).length,
    relevanceUnverified: register.filter((event) => event.vendorRelevance === "unclear").length,
    mode: snapshot.mode,
    modeStatement:
      snapshot.mode === "postgres"
        ? "Built from the PostgreSQL catalogue."
        : "Built from the committed fixture catalogue, not a live database read.",
    sourceHealth: [...sourceHealthCounts.entries()]
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => a.state.localeCompare(b.state))
  };

  /* ------------------------------------------------------- freshness */

  const freshnessStamps = snapshot.sources
    .map((source) => source.lastSuccessAt ?? source.lastCheckedAt)
    .filter((value): value is string => Boolean(value));
  const newest = freshnessStamps.sort().at(-1) ?? snapshot.discovery.lastObservedAt;
  const dataFreshness = newest
    ? (() => {
        const ageDays = -daysBetweenDays(newest, now);
        return `newest source collection ${fullDate(newest)} (${
          ageDays <= 0 ? "today" : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`
        })`;
      })()
    : "no source collection recorded yet";

  const profile = snapshot.profile;
  const operatorProfileLine =
    `speciality food truck · home region ${profile.homeRegion} · trades ${weekdayList(profile.normalDays)}` +
    `${profile.optionalThursday ? " (Thursday optional)" : ""} · up to ${
      profile.preferredMaxTravelMinutes
    } min travel, exceptionally ${profile.exceptionalMaxTravelMinutes} min`;

  return {
    product: PRODUCT_NAME,
    tagline: PRODUCT_TAGLINE,
    isoWeek: bounds.key,
    weekStart: civilDayKey(bounds.monday),
    weekEnd: civilDayKey(bounds.sunday),
    weekRangeLabel: rangeLabel(civilDayKey(bounds.monday), civilDayKey(bounds.sunday)),
    reportDateLabel: fullDate(berlinDayKey(now)),
    generatedAt: now.toISOString(),
    generatedAtLabel: `${BERLIN_STAMP.format(now)} Europe/Berlin`,
    operatorProfileLine,
    dataFreshness,
    mode: snapshot.mode,
    modeStatement: systemHealth.modeStatement,
    horizonWeeks: HORIZON_WEEKS,
    kpis,
    summarySentence,
    actionNow,
    actionQueue,
    topOpportunities,
    radar,
    radarSeries,
    register,
    pipelineCounts,
    bookings,
    blockedWeeks,
    conflicts,
    deadlineRadar,
    weatherDecisionRows,
    weatherAllRows,
    systemHealth,
    drafts,
    totals: {
      events: snapshot.events.length,
      actionableEvents: register.filter((event) => event.actionable).length,
      sources: snapshot.sources.length,
      evidenceRecords,
      excludedIrrelevant: excluded.length,
      unclearRelevance: systemHealth.relevanceUnverified
    },
    relevanceStatement: relevanceStatementFor(excluded.length),
    evidenceStatement: EVIDENCE_STATEMENT,
    registerPointer: REGISTER_POINTER
  };
}

/* --------------------------------------------- the shared briefing view */

/**
 * THE KPI ROW, DERIVED ONCE.
 *
 * The private web used to compute its own hero numbers from the same snapshot
 * and land somewhere else — two derivations, two answers, and an owner with no
 * way to tell which one was the product. Both surfaces now read THIS, so the
 * command centre and the brief cannot disagree: they are the same arithmetic.
 */
export function buildKpis(snapshot: ProductSnapshot, now: Date): ReportKpis {
  return buildWeeklyReport(snapshot, now).kpis;
}

export type { BriefingOrganizer, BriefingView } from "../src/briefing";

/** A missing fact the owner could close with one question. */
const OPEN_QUESTION_PATTERN = /(capacity|kapazit|category|kategorie|fee|gebühr|gebuehr|standgeld|places|plätze|platz|slot|pitch)/i;

export function buildBriefingView(snapshot: ProductSnapshot, now: Date): BriefingView {
  const report = buildWeeklyReport(snapshot, now);
  const taskByOrganizer = new Map(report.actionQueue.map((task) => [task.organizerName, task]));

  const grouped = new Map<string, ReportEvent[]>();
  report.register.forEach((event) => {
    const identity = organizerIdentityFor(event);
    if (identity.kind !== "organizer") return;
    grouped.set(identity.name, [...(grouped.get(identity.name) ?? []), event]);
  });

  const organizers: BriefingOrganizer[] = [...grouped.entries()]
    .map(([name, events]) => {
      const task = taskByOrganizer.get(name);
      const contact =
        task?.resolvedContact ??
        [...events].sort(
          (a, b) =>
            (b.contactRoute.person ? 1 : 0) - (a.contactRoute.person ? 1 : 0) ||
            (b.contactRoute.email ? 1 : 0) - (a.contactRoute.email ? 1 : 0) ||
            (b.contactRoute.phone ? 1 : 0) - (a.contactRoute.phone ? 1 : 0) ||
            a.id.localeCompare(b.id)
        )[0].contactRoute;
      return {
        name,
        contactPerson: contact.person,
        contactEmail: contact.email,
        contactPhone: contact.phone,
        contactLine: contact.line,
        contactStatus: contact.statusLine,
        openQuestions: events.reduce(
          (total, event) =>
            total + event.missingFields.filter((field) => OPEN_QUESTION_PATTERN.test(field)).length,
          0
        ),
        eventCount: events.length,
        nextAction: task?.nextAction ?? "—"
      };
    })
    .sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name, "en"));

  return {
    generatedAt: report.generatedAt,
    kpis: report.kpis,
    summarySentence: report.summarySentence,
    pipelineCounts: report.pipelineCounts,
    // Already future-only and soonest-first; the web shows the top five.
    deadlineRadar: report.deadlineRadar.slice(0, 5),
    bookings: report.bookings,
    actionQueue: report.actionQueue,
    organizers
  };
}

/* ------------------------------------------------------------ the brief */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function num(value: number): string {
  return String(value);
}

/**
 * An href is only ever built from a URL we have already established is a public
 * http(s) address. Anything else (a javascript: or data: string that reached the
 * catalogue) is printed as text and never linked.
 */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A dialable href for a recorded phone number; separators are display-only. */
function telHref(phone: string): string | undefined {
  const compacted = phone.replace(/[^\d+]/g, "");
  return /^\+?\d{6,}$/.test(compacted) ? `tel:${compacted}` : undefined;
}

function mailtoHref(email: string): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) ? `mailto:${email}` : undefined;
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** "Source: Stadt Halle · seen 12 Sep 2026", the URL behind the publisher. */
function routeEvidenceHtml(evidence: ReportRouteEvidence | undefined): string {
  if (!evidence) return "";
  const seen = evidence.observedAt ? ` · seen ${escapeHtml(fullDate(evidence.observedAt))}` : "";
  const href = safeHref(evidence.url);
  const publisher = escapeHtml(evidence.publisher || hostLabel(evidence.url));
  return `<span class="src">Source: ${href ? link(href, evidence.publisher || hostLabel(evidence.url)) : publisher}${seen}</span>`;
}

/**
 * THE ROUTE, AS SOMETHING THE OWNER CAN ACT ON.
 *
 * Wherever the catalogue holds a way in, the card prints it clickably — a named
 * person with mailto:/tel:, else the application portal, else the organizer
 * site — with the page it was read from beside it. An action card without its
 * route is not actionable, which is why both card renderers use this one
 * function. Where nothing is recorded it says so, in the same place.
 */
function renderRouteHtml(route: ReportContactRoute): string {
  const pieces: string[] = [];
  if (route.kind === "named") {
    const who = [route.person, route.personRole ? `(${route.personRole})` : undefined]
      .filter(Boolean)
      .join(" ");
    if (who) pieces.push(`<strong>${escapeHtml(who)}</strong>`);
    else if (route.recipient) pieces.push(escapeHtml(route.recipient));
    if (route.email) {
      const href = mailtoHref(route.email);
      pieces.push(href ? link(href, route.email) : escapeHtml(route.email));
    }
    if (route.phone) {
      const href = telHref(route.phone);
      pieces.push(href ? link(href, route.phone) : escapeHtml(route.phone));
    }
  } else if (route.kind === "application_url" && route.url) {
    const href = safeHref(route.url);
    pieces.push(
      `Apply via ${href ? link(href, hostLabel(route.url)) : escapeHtml(hostLabel(route.url))}`
    );
    if (route.recipient) pieces.push(escapeHtml(route.recipient));
  } else if (route.kind === "organizer_site" && route.url) {
    const href = safeHref(route.url);
    pieces.push(
      `Organizer site ${href ? link(href, hostLabel(route.url)) : escapeHtml(hostLabel(route.url))}`
    );
    if (route.urlPublisher) pieces.push(escapeHtml(route.urlPublisher));
    pieces.push("no named decision-maker recorded yet");
  } else {
    pieces.push(escapeHtml(route.statusLine));
  }
  const confirmation =
    route.kind === "named" || route.kind === "application_url"
      ? route.verified
        ? "route confirmed reachable"
        : "reachability not yet confirmed"
      : "";
  if (confirmation) pieces.push(confirmation);
  const evidence = routeEvidenceHtml(route.evidence);
  return `<span class="route">${pieces.join(" · ")}</span>${evidence}`;
}

/** "LOW CONFIDENCE — route unconfirmed; fee, capacity +3 more facts open". */
function confidenceHtml(event: ReportEvent): string {
  return `${escapeHtml(event.confidence)} CONFIDENCE — <span class="cause">${escapeHtml(
    event.confidenceCause
  )}</span>`;
}

/**
 * The brief's stylesheet.
 *
 * A4 portrait is 210mm wide; with the 16mm print margin the usable column is
 * 178mm. EVERY rule here exists to keep content inside that column:
 *   · the sheet is capped at 210mm and never sized by its content
 *   · every table is `table-layout: fixed` with declared column fractions
 *   · every cell, list item and link may break mid-token (a URL is one word)
 *   · no `white-space: nowrap` on anything that can hold arbitrary text
 *   · no multi-column grid whose columns are content-sized
 *
 * Colour is a SEMANTIC AID ONLY. Every severity and verdict also carries a word
 * and a border weight, so the brief reads correctly printed in monochrome.
 */
const BRIEF_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f4f2ed;
  color: #1c1d1a;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  font-size: 10pt;
  line-height: 1.45;
}
.sheet { max-width: 210mm; margin: 0 auto; background: #fffdf8; padding: 16mm 16mm; overflow-wrap: break-word; }
h1, h2, h3, h4 { font-weight: 600; margin: 0; letter-spacing: -0.01em; }
p { margin: 0 0 0.55em; }
a { color: #2f4f3f; text-decoration: none; border-bottom: 1px solid rgba(47, 79, 63, 0.35); overflow-wrap: anywhere; }
td, th, li, p { overflow-wrap: break-word; }
table { max-width: 100%; }
.masthead { border-bottom: 2px solid #1c1d1a; padding-bottom: 9px; margin-bottom: 14px; }
.masthead .wordmark { font-size: 21pt; letter-spacing: -0.02em; }
.masthead .tagline { font-size: 8.5pt; letter-spacing: 0.16em; text-transform: uppercase; color: #6b6a63; margin-top: 3px; }
.masthead .meta { display: flex; flex-wrap: wrap; gap: 5px 22px; margin-top: 10px; font-size: 8pt; color: #4a4a44; }
.masthead .meta span strong { display: block; font-size: 7pt; letter-spacing: 0.12em; text-transform: uppercase; color: #8c8b82; font-weight: 600; }
.masthead .profile { font-size: 8.5pt; color: #43433d; margin-top: 8px; }
section { margin: 0 0 16px; }
section > h2 {
  font-size: 8.5pt; letter-spacing: 0.18em; text-transform: uppercase; color: #8c8b82;
  border-bottom: 1px solid #ddd9cf; padding-bottom: 4px; margin-bottom: 9px;
}
.lede { font-size: 9pt; color: #43433d; margin-bottom: 0.7em; }
.empty { font-size: 9pt; color: #6b6a63; font-style: italic; }

/* KPI row — equal fractions, so a long number can never widen the page. */
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #e6e2d8; border: 1px solid #e6e2d8; margin-bottom: 9px; }
.kpis .cell { background: #fffefb; padding: 5px 7px; min-width: 0; }
.kpis .k { display: block; font-size: 6.5pt; letter-spacing: 0.1em; text-transform: uppercase; color: #8c8b82; overflow-wrap: anywhere; }
.kpis .v { display: block; font-size: 14pt; font-variant-numeric: tabular-nums; }
.summary { font-size: 9.5pt; border-left: 3px solid #1c1d1a; padding-left: 9px; margin-bottom: 4px; }

/* Action and opportunity cards. On screen the group is a plain block — the
   cards stack down the page at full width, exactly as before. The wrapper
   exists so that PAPER can flow the same cards into two columns without a
   single word of the brief changing. */
.cards { display: block; }
.card { border: 1px solid #e2ded3; background: #fffefb; padding: 9px 11px; margin-bottom: 7px; break-inside: avoid; }
.card.urgent { border-left: 4px solid #8a2f2f; }
.card.soon { border-left: 4px solid #8a6a2f; }
.card.watch { border-left: 4px solid #b3ada0; }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.card-head h3 { font-size: 11.5pt; }
.card-head .badge { font-size: 7pt; letter-spacing: 0.1em; text-transform: uppercase; color: #43433d; border: 1px solid #1c1d1a; padding: 0 4px; }
.card-head .badge.urgent { background: #f6e6e6; }
.card-head .badge.soon { background: #f6f0e2; }
.sub { font-size: 8.5pt; color: #6b6a63; margin-top: 2px; }
.verdict { font-size: 9pt; margin: 5px 0 3px; letter-spacing: 0.02em; }
.verdict strong { letter-spacing: 0.06em; }
.facts { margin: 4px 0 0; padding: 0; list-style: none; font-size: 8.5pt; }
.facts > li { padding: 2px 0; border-top: 1px dotted #e6e2d8; overflow-wrap: anywhere; }
.facts > li:first-child { border-top: 0; }
.facts .k { display: inline-block; min-width: 96px; padding-right: 8px; vertical-align: top; font-size: 7pt; letter-spacing: 0.1em; text-transform: uppercase; color: #8c8b82; }
.why { margin: 4px 0 0; padding-left: 15px; font-size: 8.5pt; }
.why li { margin-bottom: 1px; }
.next { margin-top: 5px; font-size: 9pt; border-top: 1px solid #e6e2d8; padding-top: 4px; }
.next .label { font-size: 7pt; letter-spacing: 0.1em; text-transform: uppercase; color: #8c8b82; margin-right: 6px; }
.missing { color: #8a5a2b; }
/* The cause is never allowed to be louder than the level it explains. */
.verdict .cause { font-weight: 400; letter-spacing: 0; color: #4a4a44; overflow-wrap: anywhere; }
/* A route may carry an email, a phone and a long portal URL. It wraps rather
   than pushing the A4 column open — the href stays the full address. */
.route { display: inline; overflow-wrap: anywhere; word-break: break-word; }
.src { display: block; margin-top: 1px; font-size: 7pt; color: #8c8b82; overflow-wrap: anywhere; }
.src a { color: #6a6a62; }
.tag {
  font-size: 7pt; letter-spacing: 0.04em; text-transform: uppercase; color: #8a6a2f;
  border: 0.5pt solid #d8c69a; border-radius: 2pt; padding: 0 3pt;
}

/* Compact tables. Fixed layout + declared fractions + breakable cells. */
.grid { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 8pt; }
.grid th, .grid td { border-bottom: 1px solid #e6e2d8; padding: 3px 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.grid th { font-size: 7pt; letter-spacing: 0.1em; text-transform: uppercase; color: #8c8b82; }
.grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
.grid tr.urgent td:first-child { border-left: 3px solid #8a2f2f; padding-left: 5px; }
.grid tr.soon td:first-child { border-left: 3px solid #8a6a2f; padding-left: 5px; }

.health { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #e6e2d8; border: 1px solid #e6e2d8; font-size: 8pt; }
.health .cell { background: #fffefb; padding: 4px 6px; min-width: 0; }
.health .k { display: block; font-size: 6.5pt; letter-spacing: 0.08em; text-transform: uppercase; color: #8c8b82; overflow-wrap: anywhere; }
.health .v { display: block; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

footer { border-top: 2px solid #1c1d1a; padding-top: 8px; margin-top: 18px; font-size: 8pt; color: #4a4a44; }
.page-break { break-after: page; page-break-after: always; height: 0; }

/* The section jumps. One quiet line under the masthead: on screen it is a
   navigation bar, on paper it is a contents line, and in the PDF Chromium turns
   each entry into a real internal link. No underlines — the separators carry
   the rhythm instead. */
.brief-nav {
  font-size: 7.5pt; letter-spacing: 0.1em; text-transform: uppercase; color: #6b6a63;
  border-bottom: 1px solid #ddd9cf; padding-bottom: 7px; margin: -6px 0 14px;
}
.brief-nav a { color: #43433d; border-bottom: 0; }
.brief-nav a + a { margin-left: 0; }
.brief-nav .sep { color: #b3ada0; padding: 0 6px; }

/* The private edition's link back into the running product. */
.applink { font-size: 7.5pt; letter-spacing: 0.08em; text-transform: uppercase; }
.card .applink { display: block; margin-top: 4px; }

/* Disclosures: the screen folds a tour or a task's members away; paper cannot
   be clicked, so print opens every one of them. */
details { margin: 4px 0 0; font-size: 8.5pt; }
details > summary { cursor: pointer; color: #43433d; }
details ul { margin: 3px 0 0; padding-left: 15px; }
details li { margin-bottom: 1px; overflow-wrap: anywhere; }
.card details.members { border-top: 1px dotted #e6e2d8; padding-top: 3px; }

/* ------------------------------------------------------------------ paper.
   THE PRINT EDITION IS DENSER, NOT SHORTER.

   The founder reads this on paper in a normal week and wants the decision to
   fit a handful of sheets. Every rule below is a MEASUREMENT change — type
   size, leading, padding, column count. Nothing is hidden, nothing is dropped:
   the same six anchors, the same cards, the same tables, every disclosure
   still forced open, every link still live. What goes away is the screen's
   air, which paper does not need.

   The two card sections flow into two columns; at 178mm of usable A4 column
   that is 85mm a card, which carries a card's longest line (a portal URL)
   without breaking the page box, because every cell and route already wraps
   mid-token. break-inside:avoid keeps a card whole across the column and
   page boundary.

   Printed measurements are in pt because the page is a physical object: 8.4pt
   on 1.3 leading is a working-document size, not a fine-print size. */
@media print {
  body { background: #fff; font-size: 8.4pt; line-height: 1.3; }
  .sheet { padding: 0; max-width: none; background: #fff; }
  a { color: #1c1d1a; border-bottom: 0; }
  p { margin: 0 0 0.35em; }

  .masthead { padding-bottom: 4px; margin-bottom: 6px; }
  .masthead .wordmark { font-size: 13pt; }
  .masthead .tagline { font-size: 7pt; margin-top: 2px; }
  .masthead .meta { gap: 1px 14px; margin-top: 4px; font-size: 6.4pt; }
  .masthead .meta span strong { font-size: 5.8pt; }
  .masthead .profile { font-size: 6.8pt; margin-top: 3px; }

  .brief-nav { font-size: 6.4pt; padding-bottom: 4px; margin: -4px 0 8px; border-bottom-color: #c9c4b8; }

  section { margin: 0 0 8px; }
  section > h2 { font-size: 7pt; padding-bottom: 2px; margin-bottom: 4px; }
  .lede { font-size: 7pt; margin-bottom: 0.3em; }
  .empty { font-size: 7.6pt; }

  /* Eight counts, one line. On screen they wrap to two rows of four; on A4
     there is room for all eight side by side, which buys back a whole band. */
  .kpis { grid-template-columns: repeat(8, 1fr); margin-bottom: 6px; }
  .kpis .cell { padding: 2px 4px; }
  .kpis .k { font-size: 5.4pt; letter-spacing: 0.04em; }
  .kpis .v { font-size: 9pt; }
  .summary { font-size: 7.8pt; padding-left: 6px; margin-bottom: 2px; }

  .cards { column-count: 2; column-gap: 5mm; }
  .cards > .card { break-inside: avoid; margin: 0 0 3px; }
  .card { padding: 3px 6px; margin-bottom: 3px; line-height: 1.2; }
  .card-head { gap: 5px; }
  .card-head h3 { font-size: 8.4pt; }
  .card-head .badge { font-size: 5.6pt; }
  .sub { font-size: 6.4pt; }
  .verdict { font-size: 7.4pt; margin: 2px 0 1px; }
  .facts { font-size: 7pt; margin-top: 2px; }
  .facts > li { padding: 0; }
  .facts .k { min-width: 52px; padding-right: 4px; font-size: 5.6pt; }
  /* "Why it fits" is a handful of short phrases. On screen they are a bulleted
     list; on paper, in an 85mm column, each bullet buys a line break it does
     not need — so the same phrases run on, separated by the same middot the
     rest of the brief uses. Every phrase survives. */
  .why { font-size: 7pt; padding-left: 0; margin-top: 2px; list-style: none; }
  .why li { display: inline; }
  .why li + li::before { content: " · "; color: #8c8b82; }
  .next { font-size: 7pt; margin-top: 2px; padding-top: 2px; }
  .next .label { font-size: 5.8pt; margin-right: 4px; }
  .src { font-size: 5.8pt; }
  .tag { font-size: 5.8pt; }
  .applink { font-size: 6.4pt; }

  /* The tables are the reference half: they are read by looking things up,
     which tolerates a smaller face than the cards that are read as prose. */
  .grid { font-size: 6.8pt; }
  .grid th, .grid td { padding: 1.5px 4px; }
  .grid th { font-size: 5.8pt; }

  .health { grid-template-columns: repeat(6, 1fr); font-size: 6.8pt; }
  .health .cell { padding: 2px 4px; }
  .health .k { font-size: 5.4pt; }

  details { font-size: 7.4pt; margin-top: 3px; }
  details ul { padding-left: 11px; }

  /* THE RADAR'S TOUR STOPS WERE THE WHOLE PROBLEM.
     Print forces every disclosure open, and a tour's stops opened inside a
     23%-wide name cell: eleven stops cost eleven bulleted blocks, each of them
     wrapping to four lines in a 40mm column — one tour ate two thirds of a
     page. Paper gets the same eleven stops as ONE run-on line, in a cell wide
     enough to hold it. Nothing is removed; the stops simply stop being a
     column of near-empty bullets.
     The column fractions are forced because the widths they override are
     inline style attributes on the col elements — the only place in
     this stylesheet where that is true, and the reason it is written here. */
  .radar col:nth-child(1) { width: 36% !important; }
  .radar col:nth-child(2) { width: 10% !important; }
  .radar col:nth-child(3) { width: 12% !important; }
  .radar col:nth-child(4) { width: 7% !important; }
  .radar col:nth-child(5) { width: 6% !important; }
  .radar col:nth-child(6) { width: 10% !important; }
  .radar col:nth-child(7) { width: 10% !important; }
  .radar col:nth-child(8) { width: 9% !important; }
  .radar details { font-size: 6.6pt; margin-top: 1px; }
  .radar details > summary { font-size: 6.8pt; }
  .radar ul.stops { margin: 1px 0 0; padding-left: 0; list-style: none; }
  .radar ul.stops > li { display: inline; margin: 0; }
  .radar ul.stops > li + li::before { content: " · "; color: #8c8b82; }

  footer { margin-top: 10px; padding-top: 5px; font-size: 6.8pt; }
  footer p { margin: 0 0 0.2em; }

  details > summary { list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary ~ * { display: block !important; }
  /* display:block alone does NOT open a closed <details> in Chromium 131+:
     the folded content lives behind ::details-content, which the UA stylesheet
     hides with content-visibility. Verified by printing the brief and reading
     the PDF back — the tour stops and the task members were missing until this
     rule was added. Browsers without the pseudo-element drop this rule only. */
  details::details-content { content-visibility: visible !important; block-size: auto !important; }
}
@page { size: A4; margin: 16mm; }
`.trim();

function severityClass(severity: ActionSeverity): string {
  return severity === "URGENT" ? "urgent" : severity === "SOON" ? "soon" : "watch";
}

function relevanceTagHtml(event: ReportEvent): string {
  return event.vendorRelevance === "unclear"
    ? ` <span class="tag">${escapeHtml(VENDOR_UNCLEAR_TAG)}</span>`
    : "";
}

/**
 * C — ONE TASK CARD. An organizer, the way in, the dates the call is about,
 * and the single ask. The member events sit underneath in a disclosure, because
 * the owner acts on the organizer and reads the events only to make the call.
 * Print CSS opens every disclosure: paper has no triangles to click.
 */
/**
 * THE SECTION ANCHORS. The nav strip, the PDF's internal links and the headings
 * all read from this one list, so a renamed section can never leave a nav entry
 * pointing at an id that no longer exists.
 */
export const BRIEF_SECTIONS = [
  { id: "overview", nav: "Overview", heading: "Where we stand" },
  { id: "action-now", nav: "Action now", heading: "Action now" },
  { id: "top-opportunities", nav: "Top opportunities", heading: "Top opportunities" },
  { id: "deadlines", nav: "Deadlines", heading: "Deadline radar" },
  { id: "bookings", nav: "Bookings", heading: "Bookings &amp; conflicts" },
  { id: "system-health", nav: "System health", heading: "System health" }
] as const;

export interface BriefRenderOptions {
  /**
   * The origin of the running private product. PRESENT ONLY in the private
   * edition: the public and sample editions carry no link into an app their
   * reader cannot open.
   */
  appBase?: string;
}

/** Trailing slashes removed, and only http(s) accepted — nothing else is a base. */
function normalizeAppBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The link back into the product. The SPA holds its view in React state and
 * reads no route, no hash and no history entry, so there is no per-event URL to
 * point at: this opens PitchRadar, and says so. Inventing `/events/<id>` would
 * hand the owner a link that lands on the command centre and pretends not to.
 */
function appLinkHtml(appBase: string | undefined, label: string): string {
  if (!appBase) return "";
  return `<a class="applink" href="${escapeHtml(appBase)}/">${escapeHtml(label)} in PitchRadar →</a>`;
}

function renderTaskCard(task: ReportTask, appBase?: string): string {
  const klass = severityClass(task.urgency);
  const members = task.events
    .map(
      (member) =>
        `<li><strong>${escapeHtml(member.name)}</strong> · ${escapeHtml(
          member.dateRange
        )} · ${escapeHtml(member.locationLine)} · ${escapeHtml(member.recommendation)} · ${escapeHtml(
          member.deadlineLine
        )}</li>`
    )
    .join("");
  return `<article class="card ${klass}">
<div class="card-head"><div><h3>${escapeHtml(task.organizerName)}</h3><p class="sub">${num(
    task.events.length
  )} event${task.events.length === 1 ? "" : "s"} · ${escapeHtml(
    task.action
  )}</p></div><span class="badge ${klass}">${escapeHtml(task.urgency)}</span></div>
<ul class="facts">
<li><span class="k">Contact</span>${renderRouteHtml(task.resolvedContact)}</li>
<li><span class="k">Priority dates</span>${escapeHtml(task.priorityDates.join(" · "))}</li>
<li><span class="k">Confidence</span>${escapeHtml(task.confidence)} — best of the ${num(
    task.events.length
  )} event${task.events.length === 1 ? "" : "s"} behind this task</li>
</ul>
<details class="members"><summary>${num(task.events.length)} event${
    task.events.length === 1 ? "" : "s"
  } behind this task</summary><ul>${members}</ul></details>
<p class="next"><span class="label">Do this</span>${escapeHtml(task.nextAction)}</p>
${appLinkHtml(appBase, "Open the queue")}
</article>`;
}

/** D — one opportunity card. No score-component grid: that lives in the register. */
function renderOpportunityCard(event: ReportEvent, appBase?: string): string {
  const why = event.whyItFits.length
    ? `<ul class="why">${event.whyItFits.map((phrase) => `<li>${escapeHtml(phrase)}</li>`).join("")}</ul>`
    : `<p class="empty">The score carries no standout component; it fits on the basics.</p>`;
  const unknowns = event.missingFields.length
    ? `<li><span class="k">Key unknowns</span><span class="missing">${escapeHtml(
        event.missingFields.join("; ")
      )}</span></li>`
    : `<li><span class="k">Key unknowns</span>None outstanding</li>`;
  const weather =
    event.weather.present && event.insideForecastWindow
      ? `<li><span class="k">Weather</span>${escapeHtml(
          event.weather.riskFlags.length ? event.weather.riskFlags.join(", ") : "no risk flag raised"
        )}</li>`
      : "";
  return `<article class="card">
<div class="card-head"><div><h3>${escapeHtml(event.name)}</h3><p class="sub">${escapeHtml(
    event.dateRange
  )} · ${escapeHtml(event.locationLine)} · ${num(event.tradingDays)} trading day${
    event.tradingDays === 1 ? "" : "s"
  }</p></div><span class="badge">${escapeHtml(event.pipelineLabel)}</span></div>
<p class="verdict"><strong>${escapeHtml(event.recommendation)}</strong> · ${num(
    event.score
  )}/100 · ${confidenceHtml(event)}</p>
<ul class="facts">
<li><span class="k">Organizer</span>${escapeHtml(event.organizerLine)}</li>
<li><span class="k">Route</span>${renderRouteHtml(event.contactRoute)}</li>
<li><span class="k">Deadline</span>${escapeHtml(event.deadline.line)}</li>
${weather}
${unknowns}
</ul>
<p class="sub" style="margin-top:5px">Why it fits</p>
${why}
<p class="next"><span class="label">Next action</span>${escapeHtml(event.action.action)} — ${escapeHtml(
    event.applicationNextAction
  )}</p>
${appLinkHtml(appBase, "Open this opportunity")}
</article>`;
}

export function renderBriefHtml(report: WeeklyReport, options: BriefRenderOptions = {}): string {
  const appBase = normalizeAppBase(options.appBase);

  /* ------------------------------------------------------ A the nav strip */
  // Internal anchors, which Chromium's print path turns into real PDF links.
  const navStrip = `<nav class="brief-nav">${BRIEF_SECTIONS.map(
    (section) => `<a href="#${section.id}">${section.nav}</a>`
  ).join(`<span class="sep">·</span>`)}</nav>`;

  /* --------------------------------------------------- B executive summary */
  const kpiCells: Array<[string, number]> = [
    ["Events checked", report.kpis.eventsChecked],
    ["Vendor-relevant", report.kpis.vendorRelevant],
    ["Shortlisted", report.kpis.shortlisted],
    ["Recommended", report.kpis.recommended],
    ["Action now (tasks)", report.kpis.actionNow],
    ["Deadlines ≤30d", report.kpis.upcomingDeadlines],
    ["Current bookings", report.kpis.currentBookings],
    ["Conflicts", report.kpis.conflicts]
  ];
  const kpiRow = `<div class="kpis">${kpiCells
    .map(
      ([label, value]) =>
        `<div class="cell"><span class="k">${escapeHtml(label)}</span><span class="v">${num(
          value
        )}</span></div>`
    )
    .join("")}</div>`;

  /* ------------------------------------------------------- C action now */
  const actionSection = report.actionQueue.length
    ? report.actionQueue.map((task) => renderTaskCard(task, appBase)).join("")
    : `<p class="empty">Nothing is due this week. No deadline closes within 30 days, no booking is in conflict and no shortlisted event is waiting on us.</p>`;

  /* ------------------------------------------------ D top opportunities */
  const topSection = report.topOpportunities.length
    ? report.topOpportunities.map((event) => renderOpportunityCard(event, appBase)).join("")
    : `<p class="empty">No event currently reaches a STRONG or GOOD fit. Everything known is either watch-only or not yet established as a vendor opportunity.</p>`;

  /* ------------------------------------------------------------ E radar */
  // One row per SERIES. A tour's stops live inside the row's disclosure, so
  // eight towns of the same festival take one line and the rest of the radar
  // stays visible.
  const radarRowHtml = (row: ReportSeriesRow) => {
    const lead = row.stops[0];
    const nameCell = row.isSeries
      ? `<details><summary>${escapeHtml(row.label)} — ${escapeHtml(
          row.summaryLine
        )}</summary><ul class="stops">${row.stops
          .map(
            (stop) =>
              `<li>${escapeHtml(stop.name)} · ${escapeHtml(stop.locationLine)} · ${escapeHtml(
                stop.dateRange
              )}</li>`
          )
          .join("")}</ul></details>`
      : `${escapeHtml(lead.name)}${relevanceTagHtml(lead)}`;
    return `<tr><td>${nameCell}</td><td>${escapeHtml(
      row.isSeries ? `${row.stops.length} stops` : lead.dateRange
    )}</td><td>${escapeHtml(
      row.isSeries ? `${lead.locationLine} +${row.stops.length - 1} more` : lead.locationLine
    )}</td><td>${escapeHtml(lead.recommendation)}</td><td>${escapeHtml(
      lead.confidence
    )}</td><td>${escapeHtml(lead.pipelineLabel)}</td><td>${escapeHtml(
      lead.deadline.line
    )}</td><td>${escapeHtml(lead.contactRoute.statusLine)}</td></tr>`;
  };
  const radarSection = report.radarSeries.length
    ? `<table class="grid radar"><colgroup><col style="width:23%" /><col style="width:13%" /><col style="width:13%" /><col style="width:9%" /><col style="width:8%" /><col style="width:11%" /><col style="width:12%" /><col style="width:11%" /></colgroup>
<thead><tr><th>Event</th><th>Dates</th><th>Location</th><th>Fit</th><th>Conf.</th><th>Pipeline</th><th>Deadline</th><th>Contact</th></tr></thead>
<tbody>${report.radarSeries.map(radarRowHtml).join("")}</tbody></table>`
    : `<p class="empty">Nothing else is being tracked outside the shortlist and the action list.</p>`;

  /* ------------------------------------------ F bookings and conflicts */
  const upcoming = report.bookings.filter(
    (booking) => booking.lifecycle === "live" || booking.lifecycle === "upcoming"
  );
  const awaitingOutcome = report.bookings.filter(
    (booking) => booking.lifecycle === "completed_outcome_pending"
  );
  const otherBookings = report.bookings.filter(
    (booking) =>
      booking.lifecycle === "completed_outcome_recorded" || booking.lifecycle === "cancelled"
  );

  const bookingCard = (booking: ReportBooking) => `<article class="card">
<div class="card-head"><div><h3>${escapeHtml(booking.eventName)}</h3><p class="sub">${escapeHtml(
    booking.dateRange
  )} · ${escapeHtml(booking.city)}, ${escapeHtml(booking.state)}</p></div><span class="badge">${escapeHtml(
    booking.statusLine
  )}</span></div>
<ul class="facts">
<li><span class="k">Organizer</span>${escapeHtml(booking.organizer)}</li>
${booking.standOrZone ? `<li><span class="k">Stand / zone</span>${escapeHtml(booking.standOrZone)}</li>` : ""}
<li><span class="k">Weeks held</span>${
    booking.blockedWeeks.length ? escapeHtml(booking.blockedWeeks.join(", ")) : "None — the truck is free"
  }</li>
${
  booking.lifecycle === "completed_outcome_pending"
    ? `<li><span class="k">Still wanted</span><span class="missing">${escapeHtml(
        booking.missingOutcomeInputs.join("; ")
      )}</span></li>`
    : ""
}
</ul></article>`;

  const bookingSection = [
    upcoming.length
      ? `<p class="lede">Holding the truck now:</p>${upcoming.map(bookingCard).join("")}`
      : `<p class="empty">No booking currently holds the truck.</p>`,
    awaitingOutcome.length
      ? `<p class="lede">Completed — awaiting outcome capture. The booking is over; how it went is not yet recorded.</p>${awaitingOutcome
          .map(bookingCard)
          .join("")}`
      : "",
    otherBookings.length ? otherBookings.map(bookingCard).join("") : "",
    report.conflicts.length
      ? `<p class="lede">Prospects colliding with a booking that holds the truck:</p><table class="grid"><colgroup><col style="width:34%" /><col style="width:22%" /><col style="width:22%" /><col style="width:22%" /></colgroup><thead><tr><th>Event</th><th>Dates</th><th>Location</th><th>Action</th></tr></thead><tbody>${report.conflicts
          .map(
            (event) =>
              `<tr class="urgent"><td>${escapeHtml(event.name)}</td><td>${escapeHtml(
                event.dateRange
              )}</td><td>${escapeHtml(event.locationLine)}</td><td>${escapeHtml(
                event.action.action
              )}</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="empty">No prospect collides with a booking.</p>`
  ]
    .filter(Boolean)
    .join("");

  /* --------------------------------------------------- G deadline radar */
  const deadlineSection = report.deadlineRadar.length
    ? `<table class="grid"><colgroup><col style="width:28%" /><col style="width:16%" /><col style="width:14%" /><col style="width:8%" /><col style="width:10%" /><col style="width:24%" /></colgroup>
<thead><tr><th>Event</th><th>Location</th><th>Deadline</th><th class="num">Days</th><th>Urgency</th><th>Route &amp; action</th></tr></thead>
<tbody>${report.deadlineRadar
        .map(
          (item) =>
            `<tr class="${severityClass(item.severity)}"><td>${escapeHtml(
              item.eventName
            )}</td><td>${escapeHtml(item.locationLine)}</td><td>${escapeHtml(
              item.deadlineLabel
            )}</td><td class="num">${num(item.daysRemaining)}</td><td>${escapeHtml(
              item.severity
            )}</td><td>${escapeHtml(item.routeStatus)} → ${escapeHtml(
              item.recommendedAction
            )}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No event carries a published future deadline. Where a deadline is unknown the register says whether it was never found or whether the organizer runs rolling applications — those are different facts.</p>`;

  /* ----------------------------------------------------------- H weather */
  const weatherSection = report.weatherDecisionRows.length
    ? `<table class="grid"><colgroup><col style="width:30%" /><col style="width:20%" /><col style="width:24%" /><col style="width:26%" /></colgroup>
<thead><tr><th>Event</th><th>Dates</th><th>Risk flags</th><th>Why it is here</th></tr></thead>
<tbody>${report.weatherDecisionRows
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.eventName)}</td><td>${escapeHtml(
              row.dateRange
            )}</td><td>${escapeHtml(row.riskFlags.join(", "))}</td><td>${escapeHtml(
              row.relevance
            )}</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No decision this week turns on the weather: ${num(
        report.weatherAllRows.length
      )} forecast(s) are recorded and none raises a risk flag on a booked or shortlisted event inside the 10-day window. Every recorded forecast is in the register.</p>`;

  /* ---------------------------------------------------- I system health */
  const healthCells: Array<[string, string]> = [
    ["Events collected", num(report.systemHealth.eventsCollected)],
    ["Registered sources", num(report.systemHealth.registeredSources)],
    ["Noise excluded", num(report.systemHealth.noiseExcluded)],
    ["Organizer known", report.systemHealth.organizerCoverage],
    ["Routes verified", report.systemHealth.verifiedRoutes],
    ["Deadline evidence", report.systemHealth.deadlineEvidence],
    ["Weather coverage", report.systemHealth.weatherCoverage],
    ["Evidence records", num(report.systemHealth.evidenceRecords)],
    ["Locations unresolved", num(report.systemHealth.unresolvedLocations)],
    ["Relevance unverified", num(report.systemHealth.relevanceUnverified)],
    ["Catalogue mode", report.systemHealth.mode],
    [
      "Source health",
      report.systemHealth.sourceHealth.map((row) => `${row.state} ${row.count}`).join(", ") || "not checked"
    ]
  ];
  const healthGrid = `<div class="health">${healthCells
    .map(
      ([label, value]) =>
        `<div class="cell"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(
          value
        )}</span></div>`
    )
    .join("")}</div>`;

  /* ----------------------------------------------------------- J drafts */
  const draftSection = report.drafts.length
    ? `<table class="grid"><colgroup><col style="width:44%" /><col style="width:16%" /><col style="width:40%" /></colgroup>
<thead><tr><th>Event</th><th>Channel</th><th>Status</th></tr></thead>
<tbody>${report.drafts
        .map(
          (draft) =>
            `<tr><td>${escapeHtml(draft.eventName)}</td><td>${escapeHtml(
              draft.channel
            )}</td><td>Draft ready — owner approval required</td></tr>`
        )
        .join("")}</tbody></table>
<p class="sub">The full German text and English translation of each draft are in the register workbook, sheet "Organizer Drafts".</p>`
    : `<p class="empty">No event has a recorded organizer recipient, so no draft was written. ${escapeHtml(
        APPROVAL_NOTICE
      )}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(report.product)} — ${escapeHtml(report.tagline)} ${escapeHtml(report.isoWeek)}</title>
<style>
${BRIEF_CSS}
</style>
</head>
<body>
<div class="sheet">
<header class="masthead">
<div class="wordmark">${escapeHtml(report.product)}</div>
<div class="tagline">${escapeHtml(report.tagline)}</div>
<div class="meta">
<span><strong>Report date</strong>${escapeHtml(report.reportDateLabel)}</span>
<span><strong>Week</strong>${escapeHtml(report.isoWeek)} · ${escapeHtml(report.weekRangeLabel)}</span>
<span><strong>Generated</strong>${escapeHtml(report.generatedAtLabel)}</span>
<span><strong>Data freshness</strong>${escapeHtml(report.dataFreshness)}</span>
</div>
<p class="profile">${escapeHtml(report.operatorProfileLine)}</p>
</header>

${navStrip}

<section>
<h2 id="overview">Where we stand</h2>
${kpiRow}
<p class="summary">${escapeHtml(report.summarySentence)}</p>
</section>

<section>
<h2 id="action-now">Action now</h2>
<p class="lede">${escapeHtml(
    `${report.kpis.actionNow} task${report.kpis.actionNow === 1 ? "" : "s"} covering ${
      report.kpis.actionNowEvents
    } event${report.kpis.actionNowEvents === 1 ? "" : "s"}, most urgent first. One organizer, one call, every date it covers.`
  )}</p>
<div class="cards">${actionSection}</div>
</section>

<section>
<h2 id="top-opportunities">Top opportunities</h2>
<p class="lede">The strongest places to try to get the truck booked next. At most five; the full register carries the rest with the complete score arithmetic.</p>
<div class="cards">${topSection}</div>
</section>

<div class="page-break"></div>

<section>
<h2>Opportunity radar</h2>
<p class="lede">Tracked, but no task this week turns on them. A touring operator's stops are one row — open it to see every date; the register carries each stop on its own line.</p>
${radarSection}
</section>

<section>
<h2 id="bookings">Bookings &amp; conflicts</h2>
${bookingSection}
</section>

<section>
<h2 id="deadlines">Deadline radar</h2>
<p class="lede">Only deadlines with recorded evidence appear here, soonest first.</p>
${deadlineSection}
</section>

<section>
<h2>Weather</h2>
${weatherSection}
</section>

<section>
<h2 id="system-health">System health</h2>
<p class="lede">What the machine did this week. These are technical counts, not opportunities.</p>
${healthGrid}
</section>

<section>
<h2>Organizer drafts</h2>
<p class="lede">${escapeHtml(APPROVAL_NOTICE)}</p>
${draftSection}
</section>

<footer>
<p>${escapeHtml(report.evidenceStatement)}</p>
<p>${escapeHtml(report.relevanceStatement)}</p>
<p>${escapeHtml(report.registerPointer)}</p>
<p>${escapeHtml(report.modeStatement)}</p>
${
  appBase
    ? `<p>Private edition. The links marked "in PitchRadar" open ${escapeHtml(
        appBase
      )} — the product holds its view in memory and carries no per-event address, so they open the app, not the individual card.</p>`
    : ""
}
</footer>
</div>
</body>
</html>
`;
}

/* --------------------------------------------------------- the register */

type Sheet = import("exceljs").Worksheet;
type Cell = import("exceljs").Cell;
type CellValue = import("exceljs").CellValue;

/**
 * THE STATUS PALETTE. Every fill is light and every one of them keeps the word
 * it colours — URGENT stays the string "URGENT" — so the workbook reads the
 * same on a monochrome printout as it does on screen. Colour is a second
 * channel here, never the only one.
 */
const URGENCY_STYLE: Record<string, { font: string; fill?: string }> = {
  URGENT: { font: "FF9C0006", fill: "FFF7DDDD" },
  SOON: { font: "FF8A6A2F", fill: "FFFBF0D9" },
  WATCH: { font: "FF43433D" }
};

/** The fit bands. Subtle enough that a page of GOOD FIT rows stays readable. */
const FIT_FILL: Record<string, string> = {
  "STRONG FIT": "FFE2EDE4",
  "GOOD FIT": "FFF0F4EA"
};

const LINK_FONT = { color: { argb: "FF2F4F3F" }, underline: true } as const;

function headerRow(sheet: Sheet, labels: string[]) {
  const row = sheet.addRow(labels);
  row.font = { bold: true };
  row.alignment = { vertical: "bottom" };
  return row;
}

/**
 * The header stays on screen while the sheet scrolls, and carries the filter.
 * Both are operational, not decorative: a register of every event in the
 * catalogue is unusable without them.
 */
function freezeAndFilter(sheet: Sheet, columns: number) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, columns) } };
}

/** The visible text of a cell, whatever shape the value has. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Column widths MEASURED from the content, capped at 60 so one German draft
 * cannot push every other column off the screen. Derived from the cells, so the
 * same report always produces the same widths.
 */
function fitColumns(sheet: Sheet, options: { min?: number; max?: number } = {}) {
  const min = options.min ?? 10;
  const max = options.max ?? 60;
  sheet.columns.forEach((column) => {
    let widest = 0;
    column.eachCell?.({ includeEmpty: false }, (cell: Cell) => {
      for (const line of cellText(cell.value).split("\n")) {
        widest = Math.max(widest, line.length);
      }
    });
    column.width = Math.min(max, Math.max(min, widest + 2));
  });
}

/**
 * A real hyperlink with friendly text. A missing URL stays plain text — never
 * a dead link, and never a number where a link was expected.
 */
function linkValue(url: string | undefined, text: string): CellValue {
  const href = safeHref(url);
  if (!href) return text || "";
  return { text: text || href, hyperlink: href };
}

/** The same, for a recorded organizer address. An invalid address stays text. */
function mailValue(email: string | undefined): CellValue {
  if (!email) return "";
  const href = mailtoHref(email);
  return href ? { text: email, hyperlink: href } : email;
}

/** And for a recorded phone number, which a desk phone or a laptop can dial. */
function telValue(phone: string | undefined): CellValue {
  if (!phone) return "";
  const href = telHref(phone);
  return href ? { text: phone, hyperlink: href } : phone;
}

function applyLink(cell: Cell) {
  if (cell.value && typeof cell.value === "object" && "hyperlink" in cell.value) {
    cell.font = { ...LINK_FONT };
  }
}

/** Paints one status cell: the fill and the font, the word untouched. */
function paintUrgency(cell: Cell) {
  // Accepts both a bare "URGENT" and the register's "URGENT · Apply now".
  const style = URGENCY_STYLE[cellText(cell.value).trim().split(" ")[0]];
  if (!style) return;
  // A task row is bold as a whole; colouring its severity never un-bolds it.
  cell.font = { color: { argb: style.font }, bold: Boolean(cell.font?.bold || style.fill) };
  if (style.fill) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
  }
}

function paintFit(cell: Cell) {
  const fill = FIT_FILL[cellText(cell.value).trim()];
  if (!fill) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}

export async function renderRegisterXlsx(report: WeeklyReport): Promise<Buffer> {
  const workbook = new (loadExcelJs().Workbook)();
  const stamp = new Date(report.generatedAt);
  // Fixed metadata + a clock taken from the injected `now` so the same inputs
  // always describe the same document.
  workbook.creator = PRODUCT_NAME;
  workbook.lastModifiedBy = PRODUCT_NAME;
  workbook.created = stamp;
  workbook.modified = stamp;
  workbook.lastPrinted = stamp;
  workbook.company = PRODUCT_NAME;
  workbook.title = `${PRODUCT_NAME} — Operational Register ${report.isoWeek}`;
  workbook.subject = PRODUCT_TAGLINE;

  /* 1 — Dashboard: the business numbers. NOT the system counts. */
  const dashboard = workbook.addWorksheet("Dashboard");
  dashboard.columns = [{ width: 30 }, { width: 60 }];
  // A key/value sheet still gets a header row: the frozen pane and the filter
  // both need one, and "Field / Value" is what these two columns are.
  headerRow(dashboard, ["Field", "Value"]);
  [
    ["Report date", report.reportDateLabel],
    ["Reporting week", `${report.isoWeek} · ${report.weekRangeLabel}`],
    ["Generated", report.generatedAtLabel],
    ["Operator", report.operatorProfileLine],
    ["Data freshness", report.dataFreshness],
    ["", ""],
    ["Events checked", String(report.kpis.eventsChecked)],
    ["Vendor-relevant", String(report.kpis.vendorRelevant)],
    ["Shortlisted (strong + good)", String(report.kpis.shortlisted)],
    ["Recommended (strong)", String(report.kpis.recommended)],
    ["Need action now (tasks)", String(report.kpis.actionNow)],
    ["Events those tasks cover", String(report.kpis.actionNowEvents)],
    ["Deadlines closing within 30 days", String(report.kpis.upcomingDeadlines)],
    ["Bookings holding the truck", String(report.kpis.currentBookings)],
    ["Prospects in conflict", String(report.kpis.conflicts)],
    ["", ""],
    // The pipeline counts used to sit above the pipeline table on their own
    // sheet, which left that sheet with two header rows and therefore no
    // filterable one. They are summary numbers; they belong with the others.
    ...report.pipelineCounts.map((row) => [`Pipeline — ${row.label}`, String(row.count)]),
    ["", ""],
    ["Summary", report.summarySentence]
  ].forEach(([key, value]) => {
    const row = dashboard.addRow([key, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  });
  freezeAndFilter(dashboard, 2);
  fitColumns(dashboard);

  /**
   * 2 — Action Queue, KEYED BY TASK. A task row names the organizer, the route
   * and the one ask; each member event follows it on its own row, so the sheet
   * can be sorted or filtered without losing which call an event belongs to.
   */
  const queue = workbook.addWorksheet("Action Queue");
  queue.columns = [
    { width: 10 }, { width: 12 }, { width: 34 }, { width: 26 }, { width: 38 },
    { width: 24 }, { width: 24 }, { width: 14 }, { width: 12 }, { width: 26 },
    { width: 72 }, { width: 46 }
  ];
  headerRow(queue, [
    "Row", "Severity", "Task (organizer)", "Action", "Event",
    "Dates", "Location", "Fit", "Confidence", "Deadline",
    "Next action", "Contact route"
  ]);
  report.actionQueue.forEach((task) => {
    const taskRow = queue.addRow([
      "TASK",
      task.urgency,
      task.organizerName,
      task.action,
      `${task.events.length} event${task.events.length === 1 ? "" : "s"}`,
      task.priorityDates.join(" · "),
      "",
      "",
      task.confidence,
      "",
      task.nextAction,
      task.resolvedContact.url
        ? linkValue(task.resolvedContact.url, task.resolvedContact.line)
        : task.resolvedContact.email
          ? mailValue(task.resolvedContact.email)
          : task.resolvedContact.line
    ]);
    taskRow.font = { bold: true };
    paintUrgency(taskRow.getCell(2));
    applyLink(taskRow.getCell(12));
    task.events.forEach((member) => {
      const memberRow = queue.addRow([
        "event",
        member.severity,
        task.organizerName,
        member.action,
        member.name,
        member.dateRange,
        member.locationLine,
        member.recommendation,
        member.confidence,
        member.deadlineLine,
        "",
        ""
      ]);
      paintUrgency(memberRow.getCell(2));
      paintFit(memberRow.getCell(8));
    });
  });
  freezeAndFilter(queue, 12);
  fitColumns(queue);

  /* 3 — Opportunities: THE FULL REGISTER. Every non-irrelevant event. */
  const componentLabels = report.register
    .flatMap((event) => event.scoreBreakdown.map((part) => part.label))
    .filter((label, index, all) => all.indexOf(label) === index);

  const opportunities = workbook.addWorksheet("Opportunities");
  opportunities.columns = [
    { width: 38 }, { width: 24 }, { width: 22 }, { width: 18 }, { width: 16 },
    { width: 12 }, { width: 22 }, { width: 30 },
    { width: 14 }, { width: 12 }, { width: 52 }, { width: 8 }, { width: 8 },
    ...componentLabels.map(() => ({ width: 14 })),
    { width: 18 }, { width: 18 }, { width: 26 }, { width: 30 }, { width: 34 }, { width: 50 },
    { width: 54 }, { width: 34 }, { width: 22 }, { width: 26 },
    { width: 50 }, { width: 46 }, { width: 18 }, { width: 28 }, { width: 10 }, { width: 14 }
  ];
  headerRow(opportunities, [
    "Event", "Dates", "City", "State", "Category",
    "ISO week", "Week range", "Series",
    "Recommendation", "Confidence", "Confidence reason", "Tier", "Score",
    ...componentLabels,
    "Pipeline", "Weekly role", "Action", "Deadline", "Organizer", "Contact route",
    "Route URL", "Contact email", "Contact phone", "Contact person",
    "Why it fits", "Missing facts", "Vendor relevance", "Location", "Sources", "Rejection reason"
  ]);
  // Where the fixed columns end and the per-event ones resume: the score
  // components come from the data, so their count decides every index after.
  const componentBase = 13 + componentLabels.length;
  report.register.forEach((event) => {
    const byLabel = new Map(event.scoreBreakdown.map((part) => [part.label, part.value]));
    const row = opportunities.addRow([
      event.name, event.dateRange, event.city, event.state, event.category,
      event.weekKey, event.weekRangeLabel, event.seriesLabel,
      event.recommendation, event.confidence, event.confidenceCause, event.tier,
      event.rejected ? "" : event.score,
      ...componentLabels.map((label) => (byLabel.has(label) ? byLabel.get(label)! : "")),
      event.pipelineLabel, event.role, `${event.action.severity} · ${event.action.action}`,
      event.deadline.line, event.organizerLine,
      event.contactRoute.url
        ? linkValue(event.contactRoute.url, event.contactRoute.line)
        : event.contactRoute.email
          ? mailValue(event.contactRoute.email)
          : event.contactRoute.line,
      linkValue(event.contactRoute.url, event.contactRoute.url ? hostLabel(event.contactRoute.url) : ""),
      mailValue(event.contactRoute.email),
      telValue(event.contactRoute.phone),
      event.contactRoute.person ?? "",
      event.whyItFits.join("; "), event.missingFields.join("; "),
      event.vendorRelevance, event.locationLine, event.sources.length,
      event.rejectionReason ?? ""
    ]);
    paintFit(row.getCell(9));
    paintUrgency(row.getCell(componentBase + 3));
    [6, 7, 8, 9].forEach((offset) => applyLink(row.getCell(componentBase + offset)));
  });
  freezeAndFilter(opportunities, componentBase + 16);
  fitColumns(opportunities);

  /* 4 — Pipeline: ONE table, the rows behind the counts. The counts themselves
     are on the Dashboard with the rest of the summary numbers. */
  const pipeline = workbook.addWorksheet("Pipeline");
  pipeline.columns = [{ width: 24 }, { width: 12 }, { width: 38 }, { width: 24 }, { width: 24 }, { width: 18 }];
  headerRow(pipeline, ["Pipeline", "Stored state", "Event", "Dates", "Location", "Recommendation"]);
  [...report.register]
    .sort((a, b) => a.pipelineLabel.localeCompare(b.pipelineLabel) || a.name.localeCompare(b.name, "en"))
    .forEach((event) => {
      const row = pipeline.addRow([
        event.pipelineLabel,
        event.pipeline,
        event.name,
        event.dateRange,
        event.locationLine,
        event.recommendation
      ]);
      paintFit(row.getCell(6));
    });
  freezeAndFilter(pipeline, 6);
  fitColumns(pipeline);

  /* 5 — Deadlines. */
  const deadlines = workbook.addWorksheet("Deadlines");
  deadlines.columns = [
    { width: 38 }, { width: 24 }, { width: 12 }, { width: 18 }, { width: 10 },
    { width: 12 }, { width: 34 }, { width: 26 }
  ];
  headerRow(deadlines, [
    "Event", "Location", "ISO week", "Deadline", "Days left", "Urgency", "Route status", "Recommended action"
  ]);
  report.deadlineRadar.forEach((item) => {
    const row = deadlines.addRow([
      item.eventName, item.locationLine, item.weekKey, item.deadlineLabel,
      item.daysRemaining, item.severity, item.routeStatus, item.recommendedAction
    ]);
    paintUrgency(row.getCell(6));
    // Under a fortnight is the band where an application still has to be
    // written. The number is bold; the urgency word beside it says why.
    if (item.daysRemaining < 14) row.getCell(5).font = { bold: true };
  });
  freezeAndFilter(deadlines, 8);
  fitColumns(deadlines);

  /* 6 — Bookings & Outcomes. */
  const bookings = workbook.addWorksheet("Bookings & Outcomes");
  bookings.columns = [
    { width: 34 }, { width: 26 }, { width: 14 }, { width: 30 }, { width: 30 },
    { width: 26 }, { width: 24 }, { width: 14 }, { width: 70 }
  ];
  headerRow(bookings, [
    "Event", "Dates", "Stored state", "Lifecycle", "Status line",
    "Organizer", "Weeks held", "Outcome days recorded", "Outcome facts still wanted"
  ]);
  report.bookings.forEach((booking) =>
    bookings.addRow([
      booking.eventName,
      booking.dateRange,
      booking.bookingState,
      booking.lifecycle,
      booking.statusLine,
      booking.organizer,
      booking.blockedWeeks.join(", ") || "none",
      booking.outcomesRecorded,
      booking.missingOutcomeInputs.join("; ")
    ])
  );
  freezeAndFilter(bookings, 9);
  fitColumns(bookings);

  /* 7 — Weather: every recorded forecast, not only the decision-relevant ones. */
  const weather = workbook.addWorksheet("Weather");
  weather.columns = [{ width: 38 }, { width: 24 }, { width: 34 }, { width: 22 }, { width: 24 }, { width: 34 }];
  headerRow(weather, ["Event", "Dates", "Risk flags", "Fetched", "Source", "Note"]);
  if (report.weatherAllRows.length) {
    report.weatherAllRows.forEach((row) =>
      weather.addRow([
        row.eventName,
        row.dateRange,
        row.riskFlags.join(", ") || "none recorded",
        row.fetchedAt ? fullDate(row.fetchedAt) : "not recorded",
        row.source ?? "not recorded",
        row.relevance
      ])
    );
  } else {
    weather.addRow(["Weather enrichment activates within 10 days of an event", "", "", "", "", ""]);
  }
  freezeAndFilter(weather, 6);
  fitColumns(weather);

  /* 8 — Organizer Drafts: the FULL German and English text. */
  const drafts = workbook.addWorksheet("Organizer Drafts");
  drafts.columns = [
    { width: 34 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 28 },
    { width: 44 }, { width: 70 }, { width: 70 }, { width: 60 }
  ];
  headerRow(drafts, [
    "Event", "ISO week", "Weekly role", "Channel", "Recipient",
    "Subject", "German draft", "English translation", "Approval"
  ]);
  report.drafts.forEach((draft) => {
    const row = drafts.addRow([
      draft.eventName, draft.weekKey, draft.weeklyRole, draft.channel,
      draft.recipient ? mailValue(draft.recipient) : "not recorded",
      draft.subject, draft.draftDe, draft.draftEn, draft.approvalNotice
    ]);
    row.alignment = { wrapText: true, vertical: "top" };
    applyLink(row.getCell(5));
  });
  freezeAndFilter(drafts, 9);
  fitColumns(drafts);

  /* 9 — Evidence & Sources: every source URL behind every event. */
  const sources = workbook.addWorksheet("Evidence & Sources");
  sources.columns = [
    { width: 38 }, { width: 44 }, { width: 30 }, { width: 10 }, { width: 18 }, { width: 80 }
  ];
  headerRow(sources, ["Event", "Source label", "Publisher", "Official", "Observed", "URL"]);
  const seen = new Set<string>();
  report.register.forEach((event) =>
    event.sources.forEach((source) => {
      const key = `${event.id}::${source.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      const row = sources.addRow([
        event.name,
        source.label,
        source.publisher,
        source.official ? "yes" : "no",
        fullDate(source.observedAt),
        // The full URL is the evidence; the host is what a reader can scan.
        linkValue(source.url, hostLabel(source.url))
      ]);
      applyLink(row.getCell(6));
    })
  );
  freezeAndFilter(sources, 6);
  fitColumns(sources);

  /* 10 — System QA: the technical counts, out of the owner's way. */
  const qa = workbook.addWorksheet("System QA");
  qa.columns = [{ width: 34 }, { width: 60 }];
  headerRow(qa, ["Check", "Value"]);
  [
    ["Catalogue mode", `${report.systemHealth.mode} — ${report.systemHealth.modeStatement}`],
    ["Data freshness", report.dataFreshness],
    ["Events collected", String(report.systemHealth.eventsCollected)],
    ["Registered sources", String(report.systemHealth.registeredSources)],
    ["Excluded as not vendor-relevant", String(report.systemHealth.noiseExcluded)],
    ["Organizer known", report.systemHealth.organizerCoverage],
    ["Contact routes verified", report.systemHealth.verifiedRoutes],
    ["Deadline evidence recorded", report.systemHealth.deadlineEvidence],
    ["Weather coverage", report.systemHealth.weatherCoverage],
    ["Evidence records", String(report.systemHealth.evidenceRecords)],
    ["Locations needing verification", String(report.systemHealth.unresolvedLocations)],
    ["Relevance unverified", String(report.systemHealth.relevanceUnverified)],
    [
      "Source health",
      report.systemHealth.sourceHealth.map((row) => `${row.state}: ${row.count}`).join(", ") ||
        "no source has been checked"
    ],
    ["Relevance statement", report.relevanceStatement],
    ["Evidence statement", report.evidenceStatement]
  ].forEach(([key, value]) => {
    const row = qa.addRow([key, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  });
  freezeAndFilter(qa, 2);
  fitColumns(qa);

  // Nothing is hidden and nothing carries a machine's name: every sheet stays
  // visible, every column stays visible, and the document properties are the
  // fixed product ones set at the top of this function.
  workbook.eachSheet((sheet) => {
    sheet.state = "visible";
    sheet.columns.forEach((column) => {
      column.hidden = false;
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as unknown as ArrayBuffer);
}
