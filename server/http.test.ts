import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnerSession } from "./auth";
import { handleAgentApi } from "./http";
import { remember } from "./store";

async function invoke(input: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}) {
  const request = Readable.from(input.body ? [input.body] : []) as unknown as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = input.headers || {};
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: "127.0.0.1" }
  });

  const headers = new Map<string, string | number | readonly string[]>();
  let responseBody = "";
  let ended = false;
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
    },
    flushHeaders() {},
    on() {},
    write(value: string) {
      responseBody += value;
      return true;
    },
    end(value?: string) {
      responseBody += value || "";
      ended = true;
      (this as { writableEnded: boolean }).writableEnded = true;
    }
  } as unknown as ServerResponse;

  const handled = await handleAgentApi(request, response);
  let body: Record<string, unknown> = {};
  try {
    body = responseBody ? JSON.parse(responseBody) as Record<string, unknown> : {};
  } catch {
    // Streaming responses are not JSON; use `text` instead.
  }
  return { handled, status: response.statusCode, headers, body, text: responseBody, ended };
}

/** Parses `event:`/`data:` SSE frames out of a raw streamed body. */
function parseSseFrames(raw: string) {
  return raw
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
    });
}

let runtimeDir = "";

async function useTemporaryRuntime() {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pitchradar-http-test-"));
  vi.stubEnv("PITCHRADAR_RUNTIME_DIR", runtimeDir);
  vi.stubEnv("PITCHRADAR_LLM_API_KEY", "");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (runtimeDir) {
    await rm(runtimeDir, { recursive: true, force: true });
    runtimeDir = "";
  }
});

describe("HTTP API boundary", () => {
  it("reports production as unavailable when its operating database is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    const result = await invoke({ method: "GET", url: "/api/health" });
    expect(result).toMatchObject({
      handled: true,
      status: 503,
      body: {
        product: "PitchRadar",
        status: "unavailable"
      }
    });
    const head = await invoke({ method: "HEAD", url: "/api/health" });
    expect(head.status).toBe(503);
  });

  it("returns client errors for malformed and oversized JSON", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    const malformed = await invoke({
      method: "POST",
      url: "/api/agent/chat",
      body: "{broken",
      headers: { "content-type": "application/json" }
    });
    const oversized = await invoke({
      method: "POST",
      url: "/api/agent/chat",
      headers: { "content-length": "32001" }
    });
    expect(malformed).toMatchObject({
      status: 400,
      body: { error: "Request body must be a valid JSON object." }
    });
    expect(oversized).toMatchObject({
      status: 413,
      body: { error: "Request body is too large." }
    });
  });

  it("validates identifiers before they reach PostgreSQL", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    const result = await invoke({
      method: "POST",
      url: "/api/outreach/requests/not-a-uuid/decision"
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: "A valid request ID is required." }
    });
  });

  it("exposes the authenticated n8n readiness contract without enabling delivery", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_URL", "https://automation.example/webhook/pitchradar-ops-v1");
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_KEY", "pitchradar-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      connected: true,
      workflow: "pitchradar_operations_v1",
      externalActions: 0
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const result = await invoke({ method: "GET", url: "/api/integrations/n8n/status" });
    expect(result).toMatchObject({
      status: 200,
      body: {
        configured: true,
        reachable: true,
        workflow: "pitchradar_operations_v1",
        externalActions: 0
      }
    });
  });

  it("rejects malformed session identifiers on state and chat", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    const badQuery = await invoke({
      method: "GET",
      url: "/api/agent/state?sessionId=not%20a%20valid%20session!"
    });
    const tooLong = await invoke({
      method: "GET",
      url: `/api/agent/state?sessionId=${"a".repeat(65)}`
    });
    const badBody = await invoke({
      method: "POST",
      url: "/api/agent/chat",
      body: JSON.stringify({ message: "Hello", sessionId: "bad session id!" }),
      headers: { "content-type": "application/json" }
    });
    const badStreamBody = await invoke({
      method: "POST",
      url: "/api/agent/chat/stream",
      body: JSON.stringify({ message: "Hello", sessionId: "bad/../session" }),
      headers: { "content-type": "application/json" }
    });
    for (const result of [badQuery, tooLong, badBody, badStreamBody]) {
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/sessionId must contain 1 to 64 characters/);
    }
  });
});

