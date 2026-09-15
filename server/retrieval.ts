import { buildAgentQueue } from "../src/agent-operations";
import { applicationDecision, applicationIntelligenceFor } from "../src/application-intelligence";
import type { ProductSnapshot } from "../src/product-data";
import { rankOpportunities } from "../src/ranking";
import type { RuntimeState } from "./types";
import type { PitchRadarAgentId } from "./types";

export type RetrievalIntent =
  | "opportunity"
  | "schedule"
  | "application"
  | "source_research"
  | "business_profile"
  | "memory"
  | "live_verification"
  | "external_action"
  | "general";

export type RetrievalDocumentType =
  | "event"
  | "booking"
  | "availability_request"
  | "source"
  | "business_profile"
  | "memory"
  | "pending_action"
  | "operating_summary";

export interface RetrievalDocument {
  id: string;
  type: RetrievalDocumentType;
  title: string;
  text: string;
  sourceUrls: string[];
  score: number;
}

export interface AgentRetrieval {
  query: string;
  intents: RetrievalIntent[];
  documents: RetrievalDocument[];
  context: string;
}

export interface AgentTurnRoute {
  mode: "deterministic" | "language_model";
  reason: string;
  preferredModel: "fast" | "reasoning";
  toolNames: string[];
  agentId: Exclude<PitchRadarAgentId, "pitchradar_owner">;
  agentName: string;
}

const stopWords = new Set([
  "a", "about", "all", "am", "an", "and", "are", "as", "at", "be", "can", "do",
  "for", "from", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our",
  "should", "show", "that", "the", "this", "to", "we", "what", "when", "which", "with",
  "you", "your", "aber", "alle", "als", "am", "an", "auf", "das", "der", "die", "ein",
  "eine", "für", "ich", "im", "in", "ist", "mit", "oder", "soll", "und", "von", "was", "wie", "zu"
]);

function normalized(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-DE")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function terms(value: string) {
  return [...new Set(
    normalized(value)
      .split(/\s+/)
      .filter((term) => term.length > 2 && !stopWords.has(term))
  )];
}

export function classifyRetrievalIntents(query: string): RetrievalIntent[] {
  const value = normalized(query);
  const intents = new Set<RetrievalIntent>();
  if (/(event|opportunit|festival|markt|veranstaltung|option|strongest|best|rank|fit|shortlist|compare|recommend|prioriti)/.test(value)) intents.add("opportunity");
  if (/(week|calendar|schedule|booking|conflict|date|when|freie woche|zeitplan)/.test(value)) intents.add("schedule");
  if (/(application|apply|deadline|draft|availability|queue|pitch|standplatz|bewerb|fee|capacity|contact|organizer)/.test(value)) intents.add("application");
  if (/(source|research|discover|search|find new|coverage|evidence|quelle|recherch)/.test(value)) intents.add("source_research");
  if (/(business|truck|menu|cost|margin|revenue|power|water|postcode|profile|permit|portion)/.test(value)) intents.add("business_profile");
  if (/(remember|memory|say|said|told|decision|constraint|noted|recall)/.test(value)) intents.add("memory");
  if (/(live|verify|recheck|official page|check now|current source)/.test(value)) intents.add("live_verification");
  if (/(send|submit|email|whatsapp|contact organizer|calendar action)/.test(value)) intents.add("external_action");
  if (!intents.size) intents.add("general");
  return [...intents];
}

function typeBoost(type: RetrievalDocumentType, intents: RetrievalIntent[]) {
  const boost: Partial<Record<RetrievalIntent, RetrievalDocumentType[]>> = {
    opportunity: ["event", "operating_summary"],
    schedule: ["booking", "event", "operating_summary"],
    application: ["availability_request", "event", "pending_action"],
    source_research: ["source", "event", "operating_summary"],
    business_profile: ["business_profile", "booking"],
    memory: ["memory"],
    live_verification: ["event", "source"],
    external_action: ["availability_request", "pending_action", "event"],
    general: ["memory", "operating_summary"]
  };
  return intents.reduce((score, intent) => {
    if (!boost[intent]?.includes(type)) return score;
    return score + (intent === "memory" && type === "memory" ? 30 : 10);
  }, 0);
}

function scoreDocument(
  document: Omit<RetrievalDocument, "score">,
  query: string,
  queryTerms: string[],
  intents: RetrievalIntent[]
) {
  const title = normalized(document.title);
  const text = normalized(document.text);
  const normalizedQuery = normalized(query);
  let score = typeBoost(document.type, intents);
  for (const term of queryTerms) {
    if (title.includes(term)) score += 8;
    if (text.includes(term)) score += 3;
  }
  if (normalizedQuery.length > 5 && `${title} ${text}`.includes(normalizedQuery)) score += 16;
  if (document.type === "operating_summary") score += 2;
  return score;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Berlin"
  }).format(new Date(value));
}

