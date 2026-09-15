/**
 * CROSS-SOURCE DEDUP — the suite for the failure that actually happened.
 *
 * `db/migrations/004_merge_canaletto_duplicate.sql` exists because one real
 * event reached production twice: the seeded canonical row
 * (external_id `canaletto-dresden-2026`) and a discovery row from the
 * Händlerportal source (`discovery:haendler-portal:%`), both in Dresden, both
 * starting on the Berlin calendar day 2026-08-14. The migration had to merge
 * them by hand. This file proves the matcher would now catch that pair, and —
 * just as important — that it does NOT merge things that merely share a city
 * and a date.
 *
 * Everything here is offline and clock-free: `nameMatchConfidence` is pure, and
 * `findMatchingEvent` / `findLinkedEvent` are driven against a fake `pg` client
 * that returns mocked rows and records the SQL it was asked to run. No database
 * is reachable from this process (see `server/database.test.ts`).
 *
 * NOTE ON THE CANALETTO NAMES. Migration 004 identifies the two rows by
 * external_id and by city/date — it never prints their names. The canonical
 * name is read from the shipped catalogue (`src/events.ts`,
 * `canaletto-dresden-2026`); the duplicate's name is the Händlerportal listing
 * form this repo has carried since the incident
 * (`server/normalizer.test.ts`). It is a reconstruction of the pair, stated as
 * one, not a dump of the production rows.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  findLinkedEvent,
  findMatchingEvent,
  nameMatchConfidence,
  type CanonicalCandidate
} from "./normalizer";

const MATCH_THRESHOLD = 0.65;

/** The pair migration 004 had to merge by hand. */
const CANALETTO_CANONICAL = "CANALETTO · Dresden City Festival";
const CANALETTO_DUPLICATE = "CANALETTO – Das Dresdner Stadtfest 2026";

function candidate(overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    name: CANALETTO_DUPLICATE,
    city: "Dresden",
    federalState: "Sachsen",
    startsAt: "2026-08-14T14:00:00.000Z",
    endsAt: "2026-08-16T18:00:00.000Z",
    eventType: "city_festival",
    organizerName: "Agentur Beispiel Händlerportal",
    organizerWebsite: "https://www.example-haendler-portal.de/",
    eventUrl: "https://www.example-haendler-portal.de/portal/events/edit/",
    applicationRoute: "public_form",
    applicationNote: "",
    verification: "partial",
    missingFields: [],
    vendorRelevance: "relevant",
    ...overrides
  };
}

/**
 * A fake `pg` client: it returns the rows the test hands it and records every
 * statement, so a case can assert WHICH key the matcher looked up as well as
 * what it decided.
 */
function fakeClient(rows: Array<Record<string, unknown>>) {
  const issued: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      issued.push({ text, values });
      return { rows, rowCount: rows.length };
    }
  } as unknown as PoolClient;
  return { client, issued };
}

