/**
 * THE SHARED BRIEFING VIEW — the contract between the weekly brief and the
 * private web.
 *
 * The owner vocabulary (STRONG FIT / WATCH, HIGH / LOW confidence, the pipeline
 * labels) and the numbers behind it are DECLARED HERE and DERIVED ONCE, on the
 * server, by `buildBriefingView` in `server/report.ts`. The web renders them; it
 * does not recompute them. Two derivations of "how many need action now" is two
 * answers, and that is exactly the defect this file exists to close.
 *
 * Nothing in here imports from `server/` — the browser bundle must not pull the
 * report engine in — so the server's own report types are checked against these
 * at the point `buildBriefingView` returns.
 */
import type { BookingLifecycle } from "./booking-state";

export type Recommendation = "STRONG FIT" | "GOOD FIT" | "WATCH" | "SKIP";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type ActionSeverity = "URGENT" | "SOON" | "WATCH";
export type ActionLabel =
  | "APPLY NOW"
  | "CONTACT ORGANIZER"
  | "VERIFY CATEGORY AVAILABILITY"
  | "REVIEW CONFLICT"
  | "WEATHER CHECK"
  | "NO ACTION";
export type PipelineLabel =
  | "Discovered"
  | "Verifying"
  | "Ready to contact"
  | "Contacted"
  | "Applied"
  | "Booked"
  | "Lost"
  | "Expired"
  | "Completed";

export interface BriefingKpis {
  eventsChecked: number;
  vendorRelevant: number;
  shortlisted: number;
  recommended: number;
  /** TASKS, not events: one organizer with eight events is one call. */
  actionNow: number;
  /** The events those tasks cover. Secondary, never the headline. */
  actionNowEvents: number;
  upcomingDeadlines: number;
  currentBookings: number;
  conflicts: number;
}

export interface BriefingDeadlineItem {
  eventId: string;
  eventName: string;
  locationLine: string;
  deadlineLabel: string;
  daysRemaining: number;
  severity: ActionSeverity;
  routeStatus: string;
  recommendedAction: ActionLabel;
}

export interface BriefingBooking {
  id: string;
  eventName: string;
  city: string;
  state: string;
  dateRange: string;
  startsAt: string;
  endsAt: string;
  lifecycle: BookingLifecycle;
  statusLine: string;
  organizer: string;
  standOrZone?: string;
  blockedWeeks: string[];
  outcomesRecorded: number;
  missingOutcomeInputs: string[];
}

export interface BriefingTaskMember {
  id: string;
  name: string;
  dateRange: string;
  locationLine: string;
  recommendation: Recommendation;
  confidence: ConfidenceLevel;
  deadlineLine: string;
  action: ActionLabel;
  severity: ActionSeverity;
}

export interface BriefingTask {
  key: string;
  organizerName: string;
  events: BriefingTaskMember[];
  priorityDates: string[];
  urgency: ActionSeverity;
  action: ActionLabel;
  nextAction: string;
  confidence: ConfidenceLevel;
}

export interface BriefingOrganizer {
  name: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactLine: string;
  contactStatus: string;
  /** Unconfirmed capacity / category / fee questions across its events. */
  openQuestions: number;
  eventCount: number;
  /** The organizer-level ask where a task exists; "—" where none does. */
  nextAction: string;
}

export interface BriefingView {
  generatedAt: string;
  kpis: BriefingKpis;
  summarySentence: string;
  pipelineCounts: Array<{ label: PipelineLabel; count: number }>;
  deadlineRadar: BriefingDeadlineItem[];
  bookings: BriefingBooking[];
  actionQueue: BriefingTask[];
  organizers: BriefingOrganizer[];
}
