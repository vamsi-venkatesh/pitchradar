import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authMode,
  authorizeApiRequest,
  createOwnerSession,
  hashOwnerPassword,
  loginRateLimit,
  recordLoginFailure,
  resetLoginRateLimitsForTests,
  revokeOwnerSessionForRequest,
  setOwnerSessionStoreForTests,
  verifyOwnerPassword,
  verifyOwnerSessionToken
} from "./auth";

function request(headers: Record<string, string> = {}) {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.7" }
  } as unknown as IncomingMessage;
}

// Re-signs a token after mutating its payload, using the test session secret.
// Lets tests mint tokens shaped like ones issued before revocation support.
function resignToken(token: string, mutate: (payload: Record<string, unknown>) => void) {
  const [encodedPayload] = token.split(".");
  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8")
  ) as Record<string, unknown>;
  mutate(payload);
  const nextPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.PITCHRADAR_SESSION_SECRET || "")
    .update(nextPayload)
    .digest("base64url");
  return `${nextPayload}.${signature}`;
}

beforeEach(() => {
  vi.stubEnv("PITCHRADAR_AUTH_MODE", "required");
  vi.stubEnv("PITCHRADAR_SESSION_SECRET", "a-test-secret-that-is-definitely-longer-than-32-bytes");
  resetLoginRateLimitsForTests();
});

afterEach(() => {
  setOwnerSessionStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("owner authentication", () => {
  it("hashes and verifies a password without storing the password", async () => {
    const encoded = await hashOwnerPassword("owner-password-very-long", {
      salt: Buffer.alloc(24, 7)
    });
    expect(encoded).not.toContain("owner-password");
    await expect(verifyOwnerPassword("owner-password-very-long", encoded)).resolves.toBe(true);
    await expect(verifyOwnerPassword("wrong-password", encoded)).resolves.toBe(false);
  });

  it("signs expiring owner sessions and rejects tampering", async () => {
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 3) })
    );
    expect(authMode()).toBe("required");
    const session = createOwnerSession(1_800_000_000_000);
    expect(verifyOwnerSessionToken(session.token, 1_800_000_001_000)?.csrf).toBe(session.csrfToken);
    expect(verifyOwnerSessionToken(`${session.token}x`, 1_800_000_001_000)).toBeNull();
    expect(verifyOwnerSessionToken(session.token, new Date(session.expiresAt).getTime() + 1)).toBeNull();
  });

  it("requires a session and CSRF token for owner mutations", async () => {
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 5) })
    );
    const session = createOwnerSession();
    const authenticated = request({
      cookie: `pitchradar_owner=${session.token}`,
      "x-pitchradar-csrf": session.csrfToken
    });
    await expect(authorizeApiRequest(request())).resolves.toMatchObject({ ok: false, status: 401 });
    await expect(authorizeApiRequest(authenticated, { mutation: true })).resolves.toMatchObject({
      ok: true
    });
    await expect(
      authorizeApiRequest(
        request({ cookie: `pitchradar_owner=${session.token}`, "x-pitchradar-csrf": "wrong" }),
        { mutation: true }
      )
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("stays purely stateless when no session database is configured", async () => {
    // Under Vitest the pg adapter is disabled, so the default store reports
    // unconfigured: a valid token authorizes with no session-store lookup.
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 9) })
    );
    const session = createOwnerSession();
    const legacyToken = resignToken(session.token, (payload) => {
      delete payload.jti;
    });
    await expect(
      authorizeApiRequest(request({ cookie: `pitchradar_owner=${session.token}` }))
    ).resolves.toMatchObject({ ok: true });
    // Even a pre-revocation token (no jti) stays valid in stateless mode.
    await expect(
      authorizeApiRequest(request({ cookie: `pitchradar_owner=${legacyToken}` }))
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects tokens without a jti once the session database is configured", async () => {
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 11) })
    );
    const isActive = vi.fn(async () => true);
    setOwnerSessionStoreForTests({
      configured: () => true,
      isActive,
      revoke: async () => {}
    });
    const session = createOwnerSession();
    const legacyToken = resignToken(session.token, (payload) => {
      delete payload.jti;
    });
    await expect(
      authorizeApiRequest(request({ cookie: `pitchradar_owner=${legacyToken}` }))
    ).resolves.toMatchObject({ ok: false, status: 401 });
    expect(isActive).not.toHaveBeenCalled();
    // The same session WITH its jti authorizes through the store lookup.
    await expect(
      authorizeApiRequest(request({ cookie: `pitchradar_owner=${session.token}` }))
    ).resolves.toMatchObject({ ok: true });
    expect(isActive).toHaveBeenCalledWith(session.jti);
  });

  it("rejects a revoked jti once the cache TTL elapses", async () => {
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 13) })
    );
    let active = true;
    const isActive = vi.fn(async () => active);
    // TTL 0 means every request re-checks the store: the "cache expired" case.
    setOwnerSessionStoreForTests({ configured: () => true, isActive, revoke: async () => {} }, 0);
    const session = createOwnerSession();
    const authenticated = request({ cookie: `pitchradar_owner=${session.token}` });
    await expect(authorizeApiRequest(authenticated)).resolves.toMatchObject({ ok: true });
    active = false;
    await expect(authorizeApiRequest(authenticated)).resolves.toMatchObject({
      ok: false,
      status: 401
    });
    expect(isActive).toHaveBeenCalledTimes(2);
  });

  it("caches the store verdict within the TTL and bypasses it on logout revocation", async () => {
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      await hashOwnerPassword("owner-password-very-long", { salt: Buffer.alloc(24, 15) })
    );
    const isActive = vi.fn(async () => true);
    const revoke = vi.fn(async () => {});
    setOwnerSessionStoreForTests({ configured: () => true, isActive, revoke }, 30_000);
    const session = createOwnerSession();
    const authenticated = request({ cookie: `pitchradar_owner=${session.token}` });
    await expect(authorizeApiRequest(authenticated)).resolves.toMatchObject({ ok: true });
    await expect(authorizeApiRequest(authenticated)).resolves.toMatchObject({ ok: true });
    expect(isActive).toHaveBeenCalledTimes(1);
    // Logout revocation overwrites the cached verdict, so the token dies
    // immediately in this process instead of after the 30-second TTL.
    await revokeOwnerSessionForRequest(authenticated);
    expect(revoke).toHaveBeenCalledWith(session.jti);
    await expect(authorizeApiRequest(authenticated)).resolves.toMatchObject({
      ok: false,
      status: 401
    });
    // Revoking again (already revoked) resolves without error.
    await expect(revokeOwnerSessionForRequest(authenticated)).resolves.toBeUndefined();
  });

  it("bounds repeated password attempts without trusting forwarded IP headers", () => {
    const input = request({ "x-forwarded-for": "203.0.113.20" });
    for (let index = 0; index < 5; index += 1) {
      expect(loginRateLimit(input).allowed).toBe(true);
      recordLoginFailure(input);
    }
    expect(loginRateLimit(input)).toMatchObject({ allowed: false });
  });

  it("can isolate login limits by Cloudflare client IP on the private production edge", () => {
    vi.stubEnv("PITCHRADAR_TRUST_CLOUDFLARE_IP", "true");
    const first = request({ "cf-connecting-ip": "203.0.113.20" });
    const second = request({ "cf-connecting-ip": "203.0.113.21" });
    for (let index = 0; index < 5; index += 1) recordLoginFailure(first);
    expect(loginRateLimit(first).allowed).toBe(false);
    expect(loginRateLimit(second).allowed).toBe(true);
  });
});