describe("the CANALETTO duplicate (migration 004)", () => {
  it("scores the real pair well above the 0.65 merge threshold", () => {
    const confidence = nameMatchConfidence(CANALETTO_CANONICAL, CANALETTO_DUPLICATE);
    // Measured, not guessed: the rewrites (dresdner→dresden, city→stadt,
    // stadtfest→"stadt fest", festival→fest, the dropped year and the dropped
    // article "das") reduce both names to the same token set.
    expect(confidence).toBe(1);
    expect(confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("merges the pair through findMatchingEvent on the city/date key", async () => {
    const { client, issued } = fakeClient([
      { id: "event-canaletto", canonical_name: CANALETTO_CANONICAL }
    ]);
    const match = await findMatchingEvent(client, candidate());

    expect(match).toMatchObject({ id: "event-canaletto", confidence: 1 });
    // The key is (tenant, lower(city), Berlin calendar start DATE) — the exact
    // key the migration used to find the duplicate by hand.
    expect(issued).toHaveLength(1);
    expect(issued[0].text.toLowerCase()).toContain("lower(city) = lower($2)");
    expect(issued[0].text).toContain("(starts_at at time zone 'Europe/Berlin')::date");
    expect(issued[0].values?.[1]).toBe("Dresden");
    expect(issued[0].values?.[2]).toBe("2026-08-14");
  });
});

/**
 * THE SANKT AUGUSTIN DEDUP MISS — the second real pair, found 2026-09-15.
 *
 * Symptom: pitchradar_dev held the same festival twice, same tenant, same city,
 * same three days — `Street Food Drink & Music Festival Sankt Augustin` and
 * `Streetfood Drink & Music Festival Sankt Augustin` — and both ranked as
 * separate opportunities in the weekly report.
 *
 * Root cause: `matchName` compared TOKENS, and no rule split the German
 * compound. "streetfood" stayed one token against the two tokens "street" and
 * "food", so the Jaccard score was 5/8 = 0.625 — below the 0.65 merge gate.
 *
 * Fix: compound normalization in `matchName`, applied BEFORE tokenizing, and
 * reverse-safe — both spellings are rewritten to the split form.
 */
describe("the Sankt Augustin duplicate (compound normalization)", () => {
  const SPLIT = "Street Food Drink & Music Festival Sankt Augustin";
  const COMPOUND = "Streetfood Drink & Music Festival Sankt Augustin";

  it("scores the real pair at the merge threshold or above", () => {
    const confidence = nameMatchConfidence(SPLIT, COMPOUND);
    // Identical token sets once the compound is split: an exact match, not a
    // near one. Before the fix this was 5/8 = 0.625 and the pair never merged.
    expect(confidence).toBe(1);
    expect(confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("is reverse-safe — the compound and the split form normalize the same way", () => {
    expect(nameMatchConfidence(SPLIT, COMPOUND)).toBe(nameMatchConfidence(COMPOUND, SPLIT));
    expect(nameMatchConfidence("Foodtruck Festival Bonn", "Food Truck Festival Bonn")).toBe(1);
    expect(nameMatchConfidence("Streetfood Markt Köln", "Street Food Markt Köln")).toBe(1);
  });

  it("merges the pair through findMatchingEvent on the city/date key", async () => {
    const { client, issued } = fakeClient([{ id: "event-sankt-augustin", canonical_name: SPLIT }]);
    const match = await findMatchingEvent(
      client,
      candidate({
        name: COMPOUND,
        city: "Sankt Augustin",
        federalState: "Nordrhein-Westfalen",
        startsAt: "2026-09-18T10:00:00.000Z",
        endsAt: "2026-09-20T22:00:00.000Z",
        eventType: "street_food"
      })
    );

    expect(match).toMatchObject({ id: "event-sankt-augustin", confidence: 1 });
    expect(issued[0].values?.[1]).toBe("Sankt Augustin");
    expect(issued[0].values?.[2]).toBe("2026-09-18");
  });

  it("does not make the compound rule merge unrelated street-food events", () => {
    // The rule splits a word; it does not lower the bar. Two different cities
    // still stay apart even though both names carry the compound.
    expect(
      nameMatchConfidence("Streetfood Festival Bonn", "Street Food Festival Hamburg")
    ).toBeLessThan(MATCH_THRESHOLD);
  });
});

describe("German name variants that must merge", () => {
  const merging: Array<[string, string, number]> = [
    // ß / ss: cleanKey folds ß to ss before comparison.
    ["Straßenfest Neukölln", "Strassenfest Neukölln", 1],
    // A trailing year is not a different event.
    ["Stadtfest Dresden 2026", "Stadtfest Dresden", 1],
    // Synonym rewrites: dresdner→dresden, festival→fest, city→stadt.
    ["Dresdner Stadtfest", "Dresden Stadtfest", 1],
    ["Havelfest Rathenow Festival", "Havelfest Rathenow Fest", 1],
    ["Altstadtfest Cottbus 2026", "Altstadtfest Cottbus", 1],
    // Containment, not identity: the shorter name is a prefix of the longer.
    ["Sommerfest am Hafen", "Sommerfest am Hafen Bremen", 0.9],
    // A real tour-name variant from two sources for the same event.
    [
      "Street Food Festival Bergheim",
      "Street Food Drink & Music Festival Bergheim",
      2 / 3
    ]
  ];

  for (const [left, right, expected] of merging) {
    it(`merges "${left}" with "${right}" (${expected.toFixed(4)})`, () => {
      const confidence = nameMatchConfidence(left, right);
      expect(confidence).toBeCloseTo(expected, 10);
      expect(confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    });
  }

  it("is symmetric — the order the two sources arrived in cannot change the verdict", () => {
    for (const [left, right] of merging) {
      expect(nameMatchConfidence(left, right)).toBe(nameMatchConfidence(right, left));
    }
  });
});

describe("negative controls — pairs that must NOT merge", () => {
  it("keeps two different events that share a city and a date apart", async () => {
    // Measured: the two names share no token after normalisation.
    const confidence = nameMatchConfidence("Weihnachtsmarkt Altstadt", "Wintermarkt Hafen");
    expect(confidence).toBe(0);
    expect(confidence).toBeLessThan(MATCH_THRESHOLD);

    // And through the matcher: the city/date query returns the other event, and
    // the confidence gate still refuses it.
    const { client } = fakeClient([
      { id: "event-wintermarkt", canonical_name: "Wintermarkt Hafen" }
    ]);
    await expect(
      findMatchingEvent(client, candidate({ name: "Weihnachtsmarkt Altstadt" }))
    ).resolves.toBeUndefined();
  });

  it("keeps the same name in two different cities apart", async () => {
    // The city is part of the SQL key, so a Leipzig row is never even a
    // candidate for a Dresden occurrence: the query returns nothing.
    const { client, issued } = fakeClient([]);
    await expect(
      findMatchingEvent(client, candidate({ name: "Stadtfest Dresden", city: "Dresden" }))
    ).resolves.toBeUndefined();
    expect(issued[0].values?.[1]).toBe("Dresden");

    // Where the city is carried in the name instead, the name score alone
    // already refuses it.
    const confidence = nameMatchConfidence("Stadtfest Dresden", "Stadtfest Leipzig");
    expect(confidence).toBe(0.5);
    expect(confidence).toBeLessThan(MATCH_THRESHOLD);
  });

  it("keeps the same name on two different dates apart", async () => {
    const { client, issued } = fakeClient([]);
    await expect(
      findMatchingEvent(client, candidate({
        name: CANALETTO_CANONICAL,
        startsAt: "2027-08-13T14:00:00.000Z"
      }))
    ).resolves.toBeUndefined();
    // The date key moved with the occurrence, so the 2026 row is out of scope.
    expect(issued[0].values?.[2]).toBe("2027-08-13");
  });

  it("refuses near-misses that share most of a name but not the event", () => {
    const seasons = nameMatchConfidence("Stadtfest Dresden Sommer", "Stadtfest Dresden Winter");
    expect(seasons).toBeCloseTo(0.6, 10);
    expect(seasons).toBeLessThan(MATCH_THRESHOLD);

    const halle = nameMatchConfidence("Laternenfest Halle", "Lichterfest Halle");
    expect(halle).toBeCloseTo(1 / 3, 10);
    expect(halle).toBeLessThan(MATCH_THRESHOLD);
  });
});

describe("a second source for an event already in the ledger", () => {
  /**
   * The multi-week case. One canonical event spans two ISO weeks; a second
   * source publishes the same event. What must NOT happen is a second canonical
   * row — the week planner would then show the event twice.
   *
   * There are two ways the normalizer avoids that, and both are asserted:
   *   1. the occurrence was linked before → `findLinkedEvent` returns that event
   *      with confidence 1, and `normalizePendingOccurrences` prefers it over
   *      any name match (`previouslyLinked || await findMatchingEvent(...)`);
   *   2. it is a new occurrence from a different source → `findMatchingEvent`
   *      resolves it onto the existing event by city + start date + name.
   */
  const multiWeek = candidate({
    name: "Internationales Straßenfest Cottbus 2026",
    city: "Cottbus",
    startsAt: "2026-09-07T10:00:00.000Z",
    endsAt: "2026-09-13T20:00:00.000Z"
  });

  it("links a second source's occurrence onto the existing event instead of creating one", async () => {
    const { client, issued } = fakeClient([
      { id: "event-cottbus", canonical_name: "Internationales Strassenfest Cottbus" }
    ]);
    const match = await findMatchingEvent(client, multiWeek);

    expect(match).toMatchObject({ id: "event-cottbus" });
    expect(match!.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    // The start DATE is the key, not the span: a multi-week event is one row,
    // looked up by the day it starts.
    expect(issued[0].values?.[2]).toBe("2026-09-07");
  });

  it("gives an already-linked occurrence precedence with confidence 1", async () => {
    const { client, issued } = fakeClient([
      { id: "event-cottbus", canonical_name: "Internationales Strassenfest Cottbus" }
    ]);
    const linked = await findLinkedEvent(client, "raw-occurrence-42");

    // confidence 1 is what makes `normalizePendingOccurrences` record the link
    // as match_method "exact" rather than "rules".
    expect(linked).toMatchObject({ id: "event-cottbus", confidence: 1 });
    expect(issued[0].text).toContain("from event_source_links link");
    expect(issued[0].values?.[0]).toBe("raw-occurrence-42");
  });

  it("returns nothing when the occurrence has never been linked", async () => {
    const { client } = fakeClient([]);
    await expect(findLinkedEvent(client, "raw-occurrence-unseen")).resolves.toBeUndefined();
  });

  it("picks the highest-confidence candidate when a city/date holds several events", async () => {
    const { client } = fakeClient([
      { id: "event-other", canonical_name: "Stadtfest Cottbus Sommer" },
      { id: "event-cottbus", canonical_name: "Internationales Strassenfest Cottbus 2026" }
    ]);
    const match = await findMatchingEvent(client, multiWeek);
    expect(match).toMatchObject({ id: "event-cottbus", confidence: 1 });
  });
});

describe("the 0.65 threshold itself", () => {
  /**
   * Token-set Jaccard only takes discrete values, so a pair that lands exactly
   * on 0.65 has to be constructed: 13 shared tokens, 3 unique to the left and 4
   * to the right gives an intersection of 13 over a union of 20. Neutral tokens
   * are used deliberately — a German word could be rewritten by `matchName` and
   * quietly change the arithmetic being demonstrated.
   */
  const shared = Array.from({ length: 13 }, (_, i) => `tok${String(i).padStart(2, "0")}`);
  const exactlyLeft = [...shared, "leftone", "lefttwo", "leftthree"].join(" ");
  const exactlyRight = [...shared, "rightone", "righttwo", "rightthree", "rightfour"].join(" ");

  const shared16 = Array.from({ length: 16 }, (_, i) => `tok${String(i).padStart(2, "0")}`);
  const belowLeft = [...shared16, "leftone", "lefttwo", "leftthree", "leftfour"].join(" ");
  const belowRight = [
    ...shared16,
    "rightone", "righttwo", "rightthree", "rightfour", "rightfive"
  ].join(" ");

  it("merges at exactly 0.65", () => {
    const confidence = nameMatchConfidence(exactlyLeft, exactlyRight);
    expect(confidence).toBe(13 / 20);
    expect(confidence).toBeCloseTo(0.65, 12);
    expect(confidence >= MATCH_THRESHOLD).toBe(true);
  });

  it("does not merge at 0.64", () => {
    const confidence = nameMatchConfidence(belowLeft, belowRight);
    expect(confidence).toBe(16 / 25);
    expect(confidence).toBeCloseTo(0.64, 12);
    expect(confidence >= MATCH_THRESHOLD).toBe(false);
  });

  it("carries the boundary through findMatchingEvent, not just the score", async () => {
    const atThreshold = fakeClient([{ id: "event-edge", canonical_name: exactlyRight }]);
    await expect(
      findMatchingEvent(atThreshold.client, candidate({ name: exactlyLeft }))
    ).resolves.toMatchObject({ id: "event-edge", confidence: 13 / 20 });

    const below = fakeClient([{ id: "event-edge", canonical_name: belowRight }]);
    await expect(
      findMatchingEvent(below.client, candidate({ name: belowLeft }))
    ).resolves.toBeUndefined();
  });

  it("scores an empty or unusable name as 0 rather than matching everything", () => {
    expect(nameMatchConfidence("", CANALETTO_CANONICAL)).toBe(0);
    expect(nameMatchConfidence("2026", CANALETTO_CANONICAL)).toBe(0);
  });
});
