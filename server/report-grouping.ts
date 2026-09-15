/**
 * THE TWO GROUPINGS THE REPORT THINKS IN.
 *
 * 1. THE ACTION QUEUE THINKS IN ORGANIZERS. "106 events need action" is event
 *    mass, not work: eight of those events belong to one festival operator and
 *    are ONE phone call. A task is an organizer plus the events behind it plus
 *    the single ask that moves all of them.
 *
 * 2. THE RADAR THINKS IN SERIES. A touring operator running the same festival
 *    through eight towns occupies eight radar rows and crowds out everything
 *    else. One row, eight stops, expandable.
 *
 * Both groupings are DISPLAY-LEVEL and DETERMINISTIC. No record is merged, no
 * event loses its own register row, and the same snapshot always produces the
 * same keys — nothing here reads a clock or a locale default.
 */
import type {
  ActionLabel,
  ActionSeverity,
  ConfidenceLevel,
  Recommendation,
  ReportContactRoute,
  ReportEvent
} from "./report";

/* ------------------------------------------------------------- identities */

/** What grouping needs from an event. Deliberately structural. */
export interface GroupableEvent {
  id: string;
  name: string;
  city: string;
  organizer?: string;
  sources?: Array<{ publisher: string; official: boolean }>;
}

/**
 * Lower-case, diacritic-folded, punctuation-collapsed. German names reach the
 * catalogue in several spellings of the same word ("Groß-Gerauer", "Gross
 * Gerauer"), and a key that changes with the spelling is not a key.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * The publisher family an event was discovered through — the official source
 * where there is one, else the first recorded source. It is the fallback
 * identity for an event whose organizer is not published: those events are
 * still somebody's work, and the source that carries them is the only handle
 * the catalogue holds.
 */
export function sourceFamilyFor(event: GroupableEvent): string | undefined {
  const sources = event.sources ?? [];
  const official = sources.find((source) => source.official);
  return (official ?? sources[0])?.publisher;
}

export interface OrganizerIdentity {
  key: string;
  name: string;
  kind: "organizer" | "source_family" | "unattributed";
}

/**
 * WHO OWNS THIS EVENT. A recorded organizer first; the source family second;
 * and where neither exists the event stands alone under its own id — grouping
 * two events we cannot attribute would invent a relationship.
 */
export function organizerIdentityFor(event: GroupableEvent): OrganizerIdentity {
  if (event.organizer) {
    return { key: `organizer:${normalizeText(event.organizer)}`, name: event.organizer, kind: "organizer" };
  }
  const family = sourceFamilyFor(event);
  if (family) {
    return {
      key: `source:${normalizeText(family)}`,
      name: `Organizer unpublished — source: ${family}`,
      kind: "source_family"
    };
  }
  return { key: `event:${event.id}`, name: "Organizer not yet identified", kind: "unattributed" };
}

/* ---------------------------------------------------------------- series */

const YEAR_TOKEN = /^(19|20)\d{2}$/;

/**
 * A name token that names the PLACE rather than the event. German tour stops
 * are spelled adjectivally — "Bad Kreuznacher Street Food Festival" in
 * "Kornmarkt Bad Kreuznach" — so a token counts as the city when it shares a
 * stem of at least four characters with one, not only when it matches it.
 */
function isPlaceToken(token: string, cityTokens: string[]): boolean {
  return cityTokens.some((city) => {
    if (city === token) return true;
    if (city.length < 4 || token.length < 4) return false;
    return token.startsWith(city) || city.startsWith(token);
  });
}

/**
 * The event name with what varies between stops taken out: the city (however
 * it is spelled into the title) and the year. What remains is the name of the
 * series — "street food festival", "foodtruckmeile" — or, where nothing
 * remains, the whole name, because a series with no name is not a series.
 */
export function seriesNameOf(event: GroupableEvent): string {
  const cityTokens = tokensOf(event.city);
  const kept = tokensOf(event.name).filter(
    (token) => !YEAR_TOKEN.test(token) && !/^\d+$/.test(token) && !isPlaceToken(token, cityTokens)
  );
  return kept.length ? kept.join(" ") : normalizeText(event.name);
}

/**
 * The key two stops of one tour share. It carries the organizer identity, so
 * two operators running similarly named festivals can never be folded into one
 * row: a series is one operator's tour, not a name collision.
 */
export function seriesKeyFor(event: GroupableEvent): string {
  return `${organizerIdentityFor(event).key}::${seriesNameOf(event)}`;
}

