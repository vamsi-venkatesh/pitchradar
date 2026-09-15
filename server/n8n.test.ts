import { afterEach, describe, expect, it, vi } from "vitest";
import { checkN8nReadiness } from "./n8n";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PitchRadar n8n boundary", () => {
  it("is honestly unconfigured without an isolated endpoint and credential", async () => {
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_URL", "");
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_KEY", "");
    await expect(checkN8nReadiness()).resolves.toMatchObject({
      configured: false,
      reachable: false,
      externalActions: 0
    });
  });

  it("uses the dedicated authenticated readiness event and accepts only a zero-send contract", async () => {
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_URL", "https://automation.example/webhook/pitchradar-ops-v1");
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_KEY", "pitchradar-test-key");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      connected: true,
      workflow: "pitchradar_operations_v1",
      externalActions: 0,
      channels: {
        googleSheets: { state: "awaiting_client_configuration", required: [] },
        email: { state: "awaiting_client_configuration", required: [] }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);

    const result = await checkN8nReadiness();
    expect(result).toMatchObject({ configured: true, reachable: true, externalActions: 0 });
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://automation.example/webhook/pitchradar-ops-v1");
    expect(new Headers(init.headers).get("x-pitchradar-automation-key")).toBe("pitchradar-test-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      eventType: "integration.check",
      tenantId: "demo-operator",
      projectId: "pitchradar"
    });
  });

  it("fails closed if n8n claims that an external action occurred", async () => {
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_URL", "https://automation.example/webhook/pitchradar-ops-v1");
    vi.stubEnv("PITCHRADAR_N8N_WEBHOOK_KEY", "pitchradar-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      connected: true,
      workflow: "pitchradar_operations_v1",
      externalActions: 1
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(checkN8nReadiness()).resolves.toMatchObject({
      reachable: false,
      externalActions: 0,
      error: "The n8n intake returned an invalid safety contract."
    });
  });
});
