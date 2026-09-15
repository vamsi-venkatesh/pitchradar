/**
 * The deterministic re-merge pass — pair selection only.
 *
 * The SQL half of `scripts/merge-duplicates.ts` is exercised against the real
 * database by running it; what a test can pin without a database is the rule
 * that decides WHICH pairs it touches, and — more importantly — which ones it
 * refuses to touch. The Sankt Augustin pair (the dedup miss this pass exists to
 * repair) and the Leipzig pair (two real markets the token rule scores 0.6667
 * on shared venue words) are both real rows from pitchradar_dev.
 */
import { describe, expect, it } from "vitest";
import { discoverySourceOf, mergePairsFor, windowRichness } from "./merge-duplicates";

function row(overrides: Partial<Parameters<typeof mergePairsFor>[0][number]> & { id: string }) {
  return {
    external_id: `discovery:source-${overrides.id}:hash`,
    canonical_name: "Event",
    city: "Potsdam",
    starts_at: "2026-09-18T10:00:00+02:00",
    ends_at: "2026-09-20T22:00:00+02:00",
    created_at: "2026-07-27T12:00:00+02:00",
    ...overrides
  } as Parameters<typeof mergePairsFor>[0][number];
}

describe("merge-duplicates — pair selection", () => {
  it("merges the Sankt Augustin pair the corrected normalization now matches", () => {
    const { merge, held } = mergePairsFor([
      row({
        id: "a",
        external_id: "discovery:street-food-music:aaa",
        canonical_name: "Street Food Drink & Music Festival Sankt Augustin",
        city: "Sankt Augustin",
        created_at: "2026-07-27T18:59:46+02:00"
      }),
      row({
        id: "b",
        external_id: "discovery:foodtruckbooking-festivals:bbb",
        canonical_name: "Streetfood Drink & Music Festival Sankt Augustin",
        city: "Sankt Augustin",
        created_at: "2026-09-15T10:10:32+02:00"
      })
    ]);

    expect(held).toHaveLength(0);
    expect(merge).toHaveLength(1);
    expect(merge[0].confidence).toBe(1);
    // The NEWER row is merged into the OLDER one, never the other way round.
    expect(merge[0].keeper.id).toBe("a");
    expect(merge[0].duplicate.id).toBe("b");
  });

  it("holds back two different markets one publisher listed at the same venue", () => {
    // Leipzig, 2026-09-27, both from mkt-kunsthandwerk-sachsen. The token rule
    // scores 0.6667 on the shared venue words alone; merging them would delete
    // an opportunity rather than consolidate one.
    const { merge, held } = mergePairsFor([
      row({
        id: "a",
        external_id: "discovery:mkt-kunsthandwerk-sachsen:9f9",
        canonical_name: "Kreativmarkt an der Festwiese / Jahnallee Leipzig",
        city: "Leipzig",
        starts_at: "2026-09-27T10:00:00+02:00",
        ends_at: "2026-09-27T18:00:00+02:00"
      }),
      row({
        id: "b",
        external_id: "discovery:mkt-kunsthandwerk-sachsen:b83",
        canonical_name: "Töpfermarkt an der Festwiese / Jahnallee Leipzig",
        city: "Leipzig",
        starts_at: "2026-09-27T10:00:00+02:00",
        ends_at: "2026-09-27T18:00:00+02:00"
      })
    ]);

    expect(merge).toHaveLength(0);
    expect(held).toHaveLength(1);
    expect(held[0].reason).toContain("mkt-kunsthandwerk-sachsen");
  });

  it("never merges across cities or across non-overlapping dates", () => {
    const differentCity = mergePairsFor([
      row({ id: "a", canonical_name: "Streetfood Festival", city: "Bonn" }),
      row({ id: "b", canonical_name: "Street Food Festival", city: "Hamburg" })
    ]);
    expect(differentCity.merge).toHaveLength(0);

    const apartInTime = mergePairsFor([
      row({ id: "a", canonical_name: "Streetfood Festival Bonn", city: "Bonn" }),
      row({
        id: "b",
        canonical_name: "Street Food Festival Bonn",
        city: "Bonn",
        starts_at: "2026-11-01T10:00:00+01:00",
        ends_at: "2026-11-02T22:00:00+01:00"
      })
    ]);
    expect(apartInTime.merge).toHaveLength(0);
  });

  it("is deterministic — the input order cannot change the merge direction", () => {
    const events = [
      row({
        id: "z",
        external_id: "discovery:one:z",
        canonical_name: "Foodtruck Festival Neuötting",
        city: "Neuötting",
        created_at: "2026-09-15T10:00:00+02:00"
      }),
      row({
        id: "a",
        external_id: "discovery:two:a",
        canonical_name: "Food Truck Festival Neuötting 2026",
        city: "Neuötting",
        created_at: "2026-07-27T10:00:00+02:00"
      })
    ];
    const forward = mergePairsFor(events).merge;
    const backward = mergePairsFor([...events].reverse()).merge;
    expect(forward.map((pair) => [pair.keeper.id, pair.duplicate.id])).toEqual([["a", "z"]]);
    expect(backward.map((pair) => [pair.keeper.id, pair.duplicate.id])).toEqual([["a", "z"]]);
  });

  it("reads the discovery source off the external id and never off the name", () => {
    expect(discoverySourceOf({ external_id: "discovery:haendler-portal:abc" })).toBe("haendler-portal");
    // A seeded row has no discovery prefix; it gets an origin that cannot
    // collide with any source id, so a seed/discovery pair is never held back.
    expect(discoverySourceOf({ external_id: "tag-der-sachsen-plauen-2027" })).toBe(
      "seed:tag-der-sachsen-plauen-2027"
    );
  });
});

describe("merge-duplicates — which application window survives", () => {
  const bare = {
    id: "w",
    event_id: "e",
    route_type: "unknown",
    capacity: "unknown",
    opens_at: null,
    deadline_at: null,
    route_owner: null,
    application_url: null,
    source_url: null,
    route_reachable: null,
    requirements: [],
    deadline_evidence: "not_found"
  };

  it("prefers the window that actually carries a deadline and a route", () => {
    expect(windowRichness(bare)).toBe(0);
    expect(
      windowRichness({
        ...bare,
        deadline_at: "2026-08-01T00:00:00+02:00",
        deadline_evidence: "published",
        application_url: "https://example.org/apply"
      })
    ).toBe(7);
  });

  it("scores a rolling window above an empty one — 'no deadline exists' is a finding", () => {
    expect(windowRichness({ ...bare, deadline_evidence: "none_rolling" })).toBeGreaterThan(
      windowRichness(bare)
    );
  });
});
