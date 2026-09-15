import type { ClientProfile, EventOpportunity, OpportunityTier, VendorRelevance } from "./types";
import { applicationDecision } from "./application-intelligence";

const MS_DAY = 86_400_000;

/**
 * The reason an event excluded by the vendor-relevance gate carries. Defined
 * here, with the gate, and re-exported by `server/vendor-relevance.ts` so the
 * classifier, the report and the tests cannot drift onto different wordings.
 */
export const VENDOR_IRRELEVANT_REASON =
  "Not a vendor-relevant event (guided tour, lecture or similar)";

/** The tag the report puts on an event whose relevance the rules could not decide. */
export const VENDOR_UNCLEAR_TAG = "relevance unverified";

/**
 * What an "unclear" verdict costs. A row the rules cannot decide is still a
 * real event from an official calendar, so it is ranked — just below anything
 * with a confirmed market or food signal. It is never silently dropped; that
 * is reserved for "irrelevant", which is excluded outright.
 */
export const VENDOR_UNCLEAR_DEDUCTION = 6;

/** The risk signal an unclear row carries into the breakdown and the report. */
export const VENDOR_UNCLEAR_RISK =
  "Vendor relevance unverified: no market or food signal in the recorded event text";

/**
 * The one rule for reading the verdict, used by the ranking AND the report.
 *
 * A row with no recorded verdict is "unclear" — not "relevant". Anything else
 * would let an unclassified event score as though it had been checked. This
 * lives in one function because the two readers drifted apart once already:
 * the report tagged an absent verdict "relevance unverified" while the ranking
 * charged it nothing, so the page showed a caveat the score did not reflect.
 */
export function vendorRelevanceOf(
  event: Pick<EventOpportunity, "vendorRelevance">
): VendorRelevance {
  return event.vendorRelevance ?? "unclear";
}

export function tradingDays(event: Pick<EventOpportunity, "startsAt" | "endsAt">): number {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(1, Math.round((endDay - startDay) / MS_DAY) + 1);
}

/**
 * THE TIER BANDS.
 *
 * Measured against the live corpus after the 2026-09-15 recalibration, where
 * FIT scores only what is KNOWN and evidence adds a bonus on top. A STRONG FIT
 * therefore means "a direct fit on the facts we already hold" — the right kind
 * of event, on the profile's trading days, reachable, with the window not shut
 * — and NOT "an event somebody has already researched for us". An event with no
 * commercial evidence at all can be a STRONG FIT; that is the point.
 *
 * Measured over the 283 non-rejected events in the live corpus (--now
 * 2026-09-15): the scores form a top cluster at 72-74, a second at 64-68, a
 * mass at 60-61 and a tail below. B sits at 62, inside a real gap — nothing
 * scores 62 or 63 — so the GOOD/WATCH line falls between two clusters rather
 * than through one. A sits at 72, two points below the measured ceiling of 74
 * and inside the top cluster; the 78 anchor would again name nothing STRONG,
 * this time because region and application window are unknown on almost the
 * whole corpus rather than because unknowns were deducted.
 */
export const TIER_BANDS = { A: 72, B: 62 } as const;
// A sits at 72, calibrated against the live corpus 2026-09-15: the corpus
// ceiling is 74 while region and window stay unknown on most rows, and the
// 72-73 cohort is the semantics of strong - direct street-food fit across prime
// trading days. An out-of-region reference event still scored STRONG, so
// unmeasured travel does not disqualify; it lives in confidence.

function tierFor(score: number): OpportunityTier {
  if (score >= TIER_BANDS.A) return "A";
  if (score >= TIER_BANDS.B) return "B";
  return "C";
}

/**
 * A RISK SIGNAL THAT IS REALLY AN OPEN QUESTION.
 *
 * Deductions are for genuine negatives. Most of the recorded "risk signals" in
 * the live corpus are not negatives at all — "Vendor-category capacity is not
 * confirmed" sits on 357 of 378 events, i.e. on every event nobody has phoned
 * yet. Charging it two points is the missing-evidence penalty again, wearing a
 * different label: it moved the whole corpus down by the same amount, so it
 * ranked nothing and only made the ceiling unreachable.
 *
 * Such a signal still travels with the event and is still printed — it belongs
 * in KEY UNKNOWNS and in the confidence cause. It just does not cost score.
 * "Very short notice", by contrast, is a real negative and is charged.
 */
