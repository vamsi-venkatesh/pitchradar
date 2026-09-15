#!/usr/bin/env npx tsx
// GOLDEN RUNNER — executes PitchRadar's deterministic golden suites against the REAL agent code
// and, when an Eval Hub is reachable, pushes run → results → finish under target `pitchradar`.
//
// MODES
//   PUSH    (EVALHUB_URL and EVALHUB_TOKEN both set)
//           POST /api/targets, then per suite: POST /api/runs → POST /api/runs/:id/results
//           (batched, ≤500 per request, every batch printed) → POST /api/runs/:id/finish.
//           Prints the hub's verdict. Exits 1 on ANY regression or ANY failed POST.
//   OFFLINE (either env var missing)
//           Runs the suites, prints per-suite score + every failure, posts nothing.
//           Exits 1 if the pass rate is below 100%: the golden data is green at birth, so red here
//           means the agent changed under it.
//
// ── PITCHRADAR IS A CLIENT PRODUCT: MEASURED, ADVISORY, NOT GATE-BLOCKING ─────────────────────
// This runner posts with `gating: "advisory"`. The hub records that declaration and every page it
// renders says, on its face, that nothing here stops a PitchRadar deploy. The private deploy script
// runs this AFTER its own gates and cannot fail because of it. Turning that into a blocking gate on
// a live client product is an owner decision, not a script's.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────────────────────
// The runner REFUSES to start if PITCHRADAR_DATABASE_URL is set: a suite must never write turns,
// memories or proposals into the client's operating database. It runs against the fixture
// catalogue with PITCHRADAR_RUNTIME_DIR pointed at a fresh throwaway directory, and it clears
// PITCHRADAR_LLM_API_KEY so no case can spend the client's model budget or produce a
// nondeterministic answer. Each of those is enforced here, not documented and hoped for.
//
// ── WHAT THIS SUITE DOES NOT MEASURE ─────────────────────────────────────────────────────────
// 1. The production tool choice made by DeepSeek. These cases exercise the deterministic core, the
//    router, the guards and the catalogue reads. A judged suite over the live model would need a
//    key, a budget and a scorer, and its results would belong under a separate suite name — not
//    folded in here, where they would inflate a deterministic score with model luck.
// 2. The CLIENT'S catalogue. Isolation forces fixture mode, so the `calendar` suite reads the 21
//    typed fixture events, not the ~346 rows production holds. It proves the date arithmetic and
//    the overlap rule; it proves nothing about production coverage. A count here is a count of
//    fixtures, and any reader who takes it for a business number has been misled by us.
//
// Usage: npx tsx scripts/eval/run-golden.mts [--sha <gitSha>] [--suite <name>] [--quiet]
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitSha } from "./deployed-sha.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN_DIR = resolve(ROOT, "eval/golden");
/** Contract v0: results are posted in batches of at most this many. */
export const MAX_BATCH = 500;
/** Max characters of a case's `output` we ship to the hub. Truncation is PRINTED, never silent. */
const MAX_OUTPUT_CHARS = 16000;

// ── isolation, enforced — and the reason it is enforced THIS way ──────────────────────────────
//
// MEASURED FAILURE, 2026-08-08, of this very file's first version. It checked
// `process.env.PITCHRADAR_DATABASE_URL` here and, finding it empty, declared the run isolated.
// It was not: `server/database.ts` opens with `import "dotenv/config"`, and the repo's `.env`
// carries PITCHRADAR_DATABASE_URL=postgresql:///pitchradar_dev. dotenv therefore supplied the
// connection AFTER the guard had already passed, and the first suite runs wrote 20 proposals,
// 65 memories, 52 messages and 3 shortlist decisions straight into the local operating database.
// (They were found and removed; a pre-cleanup dump was taken first.)
//
// A GUARD THAT READS AN ENVIRONMENT VARIABLE BEFORE dotenv HAS SPOKEN IS A VACUOUS GUARD.
// So there are now two steps, and the second one is the one that counts:
//   1. Refuse if the operator has genuinely pointed us at a database, then NEUTRALISE the key by
//      setting it to "" — dotenv never overwrites a key that is already present, so this is what
//      stops `.env` from re-supplying it.
//   2. AFTER the modules are loaded, ASK THE PRODUCT ITSELF (`databaseConfigured()`) whether a
//      database is live, and refuse if it says yes. That check runs against the same function the
//      store uses, so it cannot be true here and false there.
const PRESET_DB = (process.env.PITCHRADAR_DATABASE_URL || "").trim();
if (PRESET_DB) {
  console.error(
    "REFUSING TO RUN: PITCHRADAR_DATABASE_URL is set in the environment.\n" +
      "  This suite writes agent turns, memories and proposals. Against an operating database that\n" +
      "  is contamination, not a measurement. Unset it and re-run."
  );
  process.exit(1);
}
process.env.PITCHRADAR_DATABASE_URL = "";
// A throwaway runtime directory per run, and no model key.
const RUNTIME_DIR = mkdtempSync(join(tmpdir(), "pitchradar-golden-"));
process.env.PITCHRADAR_RUNTIME_DIR = RUNTIME_DIR;
delete process.env.PITCHRADAR_LLM_API_KEY;
delete process.env.BRAVE_SEARCH_API_KEY;
delete process.env.SEARXNG_BASE_URL;

