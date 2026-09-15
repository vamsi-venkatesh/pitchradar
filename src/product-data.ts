import type { RegisteredSource } from "./source-registry";
import type {
  AvailabilityVerificationRequest,
  ClientBooking,
  ClientProfile,
  EventOpportunity
} from "./types";
import { authFetch } from "./auth-client";
import type { BriefingView } from "./briefing";

export type CatalogueMode = "postgres" | "fixtures";

export interface DiscoveryHealth {
  rawOccurrences: number;
  pending: number;
  linked: number;
  ignored: number;
  rejected: number;
  lastObservedAt?: string;
}

export interface ProductSnapshot {
  mode: CatalogueMode;
  loadedAt: string;
  events: EventOpportunity[];
  bookings: ClientBooking[];
  profile: ClientProfile;
  missingProfileInputs: string[];
  sources: RegisteredSource[];
  discovery: DiscoveryHealth;
  verificationQueue: AvailabilityVerificationRequest[];
  /**
   * The weekly brief's OWN derivations — KPI row, pipeline counts, deadline
   * radar, booking lifecycles, organizer tasks. Optional because the field is
   * additive: a snapshot read from a build that predates it still loads. Where
   * it is present nothing on this page may recompute what it carries.
   */
  briefing?: BriefingView;
}

export async function fetchProductSnapshot(signal?: AbortSignal): Promise<ProductSnapshot> {
  const response = await authFetch("/api/product/snapshot", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Catalogue request failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<ProductSnapshot>;
}
