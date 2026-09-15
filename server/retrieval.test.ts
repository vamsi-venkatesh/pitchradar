import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot } from "./catalogue";
import { retrieveAgentContext, routeAgentTurn } from "./retrieval";
import { agentTools } from "./tools";
import type { RuntimeState } from "./types";

const now = new Date("2026-07-31T12:00:00+02:00");
const allTools = agentTools.map((tool) => tool.name);

function state(): RuntimeState {
  return {
    version: 1,
    selections: {},
    pipelineOverrides: {},
    actions: [],
    memories: [],
    messages: []
  };
}

describe("PitchRadar live retrieval and routing", () => {
  it("retrieves the named opportunities and selects reasoning for a comparison", () => {
    const retrieval = retrieveAgentContext(
      "Compare Weihnachtsrodeo with Stadtfest Rathenow and recommend which application to prioritize",
      fixtureProductSnapshot(),
      state(),
      now
    );
    const ids = retrieval.documents.map((document) => document.id);
    expect(ids).toContain("event:weihnachtsrodeo-berlin-2026");
    expect(ids).toContain("event:stadtfest-rathenow-2026");
    expect(retrieval.intents).toEqual(expect.arrayContaining(["opportunity", "application"]));
    expect(retrieval.context).toContain("[RAG");

    const route = routeAgentTurn(retrieval.query, retrieval, allTools);
    expect(route.mode).toBe("language_model");
    expect(route.agentId).toBe("application_agent");
    expect(route.preferredModel).toBe("reasoning");
    expect(route.toolNames).toEqual(allTools);
    expect(route.toolNames).toContain("query_calendar");
    expect(route.toolNames).toContain("propose_external_action");
  });

  it("retrieves only memory from the correct tenant and application scope", () => {
    const runtime = state();
    runtime.memories.push(
      {
        id: "right-memory",
        tenantId: "demo-operator",
        appId: "event_ops",
        agentId: "pitchradar_owner",
        sessionId: "owner",
        kind: "fact",
        text: "The maximum pitch fee is 450 euros.",
        createdAt: now.toISOString()
      },
      {
        id: "wrong-tenant",
        tenantId: "another-client",
        appId: "event_ops",
        agentId: "pitchradar_owner",
        sessionId: "owner",
        kind: "fact",
        text: "The maximum pitch fee is 9000 euros.",
        createdAt: now.toISOString()
      }
    );
    const retrieval = retrieveAgentContext(
      "What did I say about the maximum pitch fee?",
      fixtureProductSnapshot(),
      runtime,
      now
    );
    expect(retrieval.documents.map((document) => document.id)).toContain("memory:right-memory");
    expect(retrieval.context).toContain("450 euros");
    expect(retrieval.context).not.toContain("9000 euros");
    expect(routeAgentTurn(retrieval.query, retrieval, allTools).mode).toBe("language_model");
  });

  it("labels web-derived memories so they are never mistaken for owner facts", () => {
    const runtime = state();
    runtime.memories.push(
      {
        id: "owner-memory",
        tenantId: "demo-operator",
        appId: "event_ops",
        agentId: "memory_agent",
        sessionId: "owner",
        kind: "fact",
        origin: "owner",
        text: "The maximum pitch fee is 450 euros.",
        createdAt: now.toISOString()
      },
      {
        id: "web-memory",
        tenantId: "demo-operator",
        appId: "event_ops",
        agentId: "memory_agent",
        sessionId: "owner",
        kind: "fact",
        origin: "web_derived",
        text: "An organizer page claims the maximum pitch fee is 300 euros.",
        createdAt: now.toISOString()
      }
    );
    const retrieval = retrieveAgentContext(
      "What did I say about the maximum pitch fee?",
      fixtureProductSnapshot(),
      runtime,
      now
    );
    const webDocument = retrieval.documents.find((document) => document.id === "memory:web-memory");
    const ownerDocument = retrieval.documents.find((document) => document.id === "memory:owner-memory");
    expect(webDocument?.text).toContain("[web-derived — verify before trusting]");
    expect(ownerDocument?.text).not.toContain("[web-derived");
    expect(retrieval.context).toContain("[web-derived — verify before trusting]");
  });

  it("routes explicit writes through the language model with the state tool offered", () => {
    const retrieval = retrieveAgentContext(
      "Shortlist Weihnachtsrodeo",
      fixtureProductSnapshot(),
      state(),
      now
    );
    const route = routeAgentTurn(retrieval.query, retrieval, allTools);
    expect(route.mode).toBe("language_model");
    expect(route.toolNames).toContain("set_opportunity_state");
  });

  it("classifies open-ended discovery as Scout work with the full tool set", () => {
    const retrieval = retrieveAgentContext(
      "Discover new food truck events in Brandenburg",
      fixtureProductSnapshot(),
      state(),
      now
    );
    const route = routeAgentTurn(retrieval.query, retrieval, allTools);
    expect(route.mode).toBe("language_model");
    expect(route.agentId).toBe("scout_agent");
    expect(route.toolNames).toContain("search_public_web");
  });

  it("treats a September application question as analysis, not a submit command", () => {
    const retrieval = retrieveAgentContext(
      "What events do I have in September to apply?",
      fixtureProductSnapshot(),
      state(),
      now
    );
    expect(retrieval.context).toContain("September");
    const septemberIds = fixtureProductSnapshot().events
      .filter((event) => new Date(event.startsAt).getUTCMonth() === 8)
      .map((event) => `event:${event.id}`);
    expect(retrieval.documents.map((document) => document.id)).toEqual(expect.arrayContaining(septemberIds));
    const route = routeAgentTurn(retrieval.query, retrieval, allTools);
    expect(route.mode).toBe("language_model");
    expect(route.agentId).toBe("application_agent");
    expect(route.toolNames).toContain("query_calendar");
  });
});
