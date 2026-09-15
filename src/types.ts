export type VerificationState = "verified" | "partial" | "lead";
export type ApplicationState = "open" | "closed" | "unknown";
/**
 * The nine states the `pipeline_state` enum actually carries in the operating
 * database. "waitlist" and "completed" were missing from this union while the
 * database had them since migration 001 — a row in either state was typed as
 * something it is not, and any exhaustive map over this union would have been
 * silently incomplete. Read off the live enum, 2026-09-15.
 */
export type PipelineState =
  | "discovered"
  | "verifying"
  | "watching"
  | "owner_review"
  | "applied"
  | "accepted"
  | "waitlist"
  | "rejected"
  | "completed";
export type OpportunityTier = "A" | "B" | "C" | "REJECTED";
/**
 * Whether an event is a food-vendor opportunity at all. Municipal calendars
 * publish guided tours and lectures beside markets; "unclear" is the honest
 * verdict for a row the deterministic rules cannot decide, and it is deducted
 * for and tagged rather than dropped.
 */
export type VendorRelevance = "relevant" | "irrelevant" | "unclear";
export type CapacityState = "available" | "limited" | "full" | "rolling" | "not_yet_open" | "unknown";
export type ApplicationRoute = "public_form" | "email" | "phone" | "tender" | "operator_network" | "unknown";
export type ApplicationRouteScope = "event_specific" | "organizer_general" | "portal_general" | "unknown";
export type BookingState = "confirmed" | "live" | "completed" | "cancelled";
export type VerificationQueueRole = "primary" | "backup" | "verify_first";
export type VerificationQueueChannel = "email" | "phone" | "portal" | "research";
export type VerificationQueueStatus =
  | "owner_review"
  | "blocked_contact_missing"
  | "approved_waiting_connector"
  | "cancelled"
  | "sent"
  | "answered";

export interface ApplicationIntelligence {
  route: ApplicationRoute;
  capacityState: CapacityState;
  opensAt?: string;
  deadline?: string;
  expectedNextWindow?: string;
  /** null means the application window has never been checked. Never fabricate a date here. */
  lastCheckedAt: string | null;
  /** null means no check has been scheduled because none has ever happened. */
  nextCheckAt: string | null;
  routeOwner?: string;
  routeScope?: ApplicationRouteScope;
  routeReachable?: boolean;
  requirements?: string[];
  sourceUrl?: string;
  note: string;
}

export interface SourceEvidence {
  label: string;
  url: string;
  publisher: string;
  official: boolean;
  observedAt: string;
  supports: string[];
}

export interface EventOpportunity {
  id: string;
  name: string;
  city: string;
  state: string;
  startsAt: string;
  endsAt: string;
  eventType: "street_food" | "city_festival" | "market" | "sports" | "christmas" | "private";
  verification: VerificationState;
  applicationState: ApplicationState;
  applicationDeadline?: string;
  applicationUrl?: string;
  application?: ApplicationIntelligence;
  organizer?: string;
  contactEmail?: string;
  contactPhone?: string;
  /** The named person recorded for the organizer, where one is published. */
  contactPerson?: string;
  /** What that person is published as being responsible for. */
  contactRole?: string;
  /** The page the contact was read from — the evidence behind the route. */
  contactSourceUrl?: string;
  /** Who publishes that page, where the catalogue records it. */
  contactSourcePublisher?: string;
  /** When the contact was last seen on that page. */
  contactObservedAt?: string;
  expectedVisitors?: number;
  pitchFeeEur?: number;
  travelMinutes?: number;
  travelKm?: number;
  infrastructure: {
    power?: string;
    water?: boolean;
    wastewater?: boolean;
  };
  fitSignals: string[];
  riskSignals: string[];
  missingFields: string[];
  /** Defaults to "unclear" wherever the catalogue has no recorded verdict. */
  vendorRelevance?: VendorRelevance;
  sources: SourceEvidence[];
  pipeline: PipelineState;
  score?: number;
  tier?: OpportunityTier;
  scoreBreakdown?: Record<string, number>;
  rejectionReason?: string;
}

export interface ClientBooking {
  id: string;
  eventName: string;
  city: string;
  state: string;
  startsAt: string;
  endsAt: string;
  bookingState: BookingState;
  organizer: string;
  operatingPartner?: string;
  relationshipNote: string;
  standOrZone?: string;
  confirmedFacts: string[];
  missingOutcomeInputs: string[];
  /**
   * How many trading-day outcome records the owner has captured for this
   * booking. Zero on a completed booking is the whole point: it is the
   * difference between "the booking is over" and "we know how it went", and
   * the report is required to say which of those two it is.
   */
  outcomesRecorded?: number;
  sources: SourceEvidence[];
}

export interface ClientProfile {
  homeRegion: string;
  homePostcode?: string;
  normalDays: number[];
  optionalThursday: boolean;
  preferredMaxTravelMinutes: number;
  exceptionalMaxTravelMinutes: number;
  menu: Array<{ name: string; priceEur: number; confirmationRequired?: boolean }>;
  operatingInputs: {
    portionsPerHour?: number;
    portionsPerDay?: number;
    foodCostPerPortion?: number;
    labourCostPerDay?: number;
    travelCostPerKm?: number;
    truckDimensions?: string;
    power?: string;
    water?: string;
    gas?: string;
    maxPitchFeeEur?: number;
    minimumRevenueEur?: number;
  };
}

export interface AvailabilityVerificationRequest {
  id: string;
  eventId: string;
  eventName: string;
  city: string;
  startsAt: string;
  endsAt: string;
  weekKey: string;
  weeklyRole: VerificationQueueRole;
  channel: VerificationQueueChannel;
  status: VerificationQueueStatus;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  applicationUrl?: string;
  routeVerified: boolean;
  subject: string;
  draftDe: string;
  draftEn: string;
  verificationQuestions: string[];
  approvalRequired: true;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}