function buildDocuments(snapshot: ProductSnapshot, state: RuntimeState, now: Date) {
  const ranked = rankOpportunities(snapshot.events, snapshot.profile, now);
  const jobs = buildAgentQueue(snapshot.events, snapshot.sources, snapshot.bookings, now);
  const documents: Array<Omit<RetrievalDocument, "score"> & { baseScore?: number }> = [];

  documents.push({
    id: "operating-summary",
    type: "operating_summary",
    title: "Current PitchRadar operating picture",
    text: [
      `${ranked.filter((event) => event.tier !== "REJECTED").length} actionable events from ${snapshot.events.length} catalogue records.`,
      `${snapshot.sources.length} registered sources; ${snapshot.sources.filter((source) => source.healthState === "healthy").length} currently reachable and ${snapshot.sources.filter((source) => source.healthState === "restricted").length} manual or restricted.`,
      `${snapshot.discovery.linked} discoveries linked, ${snapshot.discovery.pending} pending.`,
      `${snapshot.verificationQueue.filter((request) => request.status === "owner_review").length} availability drafts ready for owner review and ${snapshot.verificationQueue.filter((request) => request.status === "blocked_contact_missing").length} blocked on a route.`,
      `${jobs.filter((job) => new Date(job.dueAt) <= now).length} research jobs are due.`,
      "External delivery connectors are disabled."
    ].join(" "),
    sourceUrls: []
  });

  ranked.forEach((event, index) => {
    const application = applicationDecision(event, now);
    const intelligence = applicationIntelligenceFor(event);
    documents.push({
      id: `event:${event.id}`,
      type: "event",
      title: `${event.name} — ${event.city}`,
      text: [
        `Dates ${formatDate(event.startsAt)} to ${formatDate(event.endsAt)} in ${event.city}, ${event.state}.`,
        `Rank ${index + 1}; score ${event.score ?? "unknown"}; tier ${event.tier ?? "unknown"}; verification ${event.verification}.`,
        `Application: ${application.label}. Next action: ${application.nextAction}`,
        `Route ${intelligence.route}; route owner ${intelligence.routeOwner || event.organizer || "unresolved"}; route reachable ${Boolean(intelligence.routeReachable)}; category capacity ${intelligence.capacityState}.`,
      `Contact ${event.contactEmail || event.contactPhone || "not verified"}.`,
        `Stored travel evidence: ${event.travelKm === undefined ? "distance not calculated" : `${event.travelKm} km`}; ${event.travelMinutes === undefined ? "time not calculated" : `${event.travelMinutes} minutes`}. Never estimate missing travel values from the city name.`,
        `Owner selection ${state.selections[event.id] || "none"}; pipeline ${state.pipelineOverrides[event.id] || event.pipeline}.`,
        `Fit: ${event.fitSignals.join("; ") || "none recorded"}. Risks: ${event.riskSignals.join("; ") || "none recorded"}.`,
        `Missing: ${event.missingFields.join("; ") || "none"}.`
      ].join(" "),
      sourceUrls: event.sources.filter((source) => source.official).map((source) => source.url).slice(0, 3),
      baseScore: Math.max(0, 6 - index)
    });
  });

  snapshot.bookings.forEach((booking) => documents.push({
    id: `booking:${booking.id}`,
    type: "booking",
    title: `${booking.eventName} — ${booking.bookingState} booking`,
    text: `${formatDate(booking.startsAt)} to ${formatDate(booking.endsAt)} in ${booking.city}. ${booking.relationshipNote} Confirmed: ${booking.confirmedFacts.join("; ") || "none"}. Missing outcomes: ${booking.missingOutcomeInputs.join("; ") || "none"}.`,
    sourceUrls: booking.sources.map((source) => source.url).slice(0, 3)
  }));

  snapshot.verificationQueue.forEach((request) => documents.push({
    id: `availability:${request.id}`,
    type: "availability_request",
    title: `${request.eventName} — ${request.weekKey} ${request.weeklyRole}`,
    text: `Status ${request.status}; channel ${request.channel}; route verified ${request.routeVerified}; recipient ${request.recipientName || request.recipientEmail || request.recipientPhone || request.applicationUrl || "missing"}; owner approval required ${request.approvalRequired}; external action taken false.`,
    sourceUrls: request.applicationUrl ? [request.applicationUrl] : []
  }));

  snapshot.sources.forEach((source) => documents.push({
    id: `source:${source.id}`,
    type: "source",
    title: source.name,
    text: `Layer ${source.layer}; priority ${source.priority}; cadence ${source.cadence}; health ${source.healthState || "unchecked"}; last checked ${source.lastCheckedAt || "never"}; extraction ${source.extractionMode}; trust rule ${source.trustRule}; business value ${source.businessValue}.`,
    sourceUrls: [source.baseUrl]
  }));

  documents.push({
    id: "business-profile",
    type: "business_profile",
    title: "speciality truck business profile",
    text: `Home ${snapshot.profile.homeRegion}${snapshot.profile.homePostcode ? ` ${snapshot.profile.homePostcode}` : ""}; normal operating days ${snapshot.profile.normalDays.join(",")}; optional Thursday ${snapshot.profile.optionalThursday}; preferred travel ${snapshot.profile.preferredMaxTravelMinutes} minutes; exceptional maximum ${snapshot.profile.exceptionalMaxTravelMinutes} minutes; menu ${snapshot.profile.menu.map((item) => `${item.name} €${item.priceEur}`).join(", ")}; missing inputs ${snapshot.missingProfileInputs.join("; ") || "none"}.`,
    sourceUrls: []
  });

  const scopedMemories = state.memories
    .filter((memory) => memory.tenantId === "demo-operator" && memory.appId === "event_ops")
    .slice(-24);
  scopedMemories.forEach((memory, index) => documents.push({
      id: `memory:${memory.id}`,
      type: "memory",
      title: `${memory.kind} memory from ${formatDate(memory.createdAt)}`,
      text: `${memory.origin === "web_derived" ? "[web-derived — verify before trusting] " : ""}Shared memory contributed by ${memory.agentId}: ${memory.text}`,
      sourceUrls: [],
      baseScore: scopedMemories.length ? (index + 1) / scopedMemories.length * 3 : 0
    }));

  state.actions
    .filter((action) => action.status === "pending")
    .forEach((action) => documents.push({
      id: `action:${action.id}`,
      type: "pending_action",
      title: action.title,
      text: `Pending ${action.kind} proposal. Target ${action.target || "not set"}. Detail: ${action.detail}. Nothing has been sent.`,
      sourceUrls: []
    }));

  return documents;
}

