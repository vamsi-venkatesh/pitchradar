/**
 * THE REPORTS ROUTES.
 *
 * `/api/reports` lists what the generator wrote and `/api/reports/:week/:file`
 * hands one of those files back. Both sit behind the same owner authorization
 * as every other product route — the brief names organizers, routes and
 * recorded contact addresses.
 *
 * The file route answers with BYTES, not JSON, so this suite uses its own
 * invoker: the shared one in http.test.ts concatenates strings.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentApi } from "./http";

let root = "";

async function invoke(input: { method: string; url: string; headers?: Record<string, string> }) {
  const request = Readable.from([]) as unknown as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = input.headers || {};
  Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });

  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 200,
    writableEnded: false,
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), String(value));
    },
    flushHeaders() {},
    on() {},
    write(value: string | Buffer) {
      chunks.push(Buffer.from(value));
      return true;
    },
    end(value?: string | Buffer) {
      if (value !== undefined) chunks.push(Buffer.from(value));
      (this as { writableEnded: boolean }).writableEnded = true;
    }
  } as unknown as ServerResponse;

  const handled = await handleAgentApi(request, response);
  const bytes = Buffer.concat(chunks);
  let body: Record<string, unknown> = {};
  try {
    body = bytes.length ? (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    // A served artifact is not JSON; the test reads `bytes` instead.
  }
  return { handled, status: response.statusCode, headers, body, bytes };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pitchradar-report-routes-"));
  await mkdir(path.join(root, "2026-W38"), { recursive: true });
  await writeFile(path.join(root, "2026-W38/pitchradar-brief-2026-W38.html"), "<!doctype html><p>brief</p>");
  await writeFile(path.join(root, "2026-W38/pitchradar-brief-2026-W38.pdf"), Buffer.from("%PDF-1.4 fixture"));
  await writeFile(
    path.join(root, "2026-W38/manifest.json"),
    JSON.stringify({
      isoWeek: "2026-W38",
      generatedAt: "2026-09-15T19:00:00.000Z",
      now: "2026-09-15T19:00:00.000Z",
      mode: "database",
      snapshotCounts: { events: 42, sources: 45 },
      gitSha: "2cf34a01e514"
    })
  );
  vi.stubEnv("PITCHRADAR_REPORTS_DIR", root);
  vi.stubEnv("PITCHRADAR_AUTH_MODE", "disabled");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("GET /api/reports", () => {
  it("lists the generated sets with their files and their manifest", async () => {
    const result = await invoke({ method: "GET", url: "/api/reports" });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    const reports = result.body.reports as Array<Record<string, unknown>>;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      isoWeek: "2026-W38",
      manifest: { mode: "database", gitSha: "2cf34a01e514", snapshotCounts: { events: 42, sources: 45 } }
    });
    const kinds = (reports[0].files as Array<{ kind: string }>).map((file) => file.kind);
    // The register was never written for this week: it is absent, not faked.
    expect(kinds.sort()).toEqual(["brief", "manifest", "pdf"]);
  });
});

describe("GET /api/reports/:week/:file", () => {
  it("serves the brief as HTML and the PDF as an attachment", async () => {
    const brief = await invoke({
      method: "GET",
      url: "/api/reports/2026-W38/pitchradar-brief-2026-W38.html"
    });
    expect(brief.status).toBe(200);
    expect(brief.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(brief.headers.get("content-disposition")).toContain("inline");
    expect(brief.headers.get("x-content-type-options")).toBe("nosniff");
    expect(brief.bytes.toString()).toContain("brief");

    const pdf = await invoke({
      method: "GET",
      url: "/api/reports/2026-W38/pitchradar-brief-2026-W38.pdf"
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("attachment");
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects traversal, absolute paths and names the generator never writes", async () => {
    const outside = path.join(root, "secret.txt");
    await writeFile(outside, "not a report");
    const attempts = [
      "/api/reports/2026-W38/..%2Fsecret.txt",
      "/api/reports/2026-W38/..%2F..%2Fetc%2Fpasswd",
      "/api/reports/2026-W38/%2Fetc%2Fpasswd",
      "/api/reports/..%2F/manifest.json",
      "/api/reports/2026-W38/secret.txt",
      "/api/reports/2026-W38/pitchradar-brief-2026-W31.html",
      "/api/reports/sample/manifest.json",
      "/api/reports/2026-W38%2F..%2Fsample/manifest.json"
    ];
    for (const url of attempts) {
      const result = await invoke({ method: "GET", url });
      expect([400, 404], `${url} must not be served`).toContain(result.status);
      expect(result.bytes.toString()).not.toContain("not a report");
    }
  });

  it("refuses a file that was never generated", async () => {
    const result = await invoke({
      method: "GET",
      url: "/api/reports/2026-W38/pitchradar-register-2026-W38.xlsx"
    });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("That report file has not been generated.");
  });
});

describe("the reports routes under owner authentication", () => {
  it("answers 401 to an unauthenticated listing and an unauthenticated file", async () => {
    vi.stubEnv("PITCHRADAR_AUTH_MODE", "required");
    vi.stubEnv("PITCHRADAR_SESSION_SECRET", "a-test-secret-that-is-definitely-longer-than-32-bytes");
    vi.stubEnv(
      "PITCHRADAR_OWNER_PASSWORD_HASH",
      "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );

    const listing = await invoke({ method: "GET", url: "/api/reports" });
    expect(listing.status).toBe(401);
    const file = await invoke({
      method: "GET",
      url: "/api/reports/2026-W38/pitchradar-brief-2026-W38.html"
    });
    expect(file.status).toBe(401);
    expect(file.bytes.toString()).not.toContain("brief</p>");
  });
});
