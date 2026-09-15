/**
 * REPLAY LOADER — the on-disk captured-page fixtures and the extractor each one
 * is fed to.
 *
 * Every entry names a source family, a body file and the REAL shipped extractor
 * that PitchRadar runs against that family in production. Nothing here parses,
 * normalises or reshapes a body: the loader only reads bytes off disk and hands
 * them to the adapter, so a harness assertion is an assertion about the adapter.
 *
 * The clock is pinned. Several extractors drop events that have already ended,
 * so an unpinned clock would silently shrink the expected output as time passes
 * — the exact rot this repo has been bitten by before.
 *
 * Provenance of the bodies: see README.md in this directory. They are NOT fresh
 * crawls.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFoodtruckmeileEvents,
  extractGermanListEvents,
  extractHaendlerPortalEvents,
  extractIcsEvents,
  extractJsonLdEvents,
  extractTourAgenturEvents
} from "../source-adapters";
import { extractTribeEvents, type ExtractedOccurrence } from "../source-probe";

export const REPLAY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXPECTED_DIR = path.join(REPLAY_DIR, "expected");

/**
 * The pinned capture clock. 2026-08-01T09:00:00Z is the same instant the
 * original adapter tests pin, so the replay bodies and the inline fixtures they
 * came from are graded against identical "has this event ended?" arithmetic.
 */
export const REPLAY_CLOCK = new Date("2026-08-01T09:00:00.000Z");

export interface Replay {
  /** Stable name; also the expected-output filename. */
  name: string;
  /** Source family this body represents. */
  family: string;
  /** Body file, relative to this directory. */
  file: string;
  /** The shipped extractor, wired exactly as production wires it. */
  extract: (body: string) => ExtractedOccurrence[];
}

export const REPLAYS: Replay[] = [
  {
    name: "foodtruckmeile",
    family: "foodtruckmeile",
    file: "foodtruckmeile.html",
    extract: (body) => extractFoodtruckmeileEvents(body)
  },
  {
    name: "tour-agentur",
    family: "tour-agentur",
    file: "tour-agentur.json",
    extract: (body) => extractTourAgenturEvents(body)
  },
  {
    name: "haendler-portal",
    family: "haendler-portal",
    file: "haendler-portal.html",
    extract: (body) => extractHaendlerPortalEvents(body)
  },
  {
    name: "json-ld",
    family: "json-ld",
    file: "json-ld.html",
    extract: (body) => extractJsonLdEvents(body, { now: REPLAY_CLOCK })
  },
  {
    name: "ics",
    family: "ics",
    file: "street-food-market.ics",
    extract: (body) => extractIcsEvents(body, { now: REPLAY_CLOCK })
  },
  {
    name: "german-list",
    family: "german-list",
    file: "german-list.html",
    extract: (body) => extractGermanListEvents(body, {
      now: REPLAY_CLOCK,
      keyPrefix: "brandenburg-events",
      sourceUrl: "https://efre.brandenburg.de/"
    })
  },
  {
    name: "tribe-events",
    family: "tribe-events",
    file: "tribe-events.json",
    extract: (body) => extractTribeEvents(body)
  }
];

/** Reads a replay body verbatim — no trimming, no newline normalisation. */
export function readReplayBody(replay: Replay): string {
  return readFileSync(path.join(REPLAY_DIR, replay.file), "utf8");
}

export function expectedPath(name: string): string {
  return path.join(EXPECTED_DIR, `${name}.json`);
}

export function readExpected(name: string): unknown {
  return JSON.parse(readFileSync(expectedPath(name), "utf8"));
}

/**
 * The exact shape that is checked in as `expected/<name>.json`. Serialising
 * through JSON is deliberate: an `undefined` field and an absent field must not
 * be allowed to differ from each other in one direction only.
 */
export function replaySnapshot(replay: Replay): {
  replay: string;
  family: string;
  file: string;
  count: number;
  occurrences: unknown[];
} {
  const occurrences = replay.extract(readReplayBody(replay));
  return JSON.parse(JSON.stringify({
    replay: replay.name,
    family: replay.family,
    file: replay.file,
    count: occurrences.length,
    occurrences
  }));
}
