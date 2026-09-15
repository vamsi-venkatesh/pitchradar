import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMemoryRetention, readRuntimeState, updateRuntimeState } from "./store";
import type { AgentMemory } from "./types";

function makeMemory(kind: AgentMemory["kind"], index: number): AgentMemory {
  return {
    id: `${kind}-${index}`,
    tenantId: "demo-operator",
    appId: "event_ops",
    agentId: "command_agent",
    sessionId: "session-retention",
    kind,
    text: `${kind} ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  };
}

let runtimeDir: string;
let previousRuntimeDir: string | undefined;

beforeEach(async () => {
  previousRuntimeDir = process.env.PITCHRADAR_RUNTIME_DIR;
  runtimeDir = await mkdtemp(path.join(os.tmpdir(), "pitchradar-store-test-"));
  process.env.PITCHRADAR_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  if (previousRuntimeDir === undefined) delete process.env.PITCHRADAR_RUNTIME_DIR;
  else process.env.PITCHRADAR_RUNTIME_DIR = previousRuntimeDir;
  await rm(runtimeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("kind-aware memory retention", () => {
  it("keeps every fact when 400 episodes pile up, and caps episodes at 200", async () => {
    const facts = Array.from({ length: 10 }, (_, i) => makeMemory("fact", i));
    const episodes = Array.from({ length: 400 }, (_, i) => makeMemory("episode", i));

    await updateRuntimeState((state) => {
      // Interleave: facts recorded early, then a long tail of episodes — the
      // exact shape that used to evict the facts under the flat slice(-300).
      state.memories.push(...facts, ...episodes);
    });

    const state = await readRuntimeState();
    const keptFacts = state.memories.filter((m) => m.kind === "fact");
    const keptEpisodes = state.memories.filter((m) => m.kind === "episode");

    expect(keptFacts.map((m) => m.id)).toEqual(facts.map((m) => m.id));
    expect(keptEpisodes).toHaveLength(200);
    // Oldest episodes evicted first: the survivors are the most recent 200.
    expect(keptEpisodes[0].id).toBe("episode-200");
    expect(keptEpisodes[199].id).toBe("episode-399");
  });

  it("evicts oldest facts, never decisions, when durable memories exceed 500, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const facts = Array.from({ length: 490 }, (_, i) => makeMemory("fact", i));
    const decisions = Array.from({ length: 20 }, (_, i) => makeMemory("decision", i));

    const kept = applyMemoryRetention([...facts, ...decisions]);

    const keptFacts = kept.filter((m) => m.kind === "fact");
    const keptDecisions = kept.filter((m) => m.kind === "decision");
    expect(kept).toHaveLength(500);
    expect(keptDecisions).toHaveLength(20);
    expect(keptFacts).toHaveLength(480);
    // The 10 oldest facts were evicted.
    expect(keptFacts[0].id).toBe("fact-10");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("leaves memories under the caps untouched", () => {
    const memories = [
      ...Array.from({ length: 50 }, (_, i) => makeMemory("episode", i)),
      ...Array.from({ length: 5 }, (_, i) => makeMemory("fact", i)),
      makeMemory("decision", 0)
    ];
    expect(applyMemoryRetention(memories)).toBe(memories);
  });
});

describe("messages and actions caps", () => {
  it("still caps messages at 80 and actions at 100", async () => {
    await updateRuntimeState((state) => {
      for (let i = 0; i < 120; i++) {
        state.messages.push({
          id: `message-${i}`,
          role: "user",
          text: `m${i}`,
          createdAt: new Date().toISOString()
        } as never);
        state.actions.push({
          id: `action-${i}`,
          status: "pending",
          createdAt: new Date().toISOString()
        } as never);
      }
    });
    const state = await readRuntimeState();
    expect(state.messages).toHaveLength(80);
    expect(state.actions).toHaveLength(100);
    expect(state.messages[0].id).toBe("message-40");
    expect(state.actions[0].id).toBe("action-20");
  });
});