const OPEN_QUESTION_RISK =
  /(unknown|unconfirmed|unverified|not confirmed|not been confirmed|not published|not been found|needs? verification|still needs? verification|still needs? to be|still need verification|does not prove|^no\b.*\b(found|published|recorded)\b|requires? the exact)/i;

export function isOpenQuestionRisk(signal: string): boolean {
  return OPEN_QUESTION_RISK.test(signal);
}

/**
 * WHAT THE EVENT IS — the largest single component, because a direct
 * food-vendor event IS the product's target and no amount of evidence makes a
 * sports fixture into one.
 */
export const EVENT_TYPE_FIT: Record<EventOpportunity["eventType"], number> = {
  street_food: 30,
  market: 24,
  christmas: 22,
  city_festival: 18,
  sports: 10,
  private: 8
};

/**
 * Regions that count as home alongside the profile's own. Keyed by region so
 * the rule is read from the profile, never hardcoded to one client: a
 * Brandenburg operator trades Berlin as home ground and the reverse holds.
 */
const HOME_REGION_PARTNERS: Record<string, string[]> = {
  Brandenburg: ["Berlin"],
  Berlin: ["Brandenburg"]
};

function homeRegionsFor(profile: ClientProfile): string[] {
  return [profile.homeRegion, ...(HOME_REGION_PARTNERS[profile.homeRegion] ?? [])];
}

/** Every calendar day the event trades on, as JS day numbers (0 = Sunday). */
function tradingWeekdays(event: Pick<EventOpportunity, "startsAt" | "endsAt">): number[] {
  const start = new Date(event.startsAt);
  const days = tradingDays(event);
  const out: number[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    out.push(day.getDay());
  }
  return out;
}

function isPrimeDay(day: number, profile: ClientProfile): boolean {
  return profile.normalDays.includes(day) || (profile.optionalThursday && day === 4);
}

/** CALENDAR FIT — do the trading days fall on the days this truck actually works? */
export function calendarFitFor(
  event: Pick<EventOpportunity, "startsAt" | "endsAt">,
  profile: ClientProfile
): number {
  const days = tradingWeekdays(event);
  const prime = days.filter((day) => isPrimeDay(day, profile)).length;
  if (prime === days.length) return 20;
  if (prime > 0) return 12;
  return 4;
}

/**
 * REGION FIT — home ground first, then a known travel time against the
 * profile's own ceilings. An UNKNOWN travel time is not punished below "some
 * other part of Germany": we do not know it is far, we only know we have not
 * measured it. (Beyond the exceptional ceiling is a hard gate, not a score.)
 */
export function regionFitFor(
  event: Pick<EventOpportunity, "state" | "travelMinutes">,
  profile: ClientProfile
): number {
  if (homeRegionsFor(profile).includes(event.state)) return 15;
  if (event.travelMinutes !== undefined) {
    return event.travelMinutes <= profile.preferredMaxTravelMinutes ? 13 : 5;
  }
  return 8;
}