const { databaseConfigured } = await import("../../server/database");
if (databaseConfigured()) {
  console.error(
    "REFUSING TO RUN: the product reports a LIVE database after its modules loaded.\n" +
      "  Something (a .env file, a shell profile) supplied a connection string past the first\n" +
      "  check. Nothing has been written. Remove it and re-run."
  );
  process.exit(1);
}

const { SURFACES, compareExpected } = await import("./surfaces.mts");
type GoldenCase = import("./surfaces.mts").GoldenCase;

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function loadGolden(dir = GOLDEN_DIR): GoldenCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const cases: GoldenCase[] = [];
  for (const f of files) {
    const text = readFileSync(resolve(dir, f), "utf8");
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo++;
      const t = line.trim();
      if (!t || t.startsWith("//")) continue;
      let row: any;
      try { row = JSON.parse(t); } catch (e) { throw new Error(`${f}:${lineNo} is not valid JSON — ${(e as Error).message}`); }
      for (const k of ["id", "surface", "input", "expected"]) {
        if (!(k in row)) throw new Error(`${f}:${lineNo} missing required field "${k}"`);
      }
      if (!SURFACES[row.surface]) throw new Error(`${f}:${lineNo} unknown surface "${row.surface}"`);
      if (!Array.isArray(row.tags)) row.tags = [];
      cases.push(row as GoldenCase);
    }
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id "${c.id}"`);
    seen.add(c.id);
  }
  return cases;
}

interface CaseResult {
  caseId: string; suite: string; pass: boolean; score: number;
  output: any; latencyMs: number; tags: string[]; diffs: string[]; proves?: string;
}

async function runCase(c: GoldenCase): Promise<CaseResult> {
  const fn = SURFACES[c.surface]!;
  const t0 = performance.now();
  let actual: Record<string, any>;
  let diffs: string[];
  let pass: boolean;
  try {
    actual = await fn(c.input);
    const cmp = compareExpected(c.expected, actual);
    pass = cmp.pass; diffs = cmp.diffs;
  } catch (e) {
    actual = { error: String((e as Error)?.message ?? e) };
    pass = false; diffs = [`threw: ${actual.error}`];
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - t0));
  let output: any = actual;
  const json = JSON.stringify(actual);
  if (json.length > MAX_OUTPUT_CHARS) {
    output = { truncated: true, originalChars: json.length, preview: json.slice(0, MAX_OUTPUT_CHARS) };
    console.log(`  NOTE  ${c.id}: output truncated ${json.length} → ${MAX_OUTPUT_CHARS} chars (printed, not silent)`);
  }
  return { caseId: c.id, suite: c.surface, pass, score: pass ? 100 : 0, output, latencyMs, tags: c.tags, diffs, proves: c.proves };
}

// ── hub client ───────────────────────────────────────────────────────────────────────────────
class PostFailure extends Error {}
async function post(url: string, token: string, body: any): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-evalhub-token": token },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new PostFailure(`POST ${url} — network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) throw new PostFailure(`POST ${url} — HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (parsed === null) throw new PostFailure(`POST ${url} — non-JSON response: ${text.slice(0, 200)}`);
  return parsed;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    sha: get("--sha") ?? resolveGitSha(ROOT),
    target: get("--target") ?? process.env.EVALHUB_TARGET ?? "pitchradar",
    suite: get("--suite"),
    quiet: argv.includes("--quiet"),
    dir: get("--dir") ?? GOLDEN_DIR,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const hubUrl = (process.env.EVALHUB_URL || "").replace(/\/+$/, "");
  const token = process.env.EVALHUB_TOKEN || "";
  const push = !!(hubUrl && token);

  const all = loadGolden(args.dir);
  const cases = args.suite ? all.filter((c) => c.surface === args.suite) : all;
  if (!cases.length) { console.error(`no cases loaded${args.suite ? ` for suite "${args.suite}"` : ""}`); return 1; }

  const suites = [...new Set(cases.map((c) => c.surface))].sort();
  console.log(`eval/golden — ${cases.length} cases across ${suites.length} suite(s)  sha=${args.sha}  mode=${push ? `PUSH → ${hubUrl}` : "OFFLINE"}`);
  console.log(`  runtime dir ${RUNTIME_DIR} (throwaway) · database DISABLED · model key CLEARED`);
  if (args.sha === "unknown") {
    console.log("  NOTE  this run cannot name its commit and will be filed under sha=unknown — it is not attributable to code.");
  }

  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c));

  let totalPass = 0;
  const perSuite = new Map<string, CaseResult[]>();
  for (const r of results) {
    if (r.pass) totalPass++;
    const l = perSuite.get(r.suite) ?? []; l.push(r); perSuite.set(r.suite, l);
  }
  console.log("");
  for (const s of suites) {
    const rs = perSuite.get(s)!;
    const p = rs.filter((r) => r.pass).length;
    const score = Math.round((p / rs.length) * 10000) / 100;
    const lat = rs.reduce((a, r) => a + r.latencyMs, 0);
    console.log(`  ${p === rs.length ? "PASS" : "FAIL"}  ${s.padEnd(12)} ${String(p).padStart(4)}/${String(rs.length).padEnd(4)} = ${score.toFixed(2).padStart(6)}%   ${lat}ms total, ${(lat / rs.length).toFixed(2)}ms/case`);
  }
  const failures = results.filter((r) => !r.pass);
  if (failures.length && !args.quiet) {
    console.log(`\n  ${failures.length} FAILING CASE(S):`);
    for (const f of failures) {
      console.log(`    ${f.caseId} [${f.suite}] ${f.tags.join(",")}`);
      if (f.proves) console.log(`        this case exists to prove: ${f.proves}`);
      for (const d of f.diffs) console.log(`        ${d}`);
    }
  }
  const overall = Math.round((totalPass / results.length) * 10000) / 100;
  console.log(`\n  TOTAL ${totalPass}/${results.length} = ${overall.toFixed(2)}%`);

  if (!push) {
    console.log(`\n  offline mode (${!hubUrl ? "EVALHUB_URL" : "EVALHUB_TOKEN"} unset) — nothing posted; the hub owns baselines.`);
    return totalPass === results.length ? 0 : 1;
  }

  let exit = 0;
  try {
    // `gating:"advisory"` is the honest declaration for a client product: the hub records these
    // scores and shows them, and nothing here blocks a PitchRadar release.
    await post(`${hubUrl}/api/targets`, token, { name: args.target, kind: "product", gating: "advisory" });
    for (const s of suites) {
      const rs = perSuite.get(s)!;
      const run = await post(`${hubUrl}/api/runs`, token, { target: args.target, suite: s, gitSha: args.sha });
      const runId = run?.runId;
      if (!runId) throw new PostFailure(`POST ${hubUrl}/api/runs — response carried no runId: ${JSON.stringify(run).slice(0, 200)}`);
      const batches = chunk(rs, MAX_BATCH);
      let received = 0;
      for (const [i, b] of batches.entries()) {
        const body = { results: b.map((r) => ({ caseId: r.caseId, pass: r.pass, score: r.score, output: r.output, latencyMs: r.latencyMs, tags: r.tags })) };
        const ack = await post(`${hubUrl}/api/runs/${runId}/results`, token, body);
        if (ack?.ok !== true) throw new PostFailure(`POST results batch ${i + 1}/${batches.length} — hub did not ack ok:true (${JSON.stringify(ack).slice(0, 200)})`);
        received += Number(ack?.received ?? 0);
        console.log(`  posted ${s} batch ${i + 1}/${batches.length} — ${b.length} results (hub received ${ack?.received})`);
      }
      if (received !== rs.length) console.log(`  NOTE  ${s}: hub acknowledged ${received} of ${rs.length} results`);
      const v = await post(`${hubUrl}/api/runs/${runId}/finish`, token, {});
      const base = v?.baseline ? `${v.baseline.score} (${v.baseline.runId})` : "none";
      console.log(`  VERDICT ${s}: score=${v?.score} ${v?.passed}/${v?.total} baseline=${base} delta=${v?.delta} regression=${v?.regression}`);
      if (Array.isArray(v?.failures) && v.failures.length) console.log(`           hub failures: ${v.failures.join(", ")}`);
      if (v?.regression === true) { console.error(`  REGRESSION on suite "${s}".`); exit = 1; }
    }
  } catch (e) {
    console.error(`\n  HUB PUSH FAILED — ${(e as Error).message}`);
    console.error("  A failed push is a FAILED RUN: nothing was recorded, so nothing may be claimed.");
    return 1;
  }
  return exit;
}

const code = await main().catch((e) => {
  console.error(e);
  return 1;
});
try { rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ }
process.exit(code);
