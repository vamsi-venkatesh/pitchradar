import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeGatewayRequest,
  resetGatewayNoncesForTests,
  signGatewayRequest
} from "./gateway-auth";

const secret = "pitchradar-gateway-test-secret-that-is-long-enough";
const now = 1_800_000_000_000;

function request(input: {
  method?: string;
  path?: string;
  rawBody?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
}) {
  const method = input.method || "POST";
  const path = input.path || "/api/integrations/gateway/chat";
  const rawBody = input.rawBody || "{}";
  const timestamp = input.timestamp || String(now);
  const nonce = input.nonce || "unique-request-nonce-123";
  const signature = input.signature || signGatewayRequest({
    secret,
    method,
    path,
    timestamp,
    nonce,
    rawBody
  });
  return {
    request: {
      method,
      headers: {
        "x-gateway-timestamp": timestamp,
        "x-gateway-nonce": nonce,
        "x-gateway-signature": signature
      }
    } as unknown as IncomingMessage,
    path,
    rawBody
  };
}

beforeEach(() => {
  vi.stubEnv("PITCHRADAR_GATEWAY_SECRET", secret);
  resetGatewayNoncesForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("messaging gateway request authentication", () => {
  it("accepts an exact signed request once", () => {
    const signed = request({});
    expect(authorizeGatewayRequest(signed.request, signed.path, signed.rawBody, now)).toEqual({
      ok: true
    });
    expect(authorizeGatewayRequest(signed.request, signed.path, signed.rawBody, now)).toMatchObject({
      ok: false,
      status: 403
    });
  });

  it("rejects body, path, and signature tampering", () => {
    const signed = request({});
    expect(authorizeGatewayRequest(signed.request, signed.path, "{\"changed\":true}", now))
      .toMatchObject({ ok: false, status: 401 });
    expect(authorizeGatewayRequest(signed.request, `${signed.path}/other`, signed.rawBody, now))
      .toMatchObject({ ok: false, status: 401 });
  });

  it("rejects stale proofs and fails closed without a configured secret", () => {
    const stale = request({ timestamp: String(now - 301_000) });
    expect(authorizeGatewayRequest(stale.request, stale.path, stale.rawBody, now))
      .toMatchObject({ ok: false, status: 401 });
    vi.stubEnv("PITCHRADAR_GATEWAY_SECRET", "");
    const signed = request({});
    expect(authorizeGatewayRequest(signed.request, signed.path, signed.rawBody, now))
      .toMatchObject({ ok: false, status: 503 });
  });
});
