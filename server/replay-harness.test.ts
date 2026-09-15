/**
 * REPLAY HARNESS — the byte-level lock on source extraction.
 *
 * `server/source-adapters.test.ts` documents what each adapter is MEANT to do,
 * case by case. It cannot tell you that an edit quietly changed a field nobody
 * wrote an assertion for — a dropped `routeOwner`, a changed `contentHash`, an
 * extra payload key, an occurrence that silently stopped being emitted.
 *
 * This file closes that gap. For every on-disk capture in `__replays__/` it
 * runs the REAL shipped extractor with a pinned clock and compares the WHOLE
 * result — count, and every field of every occurrence — against a checked-in
 * expected JSON. A future adapter edit that changes extraction output therefore
 * fails here with a field-level diff, and refreshing a capture is an explicit
 * reviewed act (see `__replays__/README.md`).
 *
 * LIMIT, STATED: the bodies are lifted from this repo's 2026-07/08 inline test
 * fixtures, not fetched fresh. They lock the adapters against OUR model of those
 * pages. They say nothing about whether the live pages still match it.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_DIR,
  REPLAYS,
  REPLAY_CLOCK,
  REPLAY_DIR,
  expectedPath,
  readExpected,
  readReplayBody,
  replaySnapshot
} from "./__replays__";

const BODY_EXTENSIONS = [".html", ".json", ".ics"];

describe("source-adapter replay harness", () => {
  it("pins the capture clock so the expected outputs cannot rot", () => {
    expect(REPLAY_CLOCK.toISOString()).toBe("2026-08-01T09:00:00.000Z");
  });

  it("covers every source family exactly once", () => {
    expect(REPLAYS.map((replay) => replay.family).sort()).toEqual([
      "foodtruckmeile",
      "german-list",
      "haendler-portal",
      "ics",
      "json-ld",
      "tour-agentur",
      "tribe-events"
    ]);
    expect(new Set(REPLAYS.map((replay) => replay.name)).size).toBe(REPLAYS.length);
  });

  it("leaves no capture file unmapped and no expected file orphaned", () => {
    const bodies = readdirSync(REPLAY_DIR)
      .filter((file) => BODY_EXTENSIONS.includes(path.extname(file)))
      .sort();
    expect(bodies).toEqual([...REPLAYS.map((replay) => replay.file)].sort());

    const expectedFiles = readdirSync(EXPECTED_DIR).filter((file) => file.endsWith(".json")).sort();
    expect(expectedFiles).toEqual(REPLAYS.map((replay) => `${replay.name}.json`).sort());
  });

  for (const replay of REPLAYS) {
    describe(replay.name, () => {
      it("has a non-empty capture body and a checked-in expected output", () => {
        expect(readReplayBody(replay).length).toBeGreaterThan(0);
        expect(existsSync(expectedPath(replay.name))).toBe(true);
      });

      it("extracts exactly the locked occurrences, field for field", () => {
        const expected = readExpected(replay.name) as { count: number; occurrences: unknown[] };
        const actual = replaySnapshot(replay);

        // Count first: a count diff is the loudest, most readable failure, and
        // reporting it before the deep equality keeps "one event vanished" from
        // being buried inside a giant object diff.
        expect(actual.count).toBe(expected.count);
        expect(actual.occurrences).toHaveLength(expected.count);
        expect(actual).toEqual(expected);
      });

      it("is deterministic — the same body extracts the same output twice", () => {
        expect(replaySnapshot(replay)).toEqual(replaySnapshot(replay));
      });
    });
  }
});
