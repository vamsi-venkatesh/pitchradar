import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  databaseConfigured,
  readDatabaseRuntimeState,
  withRuntimeStateLock
} from "./database";
import type { AgentAction, AgentMemory, AgentMessage, RuntimeState, PitchRadarAgentId } from "./types";

const emptyState = (): RuntimeState => ({
  version: 1,
  selections: {},
  pipelineOverrides: {},
  actions: [],
  memories: [],
  messages: []
});

function runtimeDirectory() {
  return process.env.PITCHRADAR_RUNTIME_DIR || path.join(process.cwd(), ".pitchradar-runtime");
}

function statePath() {
  return path.join(runtimeDirectory(), "state.json");
}

let writeQueue = Promise.resolve();

function normalizeState(partial: Partial<RuntimeState>): RuntimeState {
  return {
    ...emptyState(),
    ...partial,
    selections: partial.selections || {},
    pipelineOverrides: partial.pipelineOverrides || {},
    actions: partial.actions || [],
    memories: partial.memories || [],
    messages: partial.messages || []
  };
}

// Kind-aware memory retention. Auto-generated "episode" memories (one per chat
// turn) must never evict explicit "fact"/"decision" memories the owner asked
// to keep.
const EPISODE_MEMORY_CAP = 200;
const DURABLE_MEMORY_CAP = 500;

export function applyMemoryRetention(memories: AgentMemory[]): AgentMemory[] {
  const evicted = new Set<AgentMemory>();

  const episodes = memories.filter((memory) => memory.kind === "episode");
  for (const memory of episodes.slice(0, Math.max(0, episodes.length - EPISODE_MEMORY_CAP))) {
    evicted.add(memory);
  }

  const durable = memories.filter((memory) => memory.kind !== "episode");
  if (durable.length > DURABLE_MEMORY_CAP) {
    // Evict oldest facts only; decisions are never evicted.
    let excess = durable.length - DURABLE_MEMORY_CAP;
    let evictedFacts = 0;
    for (const memory of durable) {
      if (excess === 0) break;
      if (memory.kind === "fact") {
        evicted.add(memory);
        excess -= 1;
        evictedFacts += 1;
      }
    }
    console.warn(
      `PitchRadar memory retention: durable memories exceeded cap (${durable.length} > ${DURABLE_MEMORY_CAP}); evicted ${evictedFacts} oldest fact(s), decisions kept.`
    );
  }

  if (evicted.size === 0) return memories;
  return memories.filter((memory) => !evicted.has(memory));
}

function applyRetention(state: RuntimeState): RuntimeState {
  // Cap message history per session, not globally — one busy session must not
  // evict another session's transcript (concurrent sessions run side by side).
  const perSessionKept = new Set<AgentMessage>();
  const countsBySession = new Map<string, number>();
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    const session = message.sessionId ?? "owner-default";
    const count = countsBySession.get(session) ?? 0;
    if (count < 80) {
      perSessionKept.add(message);
      countsBySession.set(session, count + 1);
    }
  }
  state.messages = state.messages.filter((message) => perSessionKept.has(message)).slice(-400);
  state.memories = applyMemoryRetention(state.memories);
  state.actions = state.actions.slice(-100);
  return state;
}

export async function readRuntimeState(): Promise<RuntimeState> {
  if (databaseConfigured()) {
    const databaseState = await readDatabaseRuntimeState();
    if (databaseState) return normalizeState(databaseState);
  }
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as RuntimeState;
    return normalizeState(parsed);
  } catch {
    return emptyState();
  }
}

export async function updateRuntimeState(
  updater: (state: RuntimeState) => RuntimeState | void
): Promise<RuntimeState> {
  let result = emptyState();
  // The in-process queue serializes callers within this process (cheap
  // belt+braces). When the database is configured, the read-modify-write also
  // runs inside a single transaction holding `select ... for update` on the
  // runtime state row, so a second process cannot interleave and clobber it.
  writeQueue = writeQueue.then(async () => {
    if (databaseConfigured()) {
      result = await withRuntimeStateLock((current) => {
        const state = current ? normalizeState(current) : emptyState();
        return applyRetention(updater(state) || state);
      });
      return;
    }
    const current = await readRuntimeState();
    result = applyRetention(updater(current) || current);
    await mkdir(runtimeDirectory(), { recursive: true });
    const temporary = `${statePath()}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
    await rename(temporary, statePath());
  });
  await writeQueue;
  return result;
}

export async function remember(
  text: string,
  kind: AgentMemory["kind"],
  sessionId: string,
  agentId: PitchRadarAgentId = "command_agent",
  origin: NonNullable<AgentMemory["origin"]> = "agent"
) {
  const memory: AgentMemory = {
    id: crypto.randomUUID(),
    tenantId: "demo-operator",
    appId: "event_ops",
    agentId,
    sessionId,
    kind,
    origin,
    text: text.slice(0, 1600),
    createdAt: new Date().toISOString()
  };
  await updateRuntimeState((state) => {
    state.memories.push(memory);
  });
  return memory;
}

export async function appendMessage(message: AgentMessage) {
  await updateRuntimeState((state) => {
    state.messages.push(message);
  });
}

export async function createAction(
  action: Omit<AgentAction, "id" | "status" | "createdAt">
) {
  const created: AgentAction = {
    ...action,
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  await updateRuntimeState((state) => {
    state.actions.push(created);
  });
  return created;
}

export async function setOpportunitySelection(
  eventId: string,
  selection: "shortlist" | "watch" | "skip" | null
) {
  await updateRuntimeState((state) => {
    if (selection) state.selections[eventId] = selection;
    else delete state.selections[eventId];
  });
  return selection;
}

export async function decideAction(id: string, decision: "approve" | "deny") {
  let updated: AgentAction | undefined;
  await updateRuntimeState((state) => {
    const action = state.actions.find((item) => item.id === id);
    if (!action || action.status !== "pending") return;
    action.status = decision === "approve" ? "approved_waiting_connector" : "denied";
    action.decidedAt = new Date().toISOString();
    updated = action;
  });
  return updated;
}
