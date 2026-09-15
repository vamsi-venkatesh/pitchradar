import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { databaseConfigured, ownerSessionActive, revokeOwnerSession } from "./database";

const COOKIE_NAME = "pitchradar_owner";
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const SESSION_CHECK_TTL_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OwnerSessionPayload {
  sub: "owner";
  iat: number;
  exp: number;
  csrf: string;
  /** Server-side session row id. Absent only on tokens minted before revocation support. */
  jti?: string;
}

/**
 * Server-side revocation store seam. Production uses the owner_sessions table
 * through database.ts; tests inject a fake store (the pg adapter is disabled
 * under Vitest) and may shorten the cache TTL.
 */
export interface OwnerSessionStore {
  configured(): boolean;
  isActive(jti: string): Promise<boolean>;
  revoke(jti: string): Promise<unknown>;
}

const defaultSessionStore: OwnerSessionStore = {
  configured: databaseConfigured,
  isActive: ownerSessionActive,
  revoke: revokeOwnerSession
};

let sessionStore: OwnerSessionStore = defaultSessionStore;
let sessionCheckTtlMs = SESSION_CHECK_TTL_MS;
// jti -> last database verdict, reused for sessionCheckTtlMs so every request
// does not pay a database round trip. A revoked session dies within the TTL.
const sessionCheckCache = new Map<string, { active: boolean; checkedAt: number }>();

export function setOwnerSessionStoreForTests(
  store: OwnerSessionStore | null,
  cacheTtlMs = SESSION_CHECK_TTL_MS
) {
  sessionStore = store ?? defaultSessionStore;
  sessionCheckTtlMs = store ? cacheTtlMs : SESSION_CHECK_TTL_MS;
  sessionCheckCache.clear();
}

interface LoginWindow {
  attempts: number[];
  blockedUntil?: number;
}

export type AuthMode = "disabled" | "required" | "misconfigured";

const loginWindows = new Map<string, LoginWindow>();

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number }
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function encode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(left: string | Buffer, right: string | Buffer) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionSecret() {
  return process.env.PITCHRADAR_SESSION_SECRET?.trim() || "";
}

function ownerPasswordHash() {
  return process.env.PITCHRADAR_OWNER_PASSWORD_HASH?.trim() || "";
}

export function authMode(): AuthMode {
  const configured = (process.env.PITCHRADAR_AUTH_MODE || "disabled").trim().toLowerCase();
  if (configured === "disabled") return "disabled";
  if (configured !== "required") return "misconfigured";
  if (sessionSecret().length < 32 || !ownerPasswordHash()) return "misconfigured";
  return "required";
}

function signPayload(encodedPayload: string) {
  return createHmac("sha256", sessionSecret()).update(encodedPayload).digest("base64url");
}