/** The printable series name, built from the member the reader sees first. */
export function seriesLabelFor(event: GroupableEvent): string {
  const cityTokens = tokensOf(event.city);
  const kept = event.name
    .split(/\s+/)
    .filter((word) => {
      const token = normalizeText(word);
      if (!token) return false;
      if (YEAR_TOKEN.test(token) || /^\d+$/.test(token)) return false;
      return !isPlaceToken(token, cityTokens);
    })
    .join(" ")
    .replace(/[\s,.;:·–—-]+$/, "")
    .trim();
  return kept || event.name;
}

export interface ReportSeriesRow {
  key: string;
  /** "Street Food Festival tour" for a series; the event name for a single. */
  label: string;
  /** True once the series carries more than one stop. */
  isSeries: boolean;
  /** The soonest stop — the row's own recommendation, confidence and dates. */
  lead: ReportEvent;
  stops: ReportEvent[];
  /** "8 stops, next: Bad Kreuznach 18 Sep – 20 Sep". Derived, never written. */
  summaryLine: string;
}

/**
 * ONE ROW PER SERIES, singles untouched. Order is inherited from the order the
 * events arrive in — the caller has already ranked them — so the strongest
 * member decides where its series sits.
 */
export function buildSeriesRows(
  events: ReportEvent[],
  compactRange: (event: ReportEvent) => string
): ReportSeriesRow[] {
  const groups = new Map<string, ReportEvent[]>();
  events.forEach((event) => {
    const key = event.seriesKey;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  });
  return [...groups.entries()].map(([key, members]) => {
    const stops = [...members].sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name, "en")
    );
    const next = stops[0];
    const isSeries = stops.length > 1;
    // Two operators can run a festival of the same name; the row names the one
    // whose tour this is, so the reader is never asked which "Street Food
    // Festival tour" they are looking at.
    const operator = organizerIdentityFor(next).name;
    return {
      key,
      label: isSeries ? next.seriesLabel || `${seriesLabelFor(next)} tour` : next.name,
      isSeries,
      lead: members[0],
      stops,
      summaryLine: isSeries
        ? `${stops.length} stops, next: ${next.city} ${compactRange(next)} · ${operator}`
        : compactRange(next)
    };
  });
}

/* ----------------------------------------------------------------- tasks */

export interface ReportTaskMember {
  id: string;
  name: string;
  dateRange: string;
  startsAt: string;
  locationLine: string;
  recommendation: Recommendation;
  confidence: ConfidenceLevel;
  deadlineLine: string;
  action: ActionLabel;
  severity: ActionSeverity;
}

export interface ReportTask {
  key: string;
  organizerName: string;
  /** The most complete route across the organizer's action-bearing events. */
  resolvedContact: ReportContactRoute;
  events: ReportTaskMember[];
  /** The soonest three event date ranges — what the call is actually about. */
  priorityDates: string[];
  urgency: ActionSeverity;
  /** The dominant action across the members; the task speaks with one voice. */
  action: ActionLabel;
  /** ONE organizer-level ask, derived from the members. Never written per task. */
  nextAction: string;
  confidence: ConfidenceLevel;
}

const SEVERITY_RANK: Record<ActionSeverity, number> = { URGENT: 0, SOON: 1, WATCH: 2 };
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
/** The rule order of the action table, so the task speaks for its hardest member. */
const ACTION_RANK: Record<ActionLabel, number> = {
  "APPLY NOW": 0,
  "REVIEW CONFLICT": 1,
  "CONTACT ORGANIZER": 2,
  "WEATHER CHECK": 3,
  "VERIFY CATEGORY AVAILABILITY": 4,
  "NO ACTION": 5
};
const ROUTE_RANK: Record<ReportContactRoute["kind"], number> = {
  named: 0,
  application_url: 1,
  organizer_site: 2,
  listing_only: 3,
  none: 4
};

/**
 * THE MOST COMPLETE ROUTE the organizer's events carry — a person, an address,
 * a number — never fields mixed across events, because one route is one page of
 * evidence. Ties fall to the rung of the chain, then to the confirmed one.
 */
function resolvedContactFor(events: ReportEvent[]): ReportContactRoute {
  const completeness = (route: ReportContactRoute) =>
    (route.person ? 1 : 0) + (route.email ? 1 : 0) + (route.phone ? 1 : 0);
  return [...events]
    .sort(
      (a, b) =>
        completeness(b.contactRoute) - completeness(a.contactRoute) ||
        ROUTE_RANK[a.contactRoute.kind] - ROUTE_RANK[b.contactRoute.kind] ||
        Number(b.contactRoute.verified) - Number(a.contactRoute.verified) ||
        a.startsAt.localeCompare(b.startsAt) ||
        a.id.localeCompare(b.id)
    )[0].contactRoute;
}

