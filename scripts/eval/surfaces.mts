// GOLDEN SURFACES — the adapters that turn one golden case's `input` into an `actual` object.
//
// Each adapter calls the REAL PitchRadar code path. Nothing here mocks the agent, and nothing here
// re-implements a decision so it can agree with itself: the routing surface calls the shipped
// router, the gating surface calls the shipped tools, the turn surface calls the shipped
// `chatWithAgent`. If a surface could only be satisfied by a copy of the engine, it would prove
// that the copy matches the copy — so no such surface exists in this file.
//
// ── DETERMINISM, AND THE CLOCK ───────────────────────────────────────────────────────────────
// PitchRadar has been bitten once already by tests that pinned nothing and rotted (2026-08-02:
// "test-clock rot eliminated"). These suites are therefore built ONLY on values that do not move
// with the wall clock:
//   • `rankOpportunities` never drops an event — it scores and sorts them — so the SET and the
//     start-date ORDER that `query_calendar` returns are clock-independent. `score` and `tier` are
//     NOT, and no case asserts them.
//   • The turn surface asserts WHICH TOOLS FIRED, never the counts or the prose in the answer.
//   • No case asserts a value derived from "today".
// A case that would need a pinned clock is not written; it is left to the vitest suite, which can
// inject one.
//
// ── ISOLATION ────────────────────────────────────────────────────────────────────────────────
// The runner points PITCHRADAR_RUNTIME_DIR at a throwaway directory and refuses to run with
// PITCHRADAR_DATABASE_URL set (see run-golden.mts). Nothing in a suite run can touch the client's
// operating database or the deployed runtime state.
//
// ── NETWORK ──────────────────────────────────────────────────────────────────────────────────
// Every surface here is OFFLINE. The SSRF cases are the URLs that are rejected BEFORE any DNS
// lookup or socket; the search tool is exercised only in its unconfigured (no-credential) state.
// A case that needs the live web belongs in a nightly runner, not in a deploy-time suite.
import { deadlineStatusLabel, type DeadlineEvidence } from "../../src/application-intelligence";
import { chatWithAgent, resetLlmRateLimitForTests } from "../../server/agent";
import {
  runDeadlineMonitorOn,
  type DeadlineQueryRunner
} from "../../server/deadline-monitor";
import { nameMatchConfidence } from "../../server/normalizer";
import { classifyRetrievalIntents, retrieveAgentContext, routeAgentTurn } from "../../server/retrieval";
import { loadProductSnapshot } from "../../server/catalogue";
import { readRuntimeState } from "../../server/store";
import { agentTools, agentToolMap, type ToolContext } from "../../server/tools";
import { assertPublicUrl } from "../../server/web";

export interface GoldenCase {
  id: string;
  surface: string;
  input: Record<string, any>;
  expected: Record<string, any>;
  tags: string[];
  /** Free prose: what a failure of THIS case would mean. Printed on failure, never scored. */
  proves?: string;
}

const ALL_TOOL_NAMES = agentTools.map((t) => t.name);

// ── surface: routing ─────────────────────────────────────────────────────────────────────────
// "Given operator turn X, the right specialist and the right model tier are chosen." This is the
// deterministic half of tool selection: the Command Agent's classification runs on every turn,
// before any model is called, and it decides which specialist owns the turn and whether the turn
// is worth the reasoning model. It is pure — no DB, no clock, no network.
async function routing(input: Record<string, any>): Promise<Record<string, any>> {
  const turnText = String(input.turn ?? "");
  const intents = classifyRetrievalIntents(turnText);
  const route = routeAgentTurn(turnText, { intents }, ALL_TOOL_NAMES);
  return {
    intents: [...intents].sort().join(","),
    agentId: route.agentId,
    model: route.preferredModel,
    // The product's own law: the specialist label never narrows what the model may reach for.
    // A route that quietly dropped a tool would be a silent capability regression.
    toolsOffered: route.toolNames.length,
  };
}

