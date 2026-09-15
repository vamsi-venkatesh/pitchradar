import type { ApplicationIntelligence, EventOpportunity } from "./types";

const MS_DAY = 86_400_000;
const berlinCalendar = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin"
});

export type ApplicationPhase =
  | "open"
  | "closing_soon"
  | "rolling"
  | "not_yet_open"
  | "full"
  | "deadline_passed"
  | "verify_now";

export interface ApplicationDecision {
  phase: ApplicationPhase;
  label: string;
  urgency: "act" | "prepare" | "watch" | "blocked" | "verify";
  daysRemaining?: number;
  nextAction: string;
}

function daysBetween(value: string, now: Date): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const current = Object.fromEntries(
      berlinCalendar.formatToParts(now)
        .filter((part) => ["year", "month", "day"].includes(part.type))
        .map((part) => [part.type, Number(part.value)])
    ) as { year: number; month: number; day: number };
    return Math.round(
      (
        Date.UTC(year, month - 1, day) -
        Date.UTC(current.year, current.month - 1, current.day)
      ) / MS_DAY
    );
  }
  return Math.ceil((new Date(value).getTime() - now.getTime()) / MS_DAY);
}

/**
 * What the deadline column actually proves (migration 012). A missing deadline
 * used to mean two different things; these are the three honest answers.
 */
export type DeadlineEvidence = "published" | "not_found" | "none_rolling";

const berlinDayMonthYear = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Berlin"
});

/**
 * The one sentence the surfaces may show about a deadline. It never guesses:
 * "no deadline found" and "no deadline exists" stay different sentences, and a
 * countdown appears only when a deadline is actually published.
 */
export function deadlineStatusLabel(
  evidence: DeadlineEvidence | undefined,
  deadline: string | undefined,
  now = new Date()
): string {
  if (evidence === "none_rolling") return "Rolling applications — no deadline exists";
  if (!deadline) return "No deadline published — not yet found";
  const daysRemaining = daysBetween(deadline, now);
  if (daysRemaining < 0) return "Deadline passed";
  const date = berlinDayMonthYear.format(
    /^\d{4}-\d{2}-\d{2}$/.test(deadline)
      ? new Date(`${deadline}T12:00:00Z`)
      : new Date(deadline)
  );
  if (daysRemaining === 0) return `Deadline ${date} — today`;
  return `Deadline ${date} — ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"}`;
}

export function applicationIntelligenceFor(event: EventOpportunity): ApplicationIntelligence {
  return event.application ?? {
    route: event.applicationUrl ? "public_form" : "unknown",
    capacityState: event.applicationState === "closed" ? "full" : "unknown",
    deadline: event.applicationDeadline,
    // No application_windows row exists, so this event has never been checked.
    // Reporting a date here would be a fabrication.
    lastCheckedAt: null,
    nextCheckAt: null,
    routeOwner: event.organizer,
    routeScope: event.applicationUrl ? "unknown" : undefined,
    routeReachable: Boolean(event.applicationUrl),
    requirements: [],
    sourceUrl: event.applicationUrl,
    note:
      event.applicationState === "open"
        ? "A public route exists, but remaining vendor capacity has not been independently confirmed."
        : "The application route or remaining capacity still requires verification."
  };
}

export function applicationDecision(
  event: EventOpportunity,
  now = new Date()
): ApplicationDecision {
  const intel = applicationIntelligenceFor(event);

  if (intel.capacityState === "full") {
    return {
      phase: "full",
      label: "Full / closed",
      urgency: "blocked",
      nextAction: "Record the next cycle and stop application work."
    };
  }

  if (intel.deadline) {
    const daysRemaining = daysBetween(intel.deadline, now);
    if (daysRemaining < 0) {
      return {
        phase: "deadline_passed",
        label: `Closed ${Math.abs(daysRemaining)}d ago`,
        urgency: "blocked",
        daysRemaining,
        nextAction: "Check only for a waitlist, then monitor the next cycle."
      };
    }
    if (intel.opensAt && daysBetween(intel.opensAt, now) > 0) {
      return {
        phase: "not_yet_open",
        label: `Opens in ${daysBetween(intel.opensAt, now)}d`,
        urgency: "prepare",
        daysRemaining,
        nextAction: "Prepare the application pack before opening day."
      };
    }
    if (daysRemaining <= 14) {
      return {
        phase: "closing_soon",
        label: `${daysRemaining}d left`,
        urgency: "act",
        daysRemaining,
        nextAction: "Verify availability and prepare for owner approval now."
      };
    }
    return {
      phase: "open",
      label: `${daysRemaining}d left`,
      urgency: "prepare",
      daysRemaining,
      nextAction: "Confirm capacity, economics and required documents."
    };
  }

  if (intel.capacityState === "rolling") {
    return {
      phase: "rolling",
      label: "Rolling applications",
      urgency: "act",
      nextAction: "Ask whether a suitable pitch remains before spending application effort."
    };
  }

  if (intel.capacityState === "not_yet_open") {
    return {
      phase: "not_yet_open",
      label: intel.expectedNextWindow ? `Expected ${intel.expectedNextWindow}` : "Not yet open",
      urgency: "watch",
      nextAction: "Watch the source and alert when the application appears."
    };
  }

  if (event.applicationState === "open" || intel.capacityState === "available" || intel.capacityState === "limited") {
    return {
      phase: "open",
      label: intel.capacityState === "limited" ? "Open · limited" : "Open · capacity unconfirmed",
      urgency: intel.capacityState === "limited" ? "act" : "verify",
      nextAction: "Confirm a speciality pitch remains before owner approval."
    };
  }

  if (intel.routeReachable) {
    return {
      phase: "verify_now",
      label: "Contact route verified",
      urgency: "act",
      nextAction: "Ask the verified organizer contact whether a speciality pitch remains for this exact event."
    };
  }

  return {
    phase: "verify_now",
    label: "Availability unknown",
    urgency: "verify",
    nextAction: "Find the decision-maker and verify whether applications are still accepted."
  };
}