function memberOf(event: ReportEvent): ReportTaskMember {
  return {
    id: event.id,
    name: event.name,
    dateRange: event.dateRange,
    startsAt: event.startsAt,
    locationLine: event.locationLine,
    recommendation: event.recommendation,
    confidence: event.confidence,
    deadlineLine: event.deadline.line,
    action: event.action.action,
    severity: event.action.severity
  };
}

/**
 * THE ONE ASK. Deadline-driven and conflict work keep their specific action —
 * a closing window is about one event and nothing else. Everything else becomes
 * the organizer-level question, which is the whole point of grouping: one call
 * about every date the operator runs, not eight calls about eight events.
 */
function nextActionFor(input: {
  action: ActionLabel;
  driver: ReportEvent;
  organizerName: string;
  memberCount: number;
}): string {
  const { driver, organizerName, memberCount } = input;
  const days = driver.deadline.daysRemaining;
  switch (input.action) {
    case "APPLY NOW":
      return `Apply to ${driver.name} — the published deadline closes in ${days} day${
        days === 1 ? "" : "s"
      }`;
    case "REVIEW CONFLICT":
      return `Decide between ${driver.name} (${driver.dateRange}) and the booking that already holds the truck on those dates`;
    case "CONTACT ORGANIZER":
      return days !== undefined && days >= 0
        ? `Contact ${organizerName} about ${driver.name} — the published deadline closes in ${days} day${
            days === 1 ? "" : "s"
          }`
        : `Ask which of the ${memberCount} upcoming date${
            memberCount === 1 ? "" : "s"
          } still accept the operator's category and whether exclusivity applies`;
    case "WEATHER CHECK":
      return `Check the recorded forecast for ${driver.name} before committing — ${driver.weather.riskFlags.join(
        ", "
      )}`;
    case "VERIFY CATEGORY AVAILABILITY":
      return `Ask ${organizerName} to close the open question on ${driver.name} before further effort: ${driver.action.because.replace(
        "the fit is there; the open question is: ",
        ""
      )}`;
    case "NO ACTION":
      return "Nothing is due on this organizer yet";
  }
}

/**
 * ACCOUNT-LEVEL TASKS. Every action-bearing event is folded into the organizer
 * that owns it; an organizer-less event falls back to its source family and, if
 * it has neither, stands alone rather than joining a group it has no claim to.
 */
export function buildActionTasks(events: ReportEvent[]): ReportTask[] {
  const groups = new Map<string, { identity: OrganizerIdentity; events: ReportEvent[] }>();
  events.forEach((event) => {
    const identity = organizerIdentityFor(event);
    const current = groups.get(identity.key);
    if (current) current.events.push(event);
    else groups.set(identity.key, { identity, events: [event] });
  });

  const tasks = [...groups.values()].map(({ identity, events: members }) => {
    const ordered = [...members].sort(
      (a, b) =>
        SEVERITY_RANK[a.action.severity] - SEVERITY_RANK[b.action.severity] ||
        ACTION_RANK[a.action.action] - ACTION_RANK[b.action.action] ||
        (a.deadline.daysRemaining ?? 9_999) - (b.deadline.daysRemaining ?? 9_999) ||
        a.startsAt.localeCompare(b.startsAt) ||
        a.name.localeCompare(b.name, "en")
    );
    const driver = ordered[0];
    const byDate = [...members].sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name, "en")
    );
    return {
      key: identity.key,
      organizerName: identity.name,
      resolvedContact: resolvedContactFor(members),
      events: ordered.map(memberOf),
      priorityDates: byDate.slice(0, 3).map((event) => event.dateRange),
      urgency: ordered.reduce<ActionSeverity>(
        (worst, event) =>
          SEVERITY_RANK[event.action.severity] < SEVERITY_RANK[worst] ? event.action.severity : worst,
        "WATCH"
      ),
      action: driver.action.action,
      nextAction: nextActionFor({
        action: driver.action.action,
        driver,
        organizerName: identity.name,
        memberCount: members.length
      }),
      confidence: ordered.reduce<ConfidenceLevel>(
        (best, event) => (CONFIDENCE_RANK[event.confidence] < CONFIDENCE_RANK[best] ? event.confidence : best),
        "LOW"
      )
    } satisfies ReportTask;
  });

  return tasks.sort(
    (a, b) =>
      SEVERITY_RANK[a.urgency] - SEVERITY_RANK[b.urgency] ||
      ACTION_RANK[a.action] - ACTION_RANK[b.action] ||
      b.events.length - a.events.length ||
      a.organizerName.localeCompare(b.organizerName, "en")
  );
}