function parseCookies(request: IncomingMessage) {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export function createOwnerSession(now = Date.now()): {
  token: string;
  csrfToken: string;
  expiresAt: string;
  jti: string;
} {
  if (authMode() !== "required") throw new Error("PitchRadar owner authentication is not configured.");
  const issuedAt = Math.floor(now / 1000);
  const configuredSeconds = Number(
    process.env.PITCHRADAR_SESSION_TTL_SECONDS || DEFAULT_SESSION_SECONDS
  );
  const seconds = Number.isFinite(configuredSeconds)
    ? Math.max(900, Math.min(configuredSeconds, 7 * 24 * 60 * 60))
    : DEFAULT_SESSION_SECONDS;
  const payload: OwnerSessionPayload = {
    sub: "owner",
    iat: issuedAt,
    exp: issuedAt + seconds,
    csrf: randomBytes(24).toString("base64url"),
    jti: randomUUID()
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return {
    token: `${encodedPayload}.${signPayload(encodedPayload)}`,
    csrfToken: payload.csrf,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    jti: payload.jti as string
  };
}

export function verifyOwnerSessionToken(token: string, now = Date.now()): OwnerSessionPayload | null {
  if (authMode() !== "required") return null;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) return null;
  if (!safeEqual(signature, signPayload(encodedPayload))) return null;
  try {
    const payload = JSON.parse(decode(encodedPayload)) as OwnerSessionPayload;
    if (
      payload.sub !== "owner" ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      typeof payload.csrf !== "string" ||
      payload.csrf.length < 20 ||
      (payload.jti !== undefined &&
        (typeof payload.jti !== "string" || !UUID_PATTERN.test(payload.jti))) ||
      payload.iat > Math.floor(now / 1000) + 60 ||
      payload.exp <= Math.floor(now / 1000)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readOwnerSession(request: IncomingMessage) {
  const token = parseCookies(request).get(COOKIE_NAME);
  return token ? verifyOwnerSessionToken(token) : null;
}

export async function hashOwnerPassword(
  password: string,
  options: { N?: number; r?: number; p?: number; salt?: Buffer } = {}
) {
  if (password.length < 12) throw new Error("Owner password must contain at least 12 characters.");
  const N = options.N || 16_384;
  const r = options.r || 8;
  const p = options.p || 1;
  const salt = options.salt || randomBytes(24);
  const derived = await deriveKey(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyOwnerPassword(password: string, encodedHash = ownerPasswordHash()) {
  const [scheme, rawN, rawR, rawP, rawSalt, rawHash, extra] = encodedHash.split("$");
  if (scheme !== "scrypt" || !rawN || !rawR || !rawP || !rawSalt || !rawHash || extra) return false;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (
    !Number.isInteger(N) || N < 16_384 || N > 262_144 ||
    !Number.isInteger(r) || r < 8 || r > 32 ||
    !Number.isInteger(p) || p < 1 || p > 4
  ) return false;
  try {
    const salt = Buffer.from(rawSalt, "base64url");
    const expected = Buffer.from(rawHash, "base64url");
    if (salt.length < 16 || expected.length !== 32) return false;
    const actual = await deriveKey(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(64 * 1024 * 1024, 128 * N * r + 1024 * 1024)
    });
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

function clientKey(request: IncomingMessage) {
  if (process.env.PITCHRADAR_TRUST_CLOUDFLARE_IP === "true") {
    const cloudflareIp = request.headers["cf-connecting-ip"];
    if (typeof cloudflareIp === "string" && net.isIP(cloudflareIp)) {
      return cloudflareIp;
    }
  }
  return request.socket.remoteAddress || "unknown";
}

export function loginRateLimit(request: IncomingMessage, now = Date.now()) {
  const key = clientKey(request);
  const current = loginWindows.get(key) || { attempts: [] };
  current.attempts = current.attempts.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
  if (current.blockedUntil && current.blockedUntil > now) {
    loginWindows.set(key, current);
    return { allowed: false, retryAfterSeconds: Math.ceil((current.blockedUntil - now) / 1000) };
  }
  if (current.attempts.length >= LOGIN_ATTEMPT_LIMIT) {
    current.blockedUntil = now + LOGIN_WINDOW_MS;
    loginWindows.set(key, current);
    return { allowed: false, retryAfterSeconds: Math.ceil(LOGIN_WINDOW_MS / 1000) };
  }
  loginWindows.set(key, current);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(request: IncomingMessage, now = Date.now()) {
  const key = clientKey(request);
  const current = loginWindows.get(key) || { attempts: [] };
  current.attempts = current.attempts.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
  current.attempts.push(now);
  if (current.attempts.length >= LOGIN_ATTEMPT_LIMIT) current.blockedUntil = now + LOGIN_WINDOW_MS;
  loginWindows.set(key, current);
}

export function clearLoginFailures(request: IncomingMessage) {
  loginWindows.delete(clientKey(request));
}

export function originMatchesRequest(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function setOwnerSessionCookie(response: ServerResponse, token: string, expiresAt: string) {
  const secure = process.env.PITCHRADAR_COOKIE_SECURE === "true" ? "; Secure" : "";
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`
  );
}

export function clearOwnerSessionCookie(response: ServerResponse) {
  const secure = process.env.PITCHRADAR_COOKIE_SECURE === "true" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
}

async function ownerSessionRevoked(jti: string, now = Date.now()) {
  const cached = sessionCheckCache.get(jti);
  if (cached && now - cached.checkedAt < sessionCheckTtlMs) return !cached.active;
  const active = await sessionStore.isActive(jti);
  sessionCheckCache.set(jti, { active, checkedAt: now });
  return !active;
}

export async function authorizeApiRequest(
  request: IncomingMessage,
  options: { mutation?: boolean } = {}
): Promise<{ ok: true; csrfToken?: string; expiresAt?: string } | {
  ok: false;
  status: 401 | 403 | 503;
  error: string;
}> {
  const mode = authMode();
  if (mode === "disabled") return { ok: true };
  if (mode === "misconfigured") {
    return {
      ok: false,
      status: 503,
      error: "PitchRadar owner authentication is required but not completely configured."
    };
  }
  const session = readOwnerSession(request);
  if (!session) return { ok: false, status: 401, error: "Owner authentication required." };
  if (sessionStore.configured()) {
    // Tokens minted before revocation support carry no jti: they cannot be
    // revoked, so they are rejected outright once the database is in play.
    if (!session.jti) {
      return { ok: false, status: 401, error: "Owner session is no longer valid. Sign in again." };
    }
    let revoked: boolean;
    try {
      revoked = await ownerSessionRevoked(session.jti);
    } catch {
      return {
        ok: false,
        status: 503,
        error: "Owner session could not be verified. Try again shortly."
      };
    }
    if (revoked) {
      return { ok: false, status: 401, error: "Owner session is no longer valid. Sign in again." };
    }
  }
  if (options.mutation) {
    const supplied = request.headers["x-pitchradar-csrf"];
    if (typeof supplied !== "string" || !safeEqual(supplied, session.csrf)) {
      return { ok: false, status: 403, error: "Owner action token is missing or invalid." };
    }
  }
  return {
    ok: true,
    csrfToken: session.csrf,
    expiresAt: new Date(session.exp * 1000).toISOString()
  };
}

/**
 * Marks the request's server-side session row revoked. Safe to call for
 * already-revoked, expired, or jti-less sessions, and when no database is
 * configured — logout must never fail because the session was already dead.
 */
export async function revokeOwnerSessionForRequest(request: IncomingMessage) {
  const session = readOwnerSession(request);
  if (!session?.jti || !sessionStore.configured()) return;
  try {
    await sessionStore.revoke(session.jti);
    // Kill the cached verdict so this process rejects the session immediately.
    sessionCheckCache.set(session.jti, { active: false, checkedAt: Date.now() });
  } catch {
    // The row stays revocable on the next attempt; logout still clears the cookie.
  }
}

export function resetLoginRateLimitsForTests() {
  loginWindows.clear();
}