// ── surface: gating ──────────────────────────────────────────────────────────────────────────
// Proposal-gating and the web-write guard, asserted on the SHIPPED tools and on the DURABLE STATE
// they did or did not write. Checking the receipt alone would pass a tool that returns "blocked"
// and writes anyway, so every case also reads the runtime state back.
async function gating(input: Record<string, any>): Promise<Record<string, any>> {
  const tool = agentToolMap[String(input.tool ?? "")];
  if (!tool) return { error: `unknown tool "${input.tool}"` };
  const sessionId = `golden-${Math.random().toString(36).slice(2, 10)}`;
  const ctx: ToolContext = { sessionId, webFetched: input.webFetched === true };
  const before = await readRuntimeState();
  const out = await tool.run((input.args ?? {}) as Record<string, unknown>, ctx);
  const after = await readRuntimeState();
  const title = String((input.args ?? {}).title ?? "");
  const fact = String((input.args ?? {}).fact ?? "");
  return {
    status: out.receipts[0]?.status ?? "no-receipt",
    // Did a proposal reach the owner approval queue?
    actionQueued: title ? after.actions.some((a) => a.title === title.slice(0, 180)) : false,
    // Did anything durable get written that was not there before?
    factWritten: fact ? after.memories.some((m) => m.text === fact.trim().slice(0, 1000)) : false,
    selectionsChanged: JSON.stringify(after.selections) !== JSON.stringify(before.selections),
    // The absolute product law: a proposal is a proposal. Nothing in this repo can send, so a tool
    // that ever stopped saying so would be the first sign that something can.
    saysNothingSent: /nothing was sent/i.test(out.text),
  };
}

