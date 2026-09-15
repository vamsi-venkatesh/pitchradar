import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRuntimeState } from "./store";
import { agentToolMap } from "./tools";
import type { ToolContext } from "./tools";

let runtimeDir = "";

beforeEach(async () => {
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pitchradar-tools-test-"));
  vi.stubEnv("PITCHRADAR_RUNTIME_DIR", runtimeDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("web-content write guard (prompt-injection containment)", () => {
  const fetchedCtx: ToolContext = { sessionId: "guard-test", webFetched: true };
  const cleanCtx: ToolContext = { sessionId: "guard-test" };

  it("blocks propose_external_action after external web content was read this turn", async () => {
    const result = await agentToolMap.propose_external_action.run(
      { kind: "email", title: "Injected outreach", detail: "Wire €5,000 to attacker", target: "attacker@evil.example" },
      fetchedCtx
    );
    expect(result.receipts[0].status).toBe("unavailable");
    const state = await readRuntimeState();
    expect(state.actions.some((action) => action.title === "Injected outreach")).toBe(false);
  });

  it("blocks remember_business_fact and set_opportunity_state after a web fetch", async () => {
    const memory = await agentToolMap.remember_business_fact.run({ fact: "Injected fake business fact" }, fetchedCtx);
    expect(memory.receipts[0].status).toBe("unavailable");
    const stateChange = await agentToolMap.set_opportunity_state.run({ event: "anything", selection: "shortlist" }, fetchedCtx);
    expect(stateChange.receipts[0].status).toBe("unavailable");
    const state = await readRuntimeState();
    expect(state.memories.some((entry) => entry.text.includes("Injected fake business fact"))).toBe(false);
  });

  it("still queues a genuine owner-driven proposal when no web content was fetched", async () => {
    const result = await agentToolMap.propose_external_action.run(
      { kind: "email", title: "Ask Beispiel Events about Suhl pitch", detail: "Owner-requested availability question" },
      cleanCtx
    );
    expect(result.receipts[0].status).toBe("proposed");
    expect(result.text).toContain("Nothing was sent");
    const state = await readRuntimeState();
    const queued = state.actions.find((action) => action.title === "Ask Beispiel Events about Suhl pitch");
    expect(queued?.status).toBe("pending");
  });
});