export function retrieveAgentContext(
  query: string,
  snapshot: ProductSnapshot,
  state: RuntimeState,
  now = new Date(),
  limit = 9
): AgentRetrieval {
  const intents = classifyRetrievalIntents(query);
  const queryTerms = terms(query);
  const monthQuery = /\b(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|marz|maerz|mai|juni|juli|august|september|oktober|november|dezember)\b/i.test(query);
  const effectiveLimit = monthQuery ? Math.max(limit, 20) : limit;
  const ranked = buildDocuments(snapshot, state, now)
    .map(({ baseScore = 0, ...document }) => ({
      ...document,
      score: scoreDocument(document, query, queryTerms, intents) + baseScore
    }))
    .filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, Math.max(3, Math.min(effectiveLimit, 24)));

  const context = ranked.map((document, index) => [
    `[RAG ${index + 1} | ${document.type} | ${document.id}]`,
    `Title: ${document.title}`,
    `Facts: ${document.text}`,
    document.sourceUrls.length ? `Official/public sources: ${document.sourceUrls.join(" | ")}` : ""
  ].filter(Boolean).join("\n")).join("\n\n").slice(0, monthQuery ? 26_000 : 14_000);

  return { query, intents, documents: ranked, context };
}

export function routeAgentTurn(
  query: string,
  retrieval: Pick<AgentRetrieval, "intents">,
  allToolNames: string[]
): AgentTurnRoute {
  const value = normalized(query);
  // Every turn is answered by the language model with the FULL tool set. The
  // specialist label records which domain the Command Agent considers primary;
  // it never restricts what the model may read or do within the safety gates.
  const reasoning = /(compare|tradeoff|trade off|strategy|plan|why|analyse|analyze|recommend|prioriti|best move|prepare this week|route|portfolio|worth it|decide)/.test(value)
    || retrieval.intents.length >= 3;
  const specialist = retrieval.intents.includes("external_action")
    ? { agentId: "approval_agent" as const, agentName: "Approval Agent" }
    : retrieval.intents.includes("source_research")
      ? { agentId: "scout_agent" as const, agentName: "Scout Agent" }
      : retrieval.intents.includes("live_verification")
        ? { agentId: "verifier_agent" as const, agentName: "Verifier Agent" }
        : retrieval.intents.includes("application")
          ? { agentId: "application_agent" as const, agentName: "Application Agent" }
          : retrieval.intents.includes("schedule")
            ? { agentId: "schedule_agent" as const, agentName: "Schedule Agent" }
            : retrieval.intents.includes("opportunity")
              ? { agentId: "opportunity_agent" as const, agentName: "Opportunity Agent" }
              : retrieval.intents.includes("memory") || retrieval.intents.includes("business_profile")
                ? { agentId: "memory_agent" as const, agentName: "Memory Agent" }
                : { agentId: "command_agent" as const, agentName: "Command Agent" };
  return {
    mode: "language_model",
    reason: reasoning ? "multi-factor decision synthesis" : "conversational answer grounded in live product truth",
    preferredModel: reasoning ? "reasoning" : "fast",
    toolNames: allToolNames,
    ...specialist
  };
}
