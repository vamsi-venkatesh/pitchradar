/**
 * APPROVAL BOUNDARY, END TO END — driven through the REAL HTTP handler.
 *
 * PitchRadar's whole safety claim is one sentence: an approval is a decision
 * recorded in state, and nothing in this repo can send. The two `/decision`
 * routes are where that claim is either true or false:
 *
 *   POST /api/agent/actions/:id/decision                     (owner)
 *   POST /api/outreach/requests/:id/decision                 (owner)
 *
 * They are also the ONLY two. There is no second, non-owner way in: a decision
 * path outside `/api/agent` and `/api/outreach` is not a route at all, and a
 * case below proves the handler does not claim one.
 *
 * Until now they had essentially no coverage. This file exercises them against
 * `handleAgentApi` itself — same request/response fakes as `http.test.ts` — and
 * asserts BOTH halves every time: the status/state the route reports, and that
 * the process made zero outbound calls while reporting it. `globalThis.fetch`
 * is replaced by a spy that THROWS, so a send would fail the test twice over:
 * once on the call count and once on the request itself.
 *
 * Nothing here touches a database. The owner-action cases run on the JSON store
 * in a throwaway runtime directory; the one path that is DB-only (the outreach
 * decision) is exercised against a fully mocked `pg` module, exactly as
 * `server/database.test.ts` does, and its limit is stated where it is used.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwnerSession } from "./auth";
import { handleAgentApi } from "./http";
import { createAction, readRuntimeState } from "./store";

let fetchSpy: ReturnType<typeof vi.fn>;

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
  Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });

  let responseBody = "";
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    on() {},
    write(value: string) {
      responseBody += value;
      return true;
    },
    end(value?: string) {
      responseBody += value || "";
      (this as { writableEnded: boolean }).writableEnded = true;
    }
  } as unknown as ServerResponse;

  const handled = await handleAgentApi(request, response);
  let body: Record<string, unknown> = {};
  try {
    body = responseBody ? JSON.parse(responseBody) as Record<string, unknown> : {};
  } catch {
    // non-JSON bodies are not produced by any route under test
  }
  return { handled, status: response.statusCode, body };
}

let runtimeDir = "";

async function useTemporaryRuntime() {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pitchradar-approval-test-"));
  vi.stubEnv("PITCHRADAR_RUNTIME_DIR", runtimeDir);
  vi.stubEnv("PITCHRADAR_LLM_API_KEY", "");
}

async function pendingAction(title = "Email the Cottbus organizer about a pitch") {
  return createAction({
    kind: "email",
    title,
    detail: "Draft only. Nothing in this repo can send it.",
    target: "organizer@example.test"
  });
}

async function actionById(id: string) {
  const state = await readRuntimeState();
  return state.actions.find((action) => action.id === id);
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("approval must never send: an outbound fetch was attempted");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (runtimeDir) {
    await rm(runtimeDir, { recursive: true, force: true });
    runtimeDir = "";
  }
});

// ── (a) nobody gets in without credentials ───────────────────────────────────
describe("unauthenticated decisions are refused on every decision route", () => {
  function requireOwnerAuth() {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "required");
    vi.stubEnv("PITCHRADAR_SESSION_SECRET", "a-session-secret-of-at-least-32-characters!!");
    vi.stubEnv("PITCHRADAR_OWNER_PASSWORD_HASH", "scrypt$16384$8$1$c2FsdA$aGFzaA");
  }

  it("refuses an agent-action decision with no owner session (401)", async () => {
    requireOwnerAuth();
    const result = await invoke({
      method: "POST",
      url: `/api/agent/actions/${crypto.randomUUID()}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" }
    });
    expect(result).toMatchObject({
      status: 401,
      body: { error: "Owner authentication required." }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an outreach decision with no owner session (401)", async () => {
    requireOwnerAuth();
    const result = await invoke({
      method: "POST",
      url: `/api/outreach/requests/${crypto.randomUUID()}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" }
    });
    expect(result).toMatchObject({
      status: 401,
      body: { error: "Owner authentication required." }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("offers no second, non-owner decision route at all", async () => {
    // The owner routes above are the only decision paths that exist. A request
    // to any other /api/integrations/... decision path is not authenticated by
    // some weaker proof — it is not a route: the API handler declines it, so a
    // caller reaches the static handler and never the action store.
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const action = await pendingAction("Email the Dresden organizer");

    for (const url of [
      `/api/integrations/actions/${action.id}/decision`,
      `/api/integrations/messaging/actions/${action.id}/decision`,
      `/api/actions/${action.id}/decision`
    ]) {
      const result = await invoke({
        method: "POST",
        url,
        body: JSON.stringify({ decision: "approve" }),
        headers: { "content-type": "application/json" }
      });
      expect(result.handled).toBe(false);
    }

    // The refusal is complete: the action never moved.
    expect(await actionById(action.id)).toMatchObject({ status: "pending" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an agent-action decision from an external caller with no session, whatever it sends", async () => {
    requireOwnerAuth();
    await useTemporaryRuntime();
    const action = await pendingAction("Email the Cottbus organizer");
    const result = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({
        decision: "approve",
        // Fields a would-be integration might hope are honoured. None are.
        actorId: "owner",
        tenantId: "demo-operator",
        messageId: "external-1"
      }),
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" }
    });
    expect(result).toMatchObject({
      status: 401,
      body: { error: "Owner authentication required." }
    });
    expect(await actionById(action.id)).toMatchObject({ status: "pending" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── (b)/(c) approve holds, deny denies, and neither sends ────────────────────
describe("an approved action is held, never sent", () => {
  it("moves a pending action to approved_waiting_connector with zero network calls", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const action = await pendingAction();
    expect(action.status).toBe("pending");

    const result = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" }
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      action: { id: action.id, status: "approved_waiting_connector" },
      note: "Approved and held. No connector is enabled, so nothing was sent."
    });
    // The receipt is not the proof: read the durable state back.
    const stored = await actionById(action.id);
    expect(stored).toMatchObject({ status: "approved_waiting_connector" });
    expect(stored?.decidedAt).toBeTruthy();
    // THE product law. Approval is a state change, not a send.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });

  it("marks a denied action denied, also with zero network calls", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const action = await pendingAction("Call the Plauen organizer");

    const result = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "deny" }),
      headers: { "content-type": "application/json" }
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      action: { id: action.id, status: "denied" },
      note: "Denied. Nothing was sent."
    });
    expect(await actionById(action.id)).toMatchObject({ status: "denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to decide the same action twice, and refuses an unknown decision word", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();
    const action = await pendingAction("Message the Bergheim tour operator");

    const approved = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: { "content-type": "application/json" }
    });
    expect(approved.status).toBe(200);

    // decideAction only moves rows that are still `pending`, so a replay is a
    // 404, not a second approval.
    const replay = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "deny" }),
      headers: { "content-type": "application/json" }
    });
    expect(replay).toMatchObject({ status: 404, body: { error: "Pending action not found." } });
    expect(await actionById(action.id)).toMatchObject({ status: "approved_waiting_connector" });

    const nonsense = await invoke({
      method: "POST",
      url: `/api/agent/actions/${crypto.randomUUID()}/decision`,
      body: JSON.stringify({ decision: "send" }),
      headers: { "content-type": "application/json" }
    });
    expect(nonsense).toMatchObject({
      status: 400,
      body: { error: "Decision must be approve or deny." }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("holds an approved action in the same state whatever KIND it is", async () => {
    // The gate is on the ACT, not the medium: every proposable kind lands on
    // `approved_waiting_connector` and none of them sends.
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
    await useTemporaryRuntime();

    for (const kind of ["email", "application", "calendar", "organizer_contact"] as const) {
      const action = await createAction({
        kind,
        title: `Prepared ${kind} for the Dresden organizer`,
        detail: "Draft only. Nothing in this repo can send it."
      });
      const result = await invoke({
        method: "POST",
        url: `/api/agent/actions/${action.id}/decision`,
        body: JSON.stringify({ decision: "approve" }),
        headers: { "content-type": "application/json" }
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        action: { id: action.id, status: "approved_waiting_connector" },
        note: "Approved and held. No connector is enabled, so nothing was sent."
      });
      expect(await actionById(action.id)).toMatchObject({ status: "approved_waiting_connector" });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── (d) CSRF ─────────────────────────────────────────────────────────────────
describe("CSRF gate on the owner decision routes", () => {
  function enableOwnerAuth() {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "required");
    vi.stubEnv("PITCHRADAR_SESSION_SECRET", "a-session-secret-of-at-least-32-characters!!");
    vi.stubEnv("PITCHRADAR_OWNER_PASSWORD_HASH", "scrypt$16384$8$1$c2FsdA$aGFzaA");
    return createOwnerSession();
  }

  it("rejects an agent-action approval carrying a session but no action token", async () => {
    const session = enableOwnerAuth();
    await useTemporaryRuntime();
    const action = await pendingAction("Email the Halle organizer");

    const noCsrf = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`
      }
    });
    expect(noCsrf).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
    // The refusal must be complete: the action is untouched.
    expect(await actionById(action.id)).toMatchObject({ status: "pending" });

    const wrongCsrf = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`,
        "x-pitchradar-csrf": "not-the-right-token"
      }
    });
    expect(wrongCsrf.status).toBe(403);
    expect(await actionById(action.id)).toMatchObject({ status: "pending" });

    // With the real token the same request goes through — proving the 403s
    // above came from the CSRF gate and not from something incidental.
    const approved = await invoke({
      method: "POST",
      url: `/api/agent/actions/${action.id}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`,
        "x-pitchradar-csrf": session.csrfToken
      }
    });
    expect(approved.status).toBe(200);
    expect(await actionById(action.id)).toMatchObject({ status: "approved_waiting_connector" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an outreach approval carrying a session but no action token", async () => {
    const session = enableOwnerAuth();
    const result = await invoke({
      method: "POST",
      url: `/api/outreach/requests/${crypto.randomUUID()}/decision`,
      body: JSON.stringify({ decision: "approve" }),
      headers: {
        "content-type": "application/json",
        cookie: `pitchradar_owner=${session.token}`
      }
    });
    expect(result).toMatchObject({
      status: 403,
      body: { error: "Owner action token is missing or invalid." }
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── (e) the blocked_contact_missing guard, through the route ─────────────────
describe("an availability request without a verified route cannot be approved", () => {
  /**
   * This route is DB-only: `decideAvailabilityRequest` returns null the moment
   * no database is configured. So the whole module graph is re-imported against
   * a MOCKED `pg` (the pattern `server/database.test.ts` established) — no
   * socket is ever opened, and the operating database is never named.
   *
   * WHAT THIS PROVES, EXACTLY: that the guard is expressed in the statement the
   * product actually issues — `status in ('owner_review',
   * 'blocked_contact_missing')` plus `($2 <> 'approved_waiting_connector' or
   * status = 'owner_review')`, which is what excludes a blocked row from
   * approval — and that when that predicate matches nothing, the route answers
   * 409 and writes NO receipt.
   *
   * WHAT IT DOES NOT PROVE: that PostgreSQL evaluates that predicate the way we
   * read it. Only a real database can show that, and this suite is forbidden
   * one. Saying so here is cheaper than being wrong about it later.
   */
  afterEach(() => {
    process.env.VITEST = "true";
    delete process.env.PITCHRADAR_DATABASE_URL;
    vi.doUnmock("pg");
    vi.resetModules();
  });

  it("answers 409 and writes no receipt when the guard matches no row", async () => {
    const issued: Array<{ text: string; values?: unknown[] }> = [];
    const fakeClient = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        issued.push({ text, values });
        // Postgres returns zero rows for a row the guard excludes — which is
        // exactly what a `blocked_contact_missing` row does on an approve.
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    };
    class FakePool {
      connect = vi.fn(async () => fakeClient);
      query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      end = vi.fn(async () => {});
    }
    vi.doMock("pg", () => ({ Pool: FakePool }));
    vi.resetModules();
    process.env.VITEST = "false";
    process.env.PITCHRADAR_DATABASE_URL = "postgres://mocked-by-vitest/never-connected";
    process.env.PITCHRADAR_AUTH_MODE = "disabled";

    const http = await import("./http");
    const requestId = crypto.randomUUID();

    let responseBody = "";
    const request = Readable.from([JSON.stringify({ decision: "approve" })]) as unknown as IncomingMessage;
    request.method = "POST";
    request.url = `/api/outreach/requests/${requestId}/decision`;
    request.headers = { "content-type": "application/json" };
    Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });
    const response = {
      statusCode: 200,
      writableEnded: false,
      setHeader() {},
      flushHeaders() {},
      on() {},
      write() { return true; },
      end(value?: string) {
        responseBody += value || "";
        (this as { writableEnded: boolean }).writableEnded = true;
      }
    } as unknown as ServerResponse;

    await http.handleAgentApi(request, response);
    const body = JSON.parse(responseBody) as Record<string, unknown>;

    expect(response.statusCode).toBe(409);
    expect(body.error).toMatch(/need a verified route before approval/i);

    const update = issued.find((statement) => /update availability_verification_requests/i.test(statement.text));
    expect(update).toBeDefined();
    // The two clauses that make a blocked row unapprovable.
    expect(update!.text).toContain("status in ('owner_review', 'blocked_contact_missing')");
    expect(update!.text).toContain("$2 <> 'approved_waiting_connector' or status = 'owner_review'");
    expect(update!.values?.[0]).toBe(requestId);
    expect(update!.values?.[1]).toBe("approved_waiting_connector");

    // No row changed, so no receipt may exist: a receipt for a refused approval
    // would be a false record of an owner decision.
    expect(issued.some((statement) => /insert into availability_verification_receipts/i.test(statement.text)))
      .toBe(false);
    // And the transaction still closed cleanly.
    expect(issued.map((statement) => statement.text.toLowerCase())).toContain("commit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