describe("Agent chat streaming endpoint", () => {
  it("emits SSE progress events and a final done event carrying the chat payload", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const result = await invoke({
      method: "POST",
      url: "/api/agent/chat/stream",
      body: JSON.stringify({ message: "Show the availability queue", sessionId: "stream-test" }),
      headers: { "content-type": "application/json" }
    });
    expect(result.status).toBe(200);
    expect(String(result.headers.get("content-type"))).toContain("text/event-stream");
    expect(String(result.headers.get("cache-control"))).toBe("no-store");
    expect(result.ended).toBe(true);

    const frames = parseSseFrames(result.text);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const statusFrames = frames.filter((frame) => frame.event === "status");
    expect(statusFrames.length).toBeGreaterThan(0);
    expect(statusFrames[0].data).toMatchObject({ text: expect.stringContaining("Command Agent routed") });

    const done = frames[frames.length - 1];
    expect(done.event).toBe("done");
    const payload = done.data as {
      message?: { role?: string; text?: string };
      trace?: Array<{ type: string }>;
      messages?: Array<{ sessionId?: string }>;
    };
    expect(payload.message?.role).toBe("assistant");
    expect(payload.message?.text).toMatch(/availability drafts/i);
    expect(payload.trace?.some((event) => event.type === "reply")).toBe(true);
    expect(payload.messages?.every((message) => message.sessionId === "stream-test")).toBe(true);
  });
});

describe("Agent memory review endpoints", () => {
  it("lists only durable memories, newest first, and deletes by id", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    await remember("Turn episode that must stay internal", "episode", "memory-test");
    const fact = await remember("The maximum pitch fee is 500 euros", "fact", "memory-test", "command_agent", "owner");
    const decision = await remember("Skip events without a verified organizer route", "decision", "memory-test", "command_agent", "agent");

    const listed = await invoke({ method: "GET", url: "/api/agent/memories" });
    expect(listed.status).toBe(200);
    const memories = listed.body.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(2);
    expect(memories.map((memory) => memory.kind).sort()).toEqual(["decision", "fact"]);
    expect(memories.every((memory) => memory.kind !== "episode")).toBe(true);
    // Newest first.
    expect(memories[0].id).toBe(decision.id);
    expect(memories[1]).toMatchObject({
      id: fact.id,
      kind: "fact",
      text: "The maximum pitch fee is 500 euros",
      origin: "owner",
      agentId: "command_agent"
    });

    const removed = await invoke({ method: "DELETE", url: `/api/agent/memories/${fact.id}` });
    expect(removed).toMatchObject({ status: 200, body: { deleted: fact.id } });
    const afterDelete = await invoke({ method: "GET", url: "/api/agent/memories" });
    expect((afterDelete.body.memories as Array<Record<string, unknown>>).map((memory) => memory.id)).toEqual([decision.id]);

    const missing = await invoke({ method: "DELETE", url: `/api/agent/memories/${crypto.randomUUID()}` });
    expect(missing).toMatchObject({ status: 404, body: { error: "Memory not found." } });
    const invalid = await invoke({ method: "DELETE", url: "/api/agent/memories/not-a-uuid" });
    expect(invalid).toMatchObject({ status: 400, body: { error: "A valid memory ID is required." } });
  });
});

describe("Client intake endpoints", () => {
  it("returns the intake schema, answers and honest progress", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const result = await invoke({ method: "GET", url: "/api/profile/intake" });
    expect(result.status).toBe(200);
    const sections = result.body.sections as Array<{ id: string; fields: unknown[] }>;
    expect(sections).toHaveLength(10);
    expect(sections[0].id).toBe("business_contact");
    expect(result.body.progress).toMatchObject({ answered: 0, deferred: 0 });
    expect(result.body.menuConfirmedAt).toBeNull();
    expect(result.body.menuLinesNeedingConfirmation).toBe(3);
    expect(result.body.missingInputs as string[])
      .toContain("Client confirmation of the menu names and prices");
  });

  it("saves one validated section and reports the smaller gap list", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const saved = await invoke({
      method: "PUT",
      url: "/api/profile/intake/home_base",
      body: JSON.stringify({ answers: { postcode: "10115", streetAddress: "Hauptstraße 1" } }),
      headers: { "content-type": "application/json" }
    });
    expect(saved.status).toBe(200);
    const answers = saved.body.answers as Record<string, Record<string, unknown>>;
    expect(answers.home_base.postcode).toMatchObject({ value: "10115", state: "provided" });
    expect(saved.body.missingInputs as string[])
      .not.toContain("Exact postcode / starting address");
  });

  it("rejects invalid input with 400 and an unknown section with 404", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const badPostcode = await invoke({
      method: "PUT",
      url: "/api/profile/intake/home_base",
      body: JSON.stringify({ answers: { postcode: "12" } }),
      headers: { "content-type": "application/json" }
    });
    expect(badPostcode.status).toBe(400);
    expect(String(badPostcode.body.error)).toMatch(/5-digit German postcode/);

    const negativePrice = await invoke({
      method: "PUT",
      url: "/api/profile/intake/economics",
      body: JSON.stringify({ answers: { foodCostPerPortion: -3 } }),
      headers: { "content-type": "application/json" }
    });
    expect(negativePrice.status).toBe(400);

    const unknownSection = await invoke({
      method: "PUT",
      url: "/api/profile/intake/not-a-section",
      body: JSON.stringify({ answers: { anything: "x" } }),
      headers: { "content-type": "application/json" }
    });
    expect(unknownSection.status).toBe(404);
    expect(String(unknownSection.body.error)).toMatch(/does not exist/);
  });

  it("confirms the menu and clears every confirmation flag", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const confirmed = await invoke({
      method: "POST",
      url: "/api/profile/menu/confirm",
      body: JSON.stringify({
        items: [
          { name: "Kräuter", priceEur: 6, vegetarian: true },
          { name: "Komplett", priceEur: 10, description: "Sour cream, cheese, ham, onion" }
        ]
      }),
      headers: { "content-type": "application/json" }
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.menuConfirmedAt).toBeTruthy();
    expect(confirmed.body.menuLinesNeedingConfirmation).toBe(0);
    const menu = confirmed.body.menu as Array<{ name: string; confirmationRequired: boolean }>;
    expect(menu).toHaveLength(2);
    expect(menu.every((item) => item.confirmationRequired === false)).toBe(true);

    const empty = await invoke({
      method: "POST",
      url: "/api/profile/menu/confirm",
      body: JSON.stringify({ items: [] }),
      headers: { "content-type": "application/json" }
    });
    expect(empty.status).toBe(400);
  });
});