export function scoreOpportunity(
  event: EventOpportunity,
  profile: ClientProfile,
  now = new Date()
): EventOpportunity {
  if (new Date(event.endsAt) < now) {
    return { ...event, tier: "REJECTED", score: 0, rejectionReason: "The event has already ended." };
  }

  // A consumer-calendar entry is not a pitch. This gate runs before every
  // commercial consideration because no deadline, fee or travel time can make
  // a guided church tour into a food-vendor opportunity.
  if (vendorRelevanceOf(event) === "irrelevant") {
    return {
      ...event,
      tier: "REJECTED",
      score: 0,
      rejectionReason: VENDOR_IRRELEVANT_REASON
    };
  }

  if (event.applicationState === "closed") {
    return { ...event, tier: "REJECTED", score: 0, rejectionReason: "The application deadline has passed." };
  }

  const application = applicationDecision(event, now);
  if (application.phase === "deadline_passed" || application.phase === "full") {
    return {
      ...event,
      tier: "REJECTED",
      score: 0,
      rejectionReason:
        application.phase === "full"
          ? "The available vendor places are full or the application is closed."
          : "The application deadline has passed."
    };
  }

  if (
    event.travelMinutes !== undefined &&
    event.travelMinutes > profile.exceptionalMaxTravelMinutes
  ) {
    return { ...event, tier: "REJECTED", score: 0, rejectionReason: "The event is beyond the maximum travel time." };
  }

  // ------------------------------------------------------------------ FIT
  // Everything below scores what we KNOW about the event: what it is, when it
  // trades, where it is, how long it runs, whether the window is shut. None of
  // it can be lowered by a fact we have not gathered yet — a missing fee or an
  // unknown visitor count belongs in KEY UNKNOWNS and in the confidence axis,
  // not in the score. Punishing it here punished the same gap twice and made a
  // freshly-discovered event structurally incapable of reaching STRONG FIT.
  const eventTypeFit = EVENT_TYPE_FIT[event.eventType] ?? 8;
  const calendarFit = calendarFitFor(event, profile);
  const regionFit = regionFitFor(event, profile);

  const duration = tradingDays(event);
  const durationValue = duration >= 3 ? 10 : duration === 2 ? 7 : 4;

  // "closing_soon" is an OPEN window under time pressure: the urgency belongs
  // to the required action, not to how well the event fits.
  const applicationWindow =
    application.phase === "open" ||
    application.phase === "rolling" ||
    application.phase === "closing_soon"
      ? 10
      : application.phase === "not_yet_open"
        ? 7
        : 5;

  // ------------------------------------------------------- evidence bonuses
  // Pure upside. Absence is zero, never a deduction: an event nobody has
  // researched yet is not a worse event, it is a less-researched one.
  const demandEvidence =
    event.expectedVisitors !== undefined
      ? Math.min(10, Math.round((event.expectedVisitors / 10_000) * 10))
      : 0;
  const economicsEvidence = event.pitchFeeEur === undefined ? 0 : 5;

  const chargeableRisks = event.riskSignals.filter((signal) => !isOpenQuestionRisk(signal));
  const riskPenalty = Math.min(10, chargeableRisks.length * 2);

  // An unverified relevance verdict is folded into Deductions rather than
  // given a ninth component: the grid the report prints is eight components
  // and a Total, and adding a column for a penalty that is zero on almost every
  // row would cost more than it explains. The reason travels in riskSignals,
  // where the report already prints it, so the number is never unexplained.
  const unclearRelevance = vendorRelevanceOf(event) === "unclear";
  const relevancePenalty = unclearRelevance ? VENDOR_UNCLEAR_DEDUCTION : 0;

  // Computed from the event's OWN risk signals, before the relevance reason is
  // appended below — otherwise the same verdict would be charged twice.
  const riskSignals = unclearRelevance
    ? [...event.riskSignals, VENDOR_UNCLEAR_RISK]
    : event.riskSignals;

  const score = Math.max(
    0,
    Math.round(
      eventTypeFit + calendarFit + regionFit + durationValue + applicationWindow
        + demandEvidence + economicsEvidence
        - riskPenalty - relevancePenalty
    )
  );

  // Written as a positive total and negated only when there is something to
  // negate: `-(0 + 0)` is negative zero in JavaScript, and a workbook cell
  // reading "-0" is a defect the reader has to decode.
  const deductions = riskPenalty + relevancePenalty;

  return {
    ...event,
    riskSignals,
    score,
    tier: tierFor(score),
    scoreBreakdown: {
      EventTypeFit: eventTypeFit,
      CalendarFit: calendarFit,
      RegionFit: regionFit,
      TradingDuration: durationValue,
      ApplicationWindow: applicationWindow,
      DemandEvidence: demandEvidence,
      EconomicsEvidence: economicsEvidence,
      Deductions: deductions === 0 ? 0 : -deductions
    }
  };
}

export function rankOpportunities(
  events: EventOpportunity[],
  profile: ClientProfile,
  now = new Date()
): EventOpportunity[] {
  return events
    .map((event) => scoreOpportunity(event, profile, now))
    .sort((a, b) => {
      if (a.tier === "REJECTED" && b.tier !== "REJECTED") return 1;
      if (b.tier === "REJECTED" && a.tier !== "REJECTED") return -1;
      return (b.score ?? 0) - (a.score ?? 0);
    });
}
