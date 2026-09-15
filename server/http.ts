import type { IncomingMessage, ServerResponse } from "node:http";
import { chatWithAgent, deleteAgentMemory, getAgentState, listDurableMemories } from "./agent";
import type { AgentEvent } from "./types";
import {
  authMode,
  authorizeApiRequest,
  clearLoginFailures,
  clearOwnerSessionCookie,
  createOwnerSession,
  loginRateLimit,
  originMatchesRequest,
  readOwnerSession,
  recordLoginFailure,
  revokeOwnerSessionForRequest,
  setOwnerSessionCookie,
  verifyOwnerPassword
} from "./auth";
import { loadProductSnapshot } from "./catalogue";
import { latestOperatingCycle } from "./cycle";
import { databaseHealth, insertOwnerSession } from "./database";
import { authorizeGatewayRequest } from "./gateway-auth";
import { GatewayRequestConflict, runGatewayRequestOnce } from "./gateway-idempotency";
import { checkN8nReadiness } from "./n8n";
import { decideAvailabilityRequest, refreshAvailabilityQueue } from "./outreach";
import {
  confirmMenu,
  IntakeValidationError,
  readClientIntake,
  saveClientIntakeSection,
  UnknownIntakeSectionError
} from "./profile";
import { buildBriefingView } from "./report";
import { ISO_WEEK_PATTERN, listReportSets, readReportFile } from "./reports-library";
import { decideAction, setOpportunitySelection } from "./store";

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(JSON.stringify(payload));
}

