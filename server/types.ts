export type AgentEventType = "status" | "tool" | "tool_result" | "reply" | "error";

export interface AgentEvent {
  type: AgentEventType;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  summary?: string;
}

export interface AgentReceipt {
  id: string;
  tool: string;
  status: "verified" | "recorded" | "proposed" | "unavailable" | "failed";
  summary: string;
  sourceUrl?: string;
  observedAt: string;
  details?: Record<string, unknown>;
}

export interface AgentAction {
  id: string;
  kind: "email" | "application" | "whatsapp" | "calendar" | "organizer_contact";
  title: string;
  detail: string;
  target?: string;
  status: "pending" | "approved_waiting_connector" | "denied";
  createdAt: string;
  decidedAt?: string;
}

export type PitchRadarAgentId =
  | "command_agent"
  | "scout_agent"
  | "verifier_agent"
  | "opportunity_agent"
  | "application_agent"
  | "schedule_agent"
  | "memory_agent"
  | "approval_agent"
  | "pipeline_agent"
  | "pitchradar_owner";

export interface AgentMemory {
  id: string;
  tenantId: string;
  appId: "event_ops";
  agentId: PitchRadarAgentId;
  sessionId: string;
  kind: "episode" | "fact" | "decision";
  /**
   * Where the remembered content came from. "owner" = the owner's own words,
   * "web_derived" = influenced by fetched external web content, "agent" =
   * PitchRadar's own operational notes. Legacy memories have no origin.
   */
  origin?: "owner" | "web_derived" | "agent";
  text: string;
  createdAt: string;
}

/** Durable memory row exposed by GET /api/agent/memories. */
export interface AgentMemoryListItem {
  id: string;
  kind: "fact" | "decision";
  text: string;
  origin?: AgentMemory["origin"];
  createdAt: string;
  agentId: PitchRadarAgentId;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Conversation session this message belongs to. Legacy messages without one count as "owner-default". */
  sessionId?: string;
  receipts?: AgentReceipt[];
}

export interface RuntimeState {
  version: 1;
  selections: Record<string, "shortlist" | "watch" | "skip">;
  pipelineOverrides: Record<string, string>;
  actions: AgentAction[];
  memories: AgentMemory[];
  messages: AgentMessage[];
}

export interface AgentCapabilities {
  productRead: boolean;
  productWrite: boolean;
  catalogue: "postgres" | "fixtures";
  directWebCheck: boolean;
  broadWebSearch: boolean;
  llmConversation: boolean;
  externalMessaging: false;
  memory: "local_store_compatible";
  retrieval: "live_hybrid_rag";
  automation: {
    provider: "n8n";
    configured: boolean;
    deliveryEnabled: false;
  };
  orchestration: {
    commandAgent: "command_agent";
    sharedMemory: true;
    agents: Array<{ id: Exclude<PitchRadarAgentId, "pitchradar_owner">; name: string; responsibility: string }>;
    tools: string[];
  };
}

export interface AgentStateResponse {
  agent: {
    name: "PitchRadar";
    role: string;
    mode: "language_model" | "deterministic_core";
    model: string;
  };
  capabilities: AgentCapabilities;
  selections: RuntimeState["selections"];
  actions: AgentAction[];
  messages: AgentMessage[];
}

export interface AgentChatResponse extends AgentStateResponse {
  message: AgentMessage;
  trace: AgentEvent[];
}

/* ------------------------------------------------------------------ *
 * Deadline monitor + weather (migrations 012/013). These are additive
 * server-side extensions of the shared product snapshot: every field is
 * optional or new, so an older client simply ignores them.
 * ------------------------------------------------------------------ */

import type { EventOpportunity } from "../src/types";
import type { ProductSnapshot } from "../src/product-data";
import type { DeadlineEvidence } from "./deadline-monitor";
import type { WeatherRiskFlag } from "./weather";

export type { DeadlineEvidence, WeatherRiskFlag };

/** A pending deadline alert, joined to the event it belongs to. */
export interface DeadlineAlertView {
  id: string;
  eventId: string;
  eventName: string;
  city: string;
  /** The published deadline this alert counts down to, as YYYY-MM-DD. */
  deadline: string;
  thresholdDays: number;
  /** Whole Berlin calendar days from today to the deadline. Negative = passed. */
  daysRemaining: number;
  alertState: "pending" | "surfaced";
  createdAt: string;
}

/** Display-only forecast. Nothing in the scoring path reads this. */
export interface EventWeatherView {
  fetchedAt: string;
  source: string;
  riskFlags: WeatherRiskFlag[];
  /** City-level geocoding precision — never the pitch location. */
  geocodePrecision?: string;
  summary?: {
    days: number;
    precipitationSumMaxMm: number | null;
    precipitationProbabilityMaxPercent: number | null;
    windSpeedMaxKmh: number | null;
    temperatureMaxC: number | null;
    temperatureMinC: number | null;
  };
}

export interface CatalogueEventOpportunity extends EventOpportunity {
  /**
   * Whether a deadline is published, still unfound, or does not exist because
   * applications are rolling. Absent for events with no application window row.
   */
  deadlineEvidence?: DeadlineEvidence;
  weather?: EventWeatherView;
}

export interface CatalogueSnapshot extends ProductSnapshot {
  events: CatalogueEventOpportunity[];
  alerts: DeadlineAlertView[];
}