describe("CSRF gate on the new mutation routes", () => {
  function enableOwnerAuth() {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "required");
    vi.stubEnv("PITCHRADAR_SESSION_SECRET", "a-session-secret-of-at-least-32-characters!!");
    vi.stubEnv("PITCHRADAR_OWNER_PASSWORD_HASH", "scrypt$16384$8$1$c2FsdA$aGFzaA");
    return createOwnerSession();
  }

  it("rejects the chat stream without a CSRF token", async () => {
    const session = enableOwnerAuth();
    const noSession = await invoke({
      method: "POST",
      url: "/api/agent/chat/stream",
      body: JSON.stringify({ message: "Hello" }),
      headers: { "content-type": "application/json" }
    });
    expect(noSession.status).toBe(401);
    const noCsrf = await invoke({
      method: "POST",
      url: "/api/agent/chat/stream",
      body: JSON.stringify({ message: "Hello" }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`
      }
    });
    expect(noCsrf).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
  });

  it("rejects an intake section save without a CSRF token", async () => {
    const session = enableOwnerAuth();
    const noSession = await invoke({
      method: "PUT",
      url: "/api/profile/intake/home_base",
      body: JSON.stringify({ answers: { postcode: "10115" } }),
      headers: { "content-type": "application/json" }
    });
    expect(noSession.status).toBe(401);
    const noCsrf = await invoke({
      method: "PUT",
      url: "/api/profile/intake/home_base",
      body: JSON.stringify({ answers: { postcode: "10115" } }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`
      }
    });
    expect(noCsrf).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
  });

  it("rejects menu confirmation without a CSRF token, and reads the intake with one", async () => {
    const session = enableOwnerAuth();
    const noSession = await invoke({
      method: "POST",
      url: "/api/profile/menu/confirm",
      body: JSON.stringify({ items: [{ name: "Kräuter", priceEur: 6 }] }),
      headers: { "content-type": "application/json" }
    });
    expect(noSession.status).toBe(401);
    const noCsrf = await invoke({
      method: "POST",
      url: "/api/profile/menu/confirm",
      body: JSON.stringify({ items: [{ name: "Kräuter", priceEur: 6 }] }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`
      }
    });
    expect(noCsrf).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
    // The read is a GET: a session alone is enough, no action token needed.
    const read = await invoke({
      method: "GET",
      url: "/api/profile/intake",
      headers: { cookie: `pitchradar_owner=${session.token}` }
    });
    expect(read.status).toBe(200);
    expect((read.body.sections as unknown[]).length).toBe(10);
  });

  it("rejects memory deletion without a CSRF token", async () => {
    const session = enableOwnerAuth();
    const noSession = await invoke({
      method: "DELETE",
      url: `/api/agent/memories/${crypto.randomUUID()}`
    });
    expect(noSession.status).toBe(401);
    const noCsrf = await invoke({
      method: "DELETE",
      url: `/api/agent/memories/${crypto.randomUUID()}`,
      headers: { cookie: `pitchradar_owner=${session.token}` }
    });
    expect(noCsrf).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
  });
});
