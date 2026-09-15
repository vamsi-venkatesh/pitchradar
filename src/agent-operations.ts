import { applicationDecision, applicationIntelligenceFor } from "./application-intelligence";
import type { ClientBooking, EventOpportunity } from "./types";
import type { RegisteredSource, SourceLayer } from "./source-registry";

export type AgentJobKind =
  | "protect_booking"
  | "recheck_application"
  | "deadline_preparation"
  | "source_scan"
  | "coverage_gap";

export interface AgentJob {
  id: string;
  kind: AgentJobKind;
  priority: 1 | 2 | 3 | 4 | 5;
  dueAt: string;
  title: string;
  objective: string;
  evidenceRequired: string[];
  externalActionAllowed: false;
  relatedEventId?: string;
  relatedSourceId?: string;
  relatedBookingId?: string;
}

const layerObjective: Record<SourceLayer, { objective: string; evidence: string[] }> = {
  event_census: {
    objective: "Enumerate new event occurrences and trace each promising record to its commercial operator.",
    evidence: ["official event URL", "dates", "city", "organizer or operator lead"]
  },
  organizer_network: {
    objective: "Inspect the operator's full tour and find relationship-level application routes.",
    evidence: ["tour dates", "operator identity", "food partner route", "category exclusivity rule"]
  },
  application_route: {
    objective: "Capture the real booking window, route owner, deadline and remaining category capacity.",
    evidence: ["application URL", "opens date", "deadline", "route owner", "capacity statement"]
  },
  procurement: {
    objective: "Find concessions or tenders before the event is marketed to visitors.",
    evidence: ["notice URL", "submission deadline", "contract period", "fees", "selection requirements"]
  },
  private_demand: {
    objective: "Establish a consented source for corporate, private-site and inbound catering demand.",
    evidence: ["source agreement", "request date", "decision-maker", "event requirements"]
  }
};

function isDue(value: string, now: Date) {
  return new Date(value).getTime() <= now.getTime();
}

function sourceCadenceDueAt(
  cadence: RegisteredSource["cadence"],
  now: Date,
  lastCheckedAt?: string
) {
  if (!lastCheckedAt) return now.toISOString();
  const due = new Date(lastCheckedAt);
  if (cadence === "daily") due.setDate(due.getDate() + 1);
  if (cadence === "weekly") due.setDate(due.getDate() + 7);
  if (cadence === "monthly") due.setMonth(due.getMonth() + 1);
  if (cadence === "manual") due.setDate(due.getDate() + 14);
  return due.toISOString();
}

export function buildAgentQueue(
  events: EventOpportunity[],
  sources: RegisteredSource[],
  bookings: ClientBooking[],
  now = new Date()
): AgentJob[] {
  const jobs: AgentJob[] = [];

  bookings
    .filter((booking) => booking.bookingState === "live")
    .forEach((booking) => {
      jobs.push({
        id: `protect:${booking.id}`,
        kind: "protect_booking",
        priority: 1,
        dueAt: now.toISOString(),
        title: `Protect ${booking.eventName}`,
        objective: "Keep conflicting recommendations blocked and collect daily commercial outcomes for the next-cycle decision.",
        evidenceRequired: booking.missingOutcomeInputs,
        externalActionAllowed: false,
        relatedBookingId: booking.id
      });
    });

  events.forEach((event) => {
    const intelligence = applicationIntelligenceFor(event);
    const decision = applicationDecision(event, now);
    if (event.tier !== "REJECTED") {
      // A never-checked application window is due now: absence of a check is not
      // a reason to wait, and there is no scheduled date to wait for.
      const neverChecked = !intelligence.nextCheckAt;
      const due = neverChecked || isDue(intelligence.nextCheckAt as string, now);
      jobs.push({
        id: `recheck:${event.id}:${intelligence.nextCheckAt ?? "never-checked"}`,
        kind: "recheck_application",
        priority: due ? (decision.urgency === "act" ? 1 : 2) : 3,
        dueAt: intelligence.nextCheckAt ?? now.toISOString(),
        title: `Recheck ${event.name}`,
        objective: decision.nextAction,
        evidenceRequired: ["current application state", "remaining speciality capacity", "deadline", "named route owner"],
        externalActionAllowed: false,
        relatedEventId: event.id
      });
    }
    if (intelligence.deadline && decision.daysRemaining !== undefined && decision.daysRemaining >= 0 && decision.daysRemaining <= 90) {
      jobs.push({
        id: `prepare:${event.id}:${intelligence.deadline}`,
        kind: "deadline_preparation",
        priority: decision.daysRemaining <= 14 ? 1 : 2,
        dueAt: intelligence.deadline,
        title: `Prepare decision for ${event.name}`,
        objective: "Close economics and document gaps before the owner decides whether to apply.",
        evidenceRequired: event.missingFields,
        externalActionAllowed: false,
        relatedEventId: event.id
      });
    }
  });

  sources.forEach((source) => {
    const rule = layerObjective[source.layer];
    jobs.push({
      id: `scan:${source.id}`,
      kind: "source_scan",
      priority: source.priority,
      dueAt: sourceCadenceDueAt(source.cadence, now, source.lastCheckedAt),
      title: `Scan ${source.name}`,
      objective: rule.objective,
      evidenceRequired: rule.evidence,
      externalActionAllowed: false,
      relatedSourceId: source.id
    });
  });

  const uncoveredLayers = (Object.keys(layerObjective) as SourceLayer[]).filter(
    (layer) => !sources.some((source) => source.layer === layer)
  );
  uncoveredLayers.forEach((layer) => {
    const rule = layerObjective[layer];
    jobs.push({
      id: `gap:${layer}`,
      kind: "coverage_gap",
      priority: 4,
      dueAt: sourceCadenceDueAt("weekly", now),
      title: `Close source gap: ${layer.replaceAll("_", " ")}`,
      objective: rule.objective,
      evidenceRequired: rule.evidence,
      externalActionAllowed: false
    });
  });

  return jobs.sort((a, b) => {
    if (a.kind === "protect_booking" && b.kind !== "protect_booking") return -1;
    if (b.kind === "protect_booking" && a.kind !== "protect_booking") return 1;
    return a.priority - b.priority || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}