async function readRaw(request: IncomingMessage) {
  const declaredSize = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredSize) && declaredSize > 32_000) {
    throw new ApiRequestError("Request body is too large.", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new ApiRequestError("Request body is too large.", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage) {
  const raw = await readRaw(request);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiRequestError("Request body must be a valid JSON object.", 400);
  }
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function requireValidSessionId(value: string) {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new ApiRequestError(
      "sessionId must contain 1 to 64 characters from A-Z, a-z, 0-9, _ or -.",
      400
    );
  }
  return value;
}

function validAgentMessage(body: Record<string, unknown>) {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = typeof body.sessionId === "string"
    ? body.sessionId.trim()
    : "owner-default";
  if (!message || message.length > 4_000) {
    throw new ApiRequestError("message must contain between 1 and 4,000 characters.", 400);
  }
  return { message, sessionId: requireValidSessionId(sessionId) };
}

export async function handleAgentApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url || "/", "http://localhost");
  if (
    !url.pathname.startsWith("/api/auth") &&
    !url.pathname.startsWith("/api/agent") &&
    !url.pathname.startsWith("/api/integrations/gateway") &&
    !url.pathname.startsWith("/api/integrations/n8n") &&
    !url.pathname.startsWith("/api/outreach") &&
    !url.pathname.startsWith("/api/operations") &&
    !url.pathname.startsWith("/api/events") &&
    !url.pathname.startsWith("/api/profile") &&
    !url.pathname.startsWith("/api/reports") &&
    url.pathname !== "/api/health" &&
    url.pathname !== "/api/product/snapshot"
  ) return false;
  try {
    if (url.pathname.startsWith("/api/integrations/gateway")) {
      const rawBody = ["GET", "HEAD"].includes(request.method || "GET")
        ? ""
        : await readRaw(request);
      const gatewayAuthorization = authorizeGatewayRequest(request, url.pathname, rawBody);
      if ("status" in gatewayAuthorization) {
        sendJson(response, gatewayAuthorization.status, { error: gatewayAuthorization.error });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/integrations/gateway/health") {
        sendJson(response, 200, {
          product: "PitchRadar",
          status: "ok",
          integration: "whatsapp_gateway",
          outboundConnectors: false
        });
        return true;
      }
      const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
      if (
        typeof body.actorId !== "string" ||
        !body.actorId ||
        body.tenantId !== "demo-operator" ||
        typeof body.gatewayMessageId !== "string" ||
        !body.gatewayMessageId
      ) {
        sendJson(response, 403, {
          error: "The gateway actor, tenant, or idempotency identity is invalid."
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/integrations/gateway/chat") {
        const chat = validAgentMessage(body);
        const result = await runGatewayRequestOnce(
          body.gatewayMessageId,
          "chat",
          () => chatWithAgent(chat.message, chat.sessionId)
        );
        sendJson(response, 200, result);
        return true;
      }
      const gatewayActionMatch = url.pathname.match(
        /^\/api\/integrations\/gateway\/actions\/([^/]+)\/decision$/
      );
      if (request.method === "POST" && gatewayActionMatch) {
        const decision = body.decision === "approve"
          ? "approve"
          : body.decision === "deny"
            ? "deny"
            : null;
        if (!decision) {
          sendJson(response, 400, { error: "Decision must be approve or deny." });
          return true;
        }
        const actionId = gatewayActionMatch[1];
        if (!validUuid(actionId)) {
          sendJson(response, 400, { error: "A valid action ID is required." });
          return true;
        }
        const result = await runGatewayRequestOnce(
          body.gatewayMessageId,
          `action:${actionId}:${decision}`,
          async () => {
            const action = await decideAction(actionId, decision);
            if (!action) return null;
            return {
              action,
              note: decision === "approve"
                ? "Approved and held. No connector is enabled, so nothing was sent."
                : "Denied. Nothing was sent."
            };
          }
        );
        if (!result) {
          sendJson(response, 404, { error: "Pending action not found." });
          return true;
        }
        sendJson(response, 200, result);
        return true;
      }
      sendJson(response, 404, { error: "Gateway integration route not found." });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      const mode = authMode();
      if (mode === "disabled") {
        sendJson(response, 200, { authenticated: true, mode, csrfToken: null });
        return true;
      }
      if (mode === "misconfigured") {
        sendJson(response, 503, {
          authenticated: false,
          mode,
          error: "Owner access is required but its password hash or session secret is missing."
        });
        return true;
      }
      const session = readOwnerSession(request);
      if (!session) {
        sendJson(response, 200, { authenticated: false, mode });
        return true;
      }
      sendJson(response, 200, {
        authenticated: true,
        mode,
        csrfToken: session.csrf,
        expiresAt: new Date(session.exp * 1000).toISOString()
      });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      if (!originMatchesRequest(request)) {
        sendJson(response, 403, { error: "Cross-origin login requests are not allowed." });
        return true;
      }
      const mode = authMode();
      if (mode !== "required") {
        sendJson(response, mode === "misconfigured" ? 503 : 409, {
          error: mode === "misconfigured"
            ? "Owner access is required but not completely configured."
            : "Owner authentication is disabled in this local runtime."
        });
        return true;
      }
      const limit = loginRateLimit(request);
      if (!limit.allowed) {
        response.setHeader("Retry-After", String(limit.retryAfterSeconds));
        sendJson(response, 429, {
          error: "Too many owner access attempts. Try again later.",
          retryAfterSeconds: limit.retryAfterSeconds
        });
        return true;
      }
      const body = await readJson(request);
      if (!await verifyOwnerPassword(typeof body.password === "string" ? body.password : "")) {
        recordLoginFailure(request);
        sendJson(response, 401, { error: "Owner password is incorrect." });
        return true;
      }
      clearLoginFailures(request);
      const session = createOwnerSession();
      await insertOwnerSession(session.jti, session.expiresAt);
      setOwnerSessionCookie(response, session.token, session.expiresAt);
      sendJson(response, 200, {
        authenticated: true,
        mode,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt
      });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const authorization = await authorizeApiRequest(request, { mutation: true });
      // A missing, expired, or already-revoked session is not a logout failure:
      // the caller is already signed out, so just clear the cookie.
      if ("status" in authorization && authorization.status !== 401) {
        sendJson(response, authorization.status, { error: authorization.error });
        return true;
      }
      await revokeOwnerSessionForRequest(request);
      clearOwnerSessionCookie(response);
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    if (["GET", "HEAD"].includes(request.method || "GET") && url.pathname === "/api/health") {
      const mode = authMode();
      let database;
      try {
        database = await databaseHealth();
      } catch {
        sendJson(response, 503, {
          product: "PitchRadar",
          status: "unavailable",
          ownerAccess: mode,
          database: { configured: true, reachable: false },
          outboundConnectors: false
        });
        return true;
      }
      const ready = mode !== "misconfigured" &&
        (database.reachable || process.env.NODE_ENV !== "production");
      sendJson(response, ready ? 200 : 503, {
        product: "PitchRadar",
        status: ready ? "ok" : "unavailable",
        ownerAccess: mode,
        database,
        outboundConnectors: false
      });
      return true;
    }
    const authorization = await authorizeApiRequest(request, {
      mutation: !["GET", "HEAD"].includes(request.method || "GET")
    });
    if ("status" in authorization) {
      sendJson(response, authorization.status, { error: authorization.error });
      return true;
    }
    /**
     * THE REPORTS LIBRARY. Behind the same owner authorization as every other
     * product route — the brief names organizers, routes and recorded contact
     * addresses, and is not public material.
     */
    if (request.method === "GET" && url.pathname === "/api/reports") {
      sendJson(response, 200, { reports: await listReportSets() });
      return true;
    }
    const reportFileMatch = url.pathname.match(/^\/api\/reports\/([^/]+)\/([^/]+)$/);
    if (["GET", "HEAD"].includes(request.method || "GET") && reportFileMatch) {
      let week: string;
      let file: string;
      try {
        week = decodeURIComponent(reportFileMatch[1]);
        file = decodeURIComponent(reportFileMatch[2]);
      } catch {
        throw new ApiRequestError("A valid report week and file are required.", 400);
      }
      if (!ISO_WEEK_PATTERN.test(week)) {
        sendJson(response, 400, { error: "A report week looks like 2026-W38." });
        return true;
      }
      const found = await readReportFile(week, file);
      if (!found) {
        sendJson(response, 404, { error: "That report file has not been generated." });
        return true;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", found.contentType);
      response.setHeader("Content-Length", String(found.bytes.length));
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      // The brief is a full HTML document generated by this product; it is
      // served for reading, so it is not forced to download — but it never
      // frames, and the workbook and the PDF are attachments.
      response.setHeader(
        "Content-Disposition",
        found.contentType.startsWith("text/html")
          ? `inline; filename="${found.name}"`
          : `attachment; filename="${found.name}"`
      );
      response.setHeader("X-Frame-Options", "DENY");
      response.end(request.method === "HEAD" ? undefined : found.bytes);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/operations/status") {
      sendJson(response, 200, {
        database: await databaseHealth(),
        latestCycle: await latestOperatingCycle(),
        outboundConnectors: false
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/integrations/n8n/status") {
      const readiness = await checkN8nReadiness();
      sendJson(response, readiness.reachable ? 200 : readiness.configured ? 502 : 503, readiness);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/product/snapshot") {
      const snapshot = await loadProductSnapshot();
      // ADDITIVE. The briefing carries the report's own derivations — the KPI
      // row, the pipeline counts, the deadline radar, the booking lifecycles
      // and the organizer tasks — so the private web prints the same numbers
      // the weekly brief does instead of deriving its own beside them.
      sendJson(response, 200, { ...snapshot, briefing: buildBriefingView(snapshot, new Date()) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/outreach/refresh") {
      sendJson(response, 200, await refreshAvailabilityQueue());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/profile/intake") {
      sendJson(response, 200, await readClientIntake());
      return true;
    }
    const intakeSectionMatch = url.pathname.match(/^\/api\/profile\/intake\/([^/]+)$/);
    if (request.method === "PUT" && intakeSectionMatch) {
      let sectionId: string;
      try {
        sectionId = decodeURIComponent(intakeSectionMatch[1]);
      } catch {
        throw new ApiRequestError("A valid intake section is required.", 400);
      }
      const body = await readJson(request);
      // Both { answers: {...} } and a bare field map are accepted; the section
      // validator rejects anything else.
      const answers = "answers" in body ? body.answers : body;
      sendJson(response, 200, await saveClientIntakeSection(sectionId, answers));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/profile/menu/confirm") {
      const body = await readJson(request);
      sendJson(response, 200, await confirmMenu(body.items));
      return true;
    }
    const selectionMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/selection$/);
    if (request.method === "POST" && selectionMatch) {
      let eventId: string;
      try {
        eventId = decodeURIComponent(selectionMatch[1]);
      } catch {
        throw new ApiRequestError("A valid event ID is required.", 400);
      }
      if (!eventId || eventId.length > 240) {
        sendJson(response, 400, { error: "A valid event ID is required." });
        return true;
      }
      const snapshot = await loadProductSnapshot();
      if (!snapshot.events.some((event) => event.id === eventId)) {
        sendJson(response, 404, { error: "Event not found." });
        return true;
      }
      const body = await readJson(request);
      const selection = body.selection === "shortlist" ? "shortlist" : body.selection === null ? null : undefined;
      if (selection === undefined) {
        sendJson(response, 400, { error: "Selection must be shortlist or null." });
        return true;
      }
      await setOpportunitySelection(eventId, selection);
      sendJson(response, 200, { eventId, selection });
      return true;
    }
    const outreachMatch = url.pathname.match(/^\/api\/outreach\/requests\/([^/]+)\/decision$/);
    if (request.method === "POST" && outreachMatch) {
      if (!validUuid(outreachMatch[1])) {
        sendJson(response, 400, { error: "A valid request ID is required." });
        return true;
      }
      const body = await readJson(request);
      const decision = body.decision === "approve" ? "approve" : body.decision === "cancel" ? "cancel" : null;
      if (!decision) {
        sendJson(response, 400, { error: "Decision must be approve or cancel." });
        return true;
      }
      const requestState = await decideAvailabilityRequest(outreachMatch[1], decision);
      if (!requestState) {
        sendJson(response, 409, {
          error: "This request cannot be changed. Research-only items need a verified route before approval."
        });
        return true;
      }
      sendJson(response, 200, {
        request: requestState,
        note: decision === "approve"
          ? "Approved and held. No connector is enabled, so nothing was sent."
          : "Cancelled. Nothing was sent."
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/state") {
      const sessionId = requireValidSessionId(url.searchParams.get("sessionId") || "owner-default");
      sendJson(response, 200, await getAgentState(sessionId));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/chat") {
      const body = await readJson(request);
      const chat = validAgentMessage(body);
      sendJson(response, 200, await chatWithAgent(chat.message, chat.sessionId));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/chat/stream") {
      const body = await readJson(request);
      const chat = validAgentMessage(body);
      // Server-Sent Events over a POST response. Progress events stream out as
      // the turn runs; the final "done" event carries the exact JSON payload
      // that POST /api/agent/chat returns.
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.setHeader("X-Content-Type-Options", "nosniff");
      // If the client disconnects we stop writing, but the turn still finishes
      // server-side so messages and memory stay consistent.
      let clientGone = false;
      response.on?.("close", () => {
        if (!response.writableEnded) clientGone = true;
      });
      const writeEvent = (event: string, data: unknown) => {
        if (clientGone || response.writableEnded) return;
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      response.flushHeaders?.();
      try {
        const result = await chatWithAgent(chat.message, chat.sessionId, (event: AgentEvent) => {
          if (event.type === "status") writeEvent("status", { text: event.text });
          else if (event.type === "tool") writeEvent("tool", { name: event.name });
          else if (event.type === "tool_result") writeEvent("tool_result", { name: event.name, summary: event.summary });
        });
        writeEvent("done", result);
      } catch (error) {
        console.error("PitchRadar chat stream failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        writeEvent("error", { error: "PitchRadar could not complete this request." });
      }
      if (!clientGone && !response.writableEnded) response.end();
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/memories") {
      sendJson(response, 200, { memories: await listDurableMemories() });
      return true;
    }
    const memoryMatch = url.pathname.match(/^\/api\/agent\/memories\/([^/]+)$/);
    if (request.method === "DELETE" && memoryMatch) {
      if (!validUuid(memoryMatch[1])) {
        sendJson(response, 400, { error: "A valid memory ID is required." });
        return true;
      }
      const removed = await deleteAgentMemory(memoryMatch[1]);
      if (!removed) {
        sendJson(response, 404, { error: "Memory not found." });
        return true;
      }
      sendJson(response, 200, { deleted: memoryMatch[1] });
      return true;
    }
    const actionMatch = url.pathname.match(/^\/api\/agent\/actions\/([^/]+)\/decision$/);
    if (request.method === "POST" && actionMatch) {
      if (!validUuid(actionMatch[1])) {
        sendJson(response, 400, { error: "A valid action ID is required." });
        return true;
      }
      const body = await readJson(request);
      const decision = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : null;
      if (!decision) {
        sendJson(response, 400, { error: "Decision must be approve or deny." });
        return true;
      }
      const action = await decideAction(actionMatch[1], decision);
      if (!action) {
        sendJson(response, 404, { error: "Pending action not found." });
        return true;
      }
      sendJson(response, 200, {
        action,
        note: decision === "approve"
          ? "Approved and held. No connector is enabled, so nothing was sent."
          : "Denied. Nothing was sent."
      });
      return true;
    }
    sendJson(response, 404, { error: "Agent API route not found." });
    return true;
  } catch (error) {
    const status = error instanceof ApiRequestError
      ? error.status
      : error instanceof UnknownIntakeSectionError
        ? 404
        : error instanceof IntakeValidationError
          ? 400
          : error instanceof GatewayRequestConflict
            ? 409
            : 500;
    if (status === 500) {
      console.error("PitchRadar API request failed", {
        method: request.method,
        path: new URL(request.url || "/", "http://localhost").pathname,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    sendJson(
      response,
      status,
      {
        error: status === 500
          ? "PitchRadar could not complete this request."
          : error instanceof Error
            ? error.message
            : String(error)
      }
    );
    return true;
  }
}