// ── surface: ssrf ────────────────────────────────────────────────────────────────────────────
// The URL-shaped half of injection containment: a page the agent must refuse to fetch AT ALL,
// decided before any name resolution. `reason` is a CLASS, derived from the thrown message, so a
// case cannot pass merely by throwing something.
async function ssrf(input: Record<string, any>): Promise<Record<string, any>> {
  const url = String(input.url ?? "");
  try {
    await assertPublicUrl(url);
    return { blocked: false, reason: "allowed" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const reason =
      /only public http/i.test(msg) ? "scheme"
      : /credentials/i.test(msg) ? "credentials"
      : /local network/i.test(msg) ? "local"
      : /private network/i.test(msg) ? "private"
      : /private or unavailable/i.test(msg) ? "unresolvable"
      : /invalid url/i.test(msg) ? "malformed"
      : "other";
    return { blocked: true, reason };
  }
}

// ── surface: calendar ────────────────────────────────────────────────────────────────────────
// Exact-date / month / range reads over the live catalogue. Asserts the range label, the count and
// the ordered ids — all clock-independent (see the header note). It also re-checks, from the rows
// themselves, that every returned event genuinely overlaps the window: a count that is right for
// the wrong reason still fails.
async function calendar(input: Record<string, any>): Promise<Record<string, any>> {
  const out = await agentToolMap.query_calendar.run(input.args ?? {}, { sessionId: "golden-calendar" });
  const payload = JSON.parse(out.text) as { range: string; count: number; events: any[] };
  const bounds = input.overlaps as { from: string; to: string } | undefined;
  const allOverlap = bounds
    ? payload.events.every((e) => String(e.starts).slice(0, 10) <= bounds.to && String(e.ends).slice(0, 10) >= bounds.from)
    : null;
  return {
    range: payload.range,
    count: payload.count,
    // SORTED ids, not the emitted order: `query_calendar` sorts by start date over a list the
    // ranker has already ordered by score, and score moves with the clock — so events sharing a
    // start date can legitimately swap places tomorrow. The SET is the assertable fact; the
    // ordering property is asserted separately, as a property.
    idsSorted: payload.events.map((e) => e.id).sort().join(","),
    ascendingByStart: payload.events.every((e, i, a) => i === 0 || String(a[i - 1].starts) <= String(e.starts)),
    allOverlap,
  };
}

// ── surface: turn ────────────────────────────────────────────────────────────────────────────
// The end-to-end deterministic turn: an operator sentence in, and the set of tools that ACTUALLY
// RAN out — read from the receipts the product attaches to its own answer, not from a plan it
// printed. With PITCHRADAR_LLM_API_KEY unset (the runner clears it) chatWithAgent takes the
// deterministic core, which is the only tool-selection path that can be measured without paying a
// model and without a nondeterministic answer.
//
// LIMIT, STATED: this measures the deterministic core's selection, NOT the DeepSeek tool choice
// that production takes when a key is present. That is a judged suite and needs a live model; see
// run-golden.mts's header. Nothing here should be read as evidence about the model's choices.
async function turnSurface(input: Record<string, any>): Promise<Record<string, any>> {
  resetLlmRateLimitForTests();
  const sessionId = `golden-turn-${Math.random().toString(36).slice(2, 10)}`;
  const before = await readRuntimeState();
  const res = await chatWithAgent(String(input.turn ?? ""), sessionId);
  const tools = [...new Set((res.message.receipts ?? []).map((r) => r.tool))].sort();
  const after = await readRuntimeState();
  return {
    tools: tools.join(","),
    // Every turn must be attributable: which specialist owned it, recorded as a receipt.
    routedTo: (res.message.receipts ?? []).find((r) => r.tool === "command_agent_route")?.details?.agentId ?? null,
    // A DELTA, not a total: cases share one runtime directory, and a total would make every case
    // depend on the order of the ones before it. This is the number that matters anyway — how many
    // external actions THIS turn queued.
    proposalsCreated: after.actions.length - before.actions.length,
    // Structural, and it must never move: this repo contains no send path at all.
    externalSends: (res.message.receipts ?? []).filter((r) => r.status === "sent" || r.status === "delivered").length,
  };
}

// ── surface: retrieval ───────────────────────────────────────────────────────────────────────
// What the agent is given as background truth before it answers. A wrong retrieval is invisible in
// the reply and fatal in the reasoning, so the suite asserts that the top-ranked document TYPE for
// a turn is the one the question is about, and that the block stays bounded — an unbounded context
// is how a fetched page ends up steering a turn.
async function retrievalSurface(input: Record<string, any>): Promise<Record<string, any>> {
  const snapshot = await loadProductSnapshot();
  // A PRISTINE runtime state, deliberately — NOT the accumulated one.
  //
  // Measured while writing this suite: reading the live state made the retrieval cases depend on
  // which cases ran before them. The `turn` suite writes one episode memory per turn, and an
  // episode literally containing the words of an earlier case ("Owner asked: Send an email about
  // Kranichtage…") then outranked the Kranichtage EVENT record for the query "Kranichtage".
  // That is real product behaviour and worth knowing, but as a golden case it would score the test
  // order rather than the retriever. Retrieval is graded here against a fixed, empty state; the
  // episode-memory ranking question belongs in a product decision, not in a pass/fail bar.
  const state = {
    version: 1, selections: {}, pipelineOverrides: {}, actions: [], memories: [], messages: [],
  } as unknown as Awaited<ReturnType<typeof readRuntimeState>>;
  const r = retrieveAgentContext(String(input.turn ?? ""), snapshot, state);
  return {
    topType: r.documents[0]?.type ?? null,
    intents: [...r.intents].sort().join(","),
    hasContext: r.context.length > 0,
    contextBounded: r.context.length <= 26_000,
  };
}

// ── surface: deadline ────────────────────────────────────────────────────────────────────────
// The two halves of the deadline story, both on the SHIPPED code:
//   • `deadlineStatusLabel` — the one sentence a surface may print about a deadline. Its three
//     honest states ("published", "not found", "none, rolling") must stay three different
//     sentences: conflating the last two is the exact bug migration 012 was written to end.
//   • `runDeadlineMonitorOn` — the alert pass. Its threshold arithmetic decides whether the owner
//     hears about a closing window at all.
//
// THE CLOCK. Unlike every other suite in this file, these cases DO depend on a clock — a countdown
// has no meaning without one. So the clock is not read from the wall: each case SUPPLIES `now`, and
// the surface passes that instant into the shipped function's own `now` parameter. The cases are
// therefore as clock-independent as the rest: 2026-10-05 stays 13 days before 2026-10-18 forever.
//
// The monitor is driven through `DeadlineQueryRunner` — the minimal `pg` surface the product itself
// exports so the pass can run without a socket. The stand-in returns the rows the case names and
// honours the one thing idempotence rests on: the unique key (event_id, threshold_days,
// deadline_at) with `on conflict do nothing`. It re-implements no arithmetic; every count asserted
// is computed by the shipped pass.
function deadlineFakeClient(input: Record<string, any>) {
  const windows = (input.windows ?? []).map((w: any, i: number) => ({
    window_id: `window-${i}`,
    event_id: String(w.eventId ?? `event-${i}`),
    tenant_id: "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5",
    deadline_at: new Date(String(w.deadline)),
  }));
  const alerts = new Set<string>();
  const client: DeadlineQueryRunner = {
    async query(text: string, values?: unknown[]) {
      const sql = text.toLowerCase();
      if (sql.includes("update application_windows")) return { rows: [] as any[], rowCount: 0 };
      if (sql.includes("count(*)::int as due")) {
        return { rows: [{ due: Number(input.dueWindows ?? 0) }] as any[], rowCount: 1 };
      }
      if (sql.includes("from application_windows aw")) {
        return { rows: windows as any[], rowCount: windows.length };
      }
      if (sql.includes("insert into deadline_alerts")) {
        const [, eventId, , threshold, deadline] = values as [string, string, string, number, string];
        const key = `${eventId}|${threshold}|${deadline}`;
        if (alerts.has(key)) return { rows: [] as any[], rowCount: 0 };
        alerts.add(key);
        return { rows: [{ id: `alert-${alerts.size}` }] as any[], rowCount: 1 };
      }
      throw new Error(`the deadline monitor issued an unexpected statement: ${text}`);
    },
  };
  return client;
}

async function deadline(input: Record<string, any>): Promise<Record<string, any>> {
  const now = new Date(String(input.now));
  if (input.mode === "label") {
    return {
      label: deadlineStatusLabel(
        input.evidence as DeadlineEvidence | undefined,
        input.deadline as string | undefined,
        now
      ),
    };
  }
  const client = deadlineFakeClient(input);
  const options = input.thresholds ? { now, thresholds: input.thresholds as number[] } : { now };
  const first = await runDeadlineMonitorOn(client, options);
  // A second pass over the SAME client, when the case asks for one: the alert key is what makes the
  // pass safe to run on every cycle, and "created 0 the second time" is the only proof of it.
  const second = input.secondPass ? await runDeadlineMonitorOn(client, options) : undefined;
  return {
    dueWindows: first.dueWindows,
    alertsCreated: first.alertsCreated,
    alertsByThreshold: first.alertsByThreshold,
    deadlinePassedCount: first.deadlinePassedCount,
    thresholds: first.thresholds,
    secondPassAlertsCreated: second ? second.alertsCreated : null,
  };
}

// ── surface: dedup ───────────────────────────────────────────────────────────────────────────
// `nameMatchConfidence` is half of the cross-source merge key (the other half is city + Berlin
// start date, enforced in SQL). It is the half that got a real event into production twice —
// db/migrations/004_merge_canaletto_duplicate.sql had to merge that pair by hand. Each case states
// the measured score and the verdict the 0.65 gate in `findMatchingEvent` draws from it, so a
// change to either the rewrites or the threshold shows up here as a number, not as a shrug.
async function dedup(input: Record<string, any>): Promise<Record<string, any>> {
  const confidence = nameMatchConfidence(String(input.left ?? ""), String(input.right ?? ""));
  return {
    // Rounded for a stable comparison: the raw value is a Jaccard ratio, and 2/3 must not fail a
    // golden case on its last binary digit.
    confidence: Math.round(confidence * 1e6) / 1e6,
    merges: confidence >= 0.65,
    // The verdict cannot depend on which source arrived first.
    symmetric: nameMatchConfidence(String(input.right ?? ""), String(input.left ?? "")) === confidence,
  };
}

export const SURFACES: Record<string, (input: Record<string, any>) => Promise<Record<string, any>>> = {
  routing,
  gating,
  ssrf,
  calendar,
  turn: turnSurface,
  retrieval: retrievalSurface,
  deadline,
  dedup,
};

/** A case passes when EVERY key in `expected` matches `actual`. Extra keys in `actual` are fine. */
export function compareExpected(
  expected: Record<string, any>,
  actual: Record<string, any>
): { pass: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const [k, want] of Object.entries(expected)) {
    const got = actual[k];
    const same = typeof want === "object" && want !== null
      ? JSON.stringify(want) === JSON.stringify(got)
      : want === got;
    if (!same) diffs.push(`${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return { pass: diffs.length === 0, diffs };
}
