import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const usedNonces = new Map<string, number>();

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function gatewaySecret() {
  return process.env.PITCHRADAR_GATEWAY_SECRET?.trim() || "";
}

export function signGatewayRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}) {
  const digest = createHash("sha256").update(input.rawBody).digest("hex");
  return createHmac("sha256", input.secret)
    .update([
      input.method.toUpperCase(),
      input.path,
      input.timestamp,
      input.nonce,
      digest
    ].join("\n"))
    .digest("base64url");
}

export function authorizeGatewayRequest(
  request: IncomingMessage,
  path: string,
  rawBody: string,
  now = Date.now()
): { ok: true } | { ok: false; status: 401 | 403 | 503; error: string } {
  const secret = gatewaySecret();
  if (secret.length < 32) {
    return {
      ok: false,
      status: 503,
      error: "The PitchRadar gateway integration is not configured."
    };
  }
  const timestamp = String(request.headers["x-gateway-timestamp"] || "");
  const nonce = String(request.headers["x-gateway-nonce"] || "");
  const signature = String(request.headers["x-gateway-signature"] || "");
  const numericTimestamp = Number(timestamp);
  if (
    !Number.isFinite(numericTimestamp) ||
    Math.abs(now - numericTimestamp) > MAX_CLOCK_SKEW_MS ||
    nonce.length < 16 ||
    nonce.length > 128 ||
    signature.length < 20
  ) {
    return { ok: false, status: 401, error: "The gateway request proof is invalid or expired." };
  }
  const expected = signGatewayRequest({
    secret,
    method: request.method || "GET",
    path,
    timestamp,
    nonce,
    rawBody
  });
  if (!safeEqual(signature, expected)) {
    return { ok: false, status: 401, error: "The gateway request signature is invalid." };
  }
  for (const [storedNonce, usedAt] of usedNonces) {
    if (now - usedAt > MAX_CLOCK_SKEW_MS) usedNonces.delete(storedNonce);
  }
  if (usedNonces.has(nonce)) {
    return { ok: false, status: 403, error: "The gateway request was already used." };
  }
  usedNonces.set(nonce, now);
  return { ok: true };
}

export function resetGatewayNoncesForTests() {
  usedNonces.clear();
}
