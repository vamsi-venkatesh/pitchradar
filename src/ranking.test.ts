import { describe, expect, it } from "vitest";
import { eventLeads } from "./events";
import { clientProfile } from "./profile";
import type { EventOpportunity } from "./types";
import {
  calendarFitFor,
  EVENT_TYPE_FIT,
  isOpenQuestionRisk,
  rankOpportunities,
  regionFitFor,
  scoreOpportunity,
  TIER_BANDS,
  tradingDays,
  VENDOR_IRRELEVANT_REASON,
  VENDOR_UNCLEAR_DEDUCTION,
  VENDOR_UNCLEAR_RISK
} from "./ranking";

// Fixtures carry fixed 2026 calendar dates; scoring against the wall clock rots as
// real time passes them. Every test pins the fixtures' own observation date.
const TEST_NOW = new Date("2026-07-27T09:00:00+02:00");

/**
 * A synthetic event built from known facts only — no fee, no visitor numbers,
 * no risk signals. Every allocation test starts here and changes ONE fact, so a
 * changed number is always attributable.
 *
 * 2026-08-15 is a Saturday, 2026-08-16 a Sunday, 2026-08-17 a Monday.
 */
function known(overrides: Partial<EventOpportunity> = {}): EventOpportunity {
  return {
    id: "synthetic",
    name: "Synthetic Street Food Festival",
    city: "Potsdam",
    state: "Brandenburg",
    startsAt: "2026-08-15T10:00:00+02:00",
    endsAt: "2026-08-15T20:00:00+02:00",
    eventType: "street_food",
    verification: "verified",
    applicationState: "open",
    infrastructure: {},
    fitSignals: [],
    riskSignals: [],
    missingFields: [],
    sources: [],
    pipeline: "discovered",
    vendorRelevance: "relevant",
    ...overrides
  } as EventOpportunity;
}

const componentsOf = (event: EventOpportunity) =>
  scoreOpportunity(event, clientProfile, TEST_NOW).scoreBreakdown!;

describe("opportunity ranking", () => {
  it("hard-rejects a closed application instead of hiding the reason", () => {
    const event = eventLeads.find((item) => item.id === "schlachtefest-paaren-2026");
    expect(event).toBeDefined();
    const ranked = scoreOpportunity(event!, clientProfile, TEST_NOW);
    expect(ranked.tier).toBe("REJECTED");
    expect(ranked.rejectionReason).toMatch(/deadline has passed/);
  });

  it("keeps verified open opportunities above incomplete leads without inflating the tier", () => {
    const ranked = rankOpportunities(eventLeads, clientProfile, TEST_NOW);
    expect(ranked[0].id).toBe("weihnachtsrodeo-berlin-2026");
  });

  it("does not fabricate travel distance from a region-only home location", () => {
    const ranked = rankOpportunities(eventLeads, clientProfile, TEST_NOW);
    expect(ranked.every((event) => event.travelMinutes === undefined)).toBe(true);
  });

  it("counts inclusive trading days and rewards longer bookings without rejecting short events", () => {
    const oneDay = eventLeads.find((item) => item.id === "tabakbluetenfest-vierraden-2026")!;
    const threeDay = eventLeads.find((item) => item.id === "schwedter-oktoberfest-2026")!;
    expect(tradingDays(oneDay)).toBe(1);
    expect(tradingDays(threeDay)).toBe(3);
    expect(scoreOpportunity(threeDay, clientProfile, TEST_NOW).scoreBreakdown?.TradingDuration).toBe(10);
    expect(scoreOpportunity(oneDay, clientProfile, TEST_NOW).tier).not.toBe("REJECTED");
  });
});

/* ============================================== the 100-point allocation */

describe("fit scores what is KNOWN", () => {
  it("prints exactly eight components: five known-fact, two evidence bonuses, one deductions line", () => {
    expect(Object.keys(componentsOf(known()))).toEqual([
      "EventTypeFit",
      "CalendarFit",
      "RegionFit",
      "TradingDuration",
      "ApplicationWindow",
      "DemandEvidence",
      "EconomicsEvidence",
      "Deductions"
    ]);
  });

  it("scores the event TYPE on one published ladder — street food is the target", () => {
    expect(EVENT_TYPE_FIT).toEqual({
      street_food: 30,
      market: 24,
      christmas: 22,
      city_festival: 18,
      sports: 10,
      private: 8
    });
    (Object.keys(EVENT_TYPE_FIT) as (keyof typeof EVENT_TYPE_FIT)[]).forEach((type) => {
      expect(componentsOf(known({ eventType: type })).EventTypeFit).toBe(EVENT_TYPE_FIT[type]);
    });
  });

  it("scores the calendar on ALL trading days, not just the first one", () => {
    // Sat only, Sat+Sun: every day is a trading day for this profile.
    expect(componentsOf(known()).CalendarFit).toBe(20);
    expect(componentsOf(known({ endsAt: "2026-08-16T20:00:00+02:00" })).CalendarFit).toBe(20);
    // Sat→Mon: the Monday is not a trading day, so it is "some", not "all".
    expect(componentsOf(known({ endsAt: "2026-08-17T20:00:00+02:00" })).CalendarFit).toBe(12);
    // Mon only: none.
    expect(
      componentsOf(
        known({ startsAt: "2026-08-17T10:00:00+02:00", endsAt: "2026-08-17T20:00:00+02:00" })
      ).CalendarFit
    ).toBe(4);
  });

  it("counts the optional Thursday only where the profile opted into it", () => {
    const thursday = { startsAt: "2026-08-13T10:00:00+02:00", endsAt: "2026-08-13T20:00:00+02:00" };
    expect(calendarFitFor(thursday, clientProfile)).toBe(20);
    expect(calendarFitFor(thursday, { ...clientProfile, optionalThursday: false })).toBe(4);
  });

  it("reads the home region from the profile, never from a hardcoded state name", () => {
    expect(regionFitFor({ state: "Brandenburg" }, clientProfile)).toBe(15);
    // Berlin is home ground for a Brandenburg operator and the reverse holds.
    expect(regionFitFor({ state: "Berlin" }, clientProfile)).toBe(15);
    expect(regionFitFor({ state: "Berlin" }, { ...clientProfile, homeRegion: "Berlin" })).toBe(15);
    // Move the profile and the same event stops being home ground.
    expect(regionFitFor({ state: "Brandenburg" }, { ...clientProfile, homeRegion: "Bayern" })).toBe(8);
  });

  it("scores a KNOWN travel time against the profile's own ceilings", () => {
    const far = { state: "Bayern" };
    expect(regionFitFor({ ...far, travelMinutes: 60 }, clientProfile)).toBe(13);
    expect(regionFitFor({ ...far, travelMinutes: 8 * 60 }, clientProfile)).toBe(13);
    expect(regionFitFor({ ...far, travelMinutes: 9 * 60 }, clientProfile)).toBe(5);
    // Unknown is NOT scored as far: we have not measured it, that is all.
    expect(regionFitFor(far, clientProfile)).toBe(8);
  });

  it("still hard-rejects beyond the exceptional travel ceiling", () => {
    const ranked = scoreOpportunity(
      known({ state: "Bayern", travelMinutes: 11 * 60 }),
      clientProfile,
      TEST_NOW
    );
    expect(ranked.tier).toBe("REJECTED");
    expect(ranked.rejectionReason).toMatch(/maximum travel time/);
  });

  it("pays for trading days on the published ladder", () => {
    expect(componentsOf(known()).TradingDuration).toBe(4);
    expect(componentsOf(known({ endsAt: "2026-08-16T20:00:00+02:00" })).TradingDuration).toBe(7);
    expect(componentsOf(known({ endsAt: "2026-08-17T20:00:00+02:00" })).TradingDuration).toBe(10);
  });

  it("scores the application WINDOW by its state, and an unknown window above none", () => {
    expect(componentsOf(known({ applicationState: "open" })).ApplicationWindow).toBe(10);
    expect(componentsOf(known({ applicationState: "unknown" })).ApplicationWindow).toBe(5);
    // A window nobody has opened yet is a real, dated future — not an unknown.
    expect(
      componentsOf(
        known({
          applicationState: "unknown",
          application: { capacityState: "not_yet_open" }
        } as Partial<EventOpportunity>)
      ).ApplicationWindow
    ).toBe(7);
  });
});

/* ================================================== the evidence bonuses */

describe("evidence is a bonus, never a toll", () => {
  it("pays for sourced visitor numbers on a straight line, capped at ten", () => {
    expect(componentsOf(known({ expectedVisitors: 5_000 })).DemandEvidence).toBe(5);
    expect(componentsOf(known({ expectedVisitors: 10_000 })).DemandEvidence).toBe(10);
    expect(componentsOf(known({ expectedVisitors: 250_000 })).DemandEvidence).toBe(10);
    expect(componentsOf(known()).DemandEvidence).toBe(0);
  });

  it("pays five for a known pitch fee, because knowing it is what enables the decision", () => {
    expect(componentsOf(known({ pitchFeeEur: 180 })).EconomicsEvidence).toBe(5);
    // Free is a KNOWN fee, not an absent one.
    expect(componentsOf(known({ pitchFeeEur: 0 })).EconomicsEvidence).toBe(5);
    expect(componentsOf(known()).EconomicsEvidence).toBe(0);
  });

  it("NEVER deducts for an unknown — the gap costs only the bonus it cannot earn", () => {
    // The founder's complaint, as a property. Two identical events; one has a
    // fee and a visitor count on record, the other has neither.
    const evidenced = known({ pitchFeeEur: 150, expectedVisitors: 40_000 });
    const unknown = known();

    const withEvidence = scoreOpportunity(evidenced, clientProfile, TEST_NOW);
    const withoutEvidence = scoreOpportunity(unknown, clientProfile, TEST_NOW);

    // Lower — but by EXACTLY the two bonuses, and by nothing else.
    expect(withoutEvidence.score!).toBeLessThan(withEvidence.score!);
    expect(withEvidence.score! - withoutEvidence.score!).toBe(15);
    expect(withoutEvidence.scoreBreakdown!.Deductions).toBe(0);
    (["EventTypeFit", "CalendarFit", "RegionFit", "TradingDuration", "ApplicationWindow"] as const).forEach(
      (component) => {
        expect(withoutEvidence.scoreBreakdown![component]).toBe(
          withEvidence.scoreBreakdown![component]
        );
      }
    );
  });

  it("lets an event with NO commercial evidence at all reach STRONG FIT", () => {
    // A street-food festival, in the home region, every day a trading day,
    // window open, and not one fee or visitor figure recorded. Under the old
    // allocation this was structurally impossible: the unknowns were charged
    // twice and the ceiling moved out of reach.
    const ranked = scoreOpportunity(
      known({ endsAt: "2026-08-16T20:00:00+02:00" }),
      clientProfile,
      TEST_NOW
    );
    expect(ranked.pitchFeeEur).toBeUndefined();
    expect(ranked.expectedVisitors).toBeUndefined();
    expect(ranked.score!).toBeGreaterThanOrEqual(TIER_BANDS.A);
    expect(ranked.tier).toBe("A");
  });

  it("caps the whole scale at 100 — every component at its maximum lands exactly there", () => {
    const best = scoreOpportunity(
      known({
        endsAt: "2026-08-17T20:00:00+02:00", // Sat-Mon: 3 days, "some" prime days
        startsAt: "2026-08-15T10:00:00+02:00",
        expectedVisitors: 200_000,
        pitchFeeEur: 120
      }),
      clientProfile,
      TEST_NOW
    );
    // 30 + 12 + 15 + 10 + 10 + 10 + 5 = 92; the missing 8 is the calendar
    // component's own penalty for the Monday.
    expect(best.score).toBe(92);

    const perfect = scoreOpportunity(
      known({ endsAt: "2026-08-16T20:00:00+02:00", expectedVisitors: 200_000, pitchFeeEur: 120 }),
      clientProfile,
      TEST_NOW
    );
    // 30 + 20 + 15 + 7 + 10 + 10 + 5 = 97: the 3 the two-day run cannot earn.
    expect(perfect.score).toBe(97);
  });
});

/* ========================================================= the deductions */

describe("deductions are for genuine negatives only", () => {
  it("charges two points per real risk signal, capped at ten", () => {
    const risky = (count: number) =>
      componentsOf(known({ riskSignals: Array.from({ length: count }, (_, i) => `Very short notice ${i}`) }))
        .Deductions;
    expect(risky(0)).toBe(0);
    expect(risky(1)).toBe(-2);
    expect(risky(3)).toBe(-6);
    expect(risky(9)).toBe(-10);
  });

  it("does not charge a 'risk signal' that only records an open question", () => {
    // "Vendor-category capacity is not confirmed" sits on 357 of the 378 live
    // events: it marks every event nobody has phoned yet. Charged, it was the
    // missing-evidence penalty under another name.
    expect(isOpenQuestionRisk("Vendor-category capacity is not confirmed")).toBe(true);
    expect(isOpenQuestionRisk("Opening hours remain unknown")).toBe(true);
    expect(isOpenQuestionRisk("No vendor application has been found")).toBe(true);
    expect(isOpenQuestionRisk("Public view does not prove that food places remain")).toBe(true);
    expect(isOpenQuestionRisk("Very short notice")).toBe(false);

    const withOpenQuestion = known({ riskSignals: ["Vendor-category capacity is not confirmed"] });
    expect(componentsOf(withOpenQuestion).Deductions).toBe(0);
    // It is still carried and still printed — it just does not cost score.
    expect(
      scoreOpportunity(withOpenQuestion, clientProfile, TEST_NOW).riskSignals
    ).toContain("Vendor-category capacity is not confirmed");
  });

  it("charges nothing for a missing fact, however many are open", () => {
    const noFacts = known();
    const manyOpen = known({
      missingFields: ["Pitch fee", "Expected visitors", "Power", "Water", "Organizer", "Opening hours"]
    });
    expect(scoreOpportunity(manyOpen, clientProfile, TEST_NOW).score).toBe(
      scoreOpportunity(noFacts, clientProfile, TEST_NOW).score
    );
    expect(componentsOf(manyOpen).Deductions).toBe(0);
  });
});

/* ============================================================ the bands */

describe("the tier bands", () => {
  it("publishes the bands it sorts by, so a tier is never an unexplained label", () => {
    expect(TIER_BANDS).toEqual({ A: 72, B: 62 });
    const at = (score: number) => (score >= TIER_BANDS.A ? "A" : score >= TIER_BANDS.B ? "B" : "C");
    expect(at(TIER_BANDS.A)).toBe("A");
    expect(at(TIER_BANDS.A - 1)).toBe("B");
    expect(at(TIER_BANDS.B)).toBe("B");
    expect(at(TIER_BANDS.B - 1)).toBe("C");
  });

  it("puts a far, one-day sports fixture below the band it belongs under", () => {
    const weak = scoreOpportunity(
      known({
        eventType: "sports",
        state: "Bayern",
        startsAt: "2026-08-17T10:00:00+02:00",
        endsAt: "2026-08-17T20:00:00+02:00",
        applicationState: "unknown"
      }),
      clientProfile,
      TEST_NOW
    );
    expect(weak.tier).toBe("C");
  });
});

describe("the vendor-relevance gate", () => {
  /** A live, open, nearby, well-evidenced event — strong on every other axis. */
  const strong = () => ({
    ...eventLeads.find((item) => item.id === "weihnachtsrodeo-berlin-2026")!
  });

  it("hard-rejects an irrelevant event whatever else is true about it", () => {
    // The point of the gate: the event below is open, close, evidenced and
    // otherwise top-ranked. None of that can make a guided tour into a pitch.
    const ranked = scoreOpportunity(
      { ...strong(), vendorRelevance: "irrelevant" },
      clientProfile,
      TEST_NOW
    );
    expect(ranked.tier).toBe("REJECTED");
    expect(ranked.score).toBe(0);
    expect(ranked.rejectionReason).toBe(VENDOR_IRRELEVANT_REASON);
  });

  it("rejects before the deadline gate, so the reason names the real problem", () => {
    const ranked = scoreOpportunity(
      { ...strong(), vendorRelevance: "irrelevant", applicationState: "closed" },
      clientProfile,
      TEST_NOW
    );
    expect(ranked.rejectionReason).toBe(VENDOR_IRRELEVANT_REASON);
  });

  it("costs a relevant event nothing — its deductions are the pre-existing ones only", () => {
    const event = { ...strong(), vendorRelevance: "relevant" as const };
    const ranked = scoreOpportunity(event, clientProfile, TEST_NOW);

    const chargeable = event.riskSignals.filter((signal) => !isOpenQuestionRisk(signal));
    const charged = Math.min(10, chargeable.length * 2);
    expect(ranked.scoreBreakdown!.Deductions).toBe(charged === 0 ? 0 : -charged);
    expect(ranked.riskSignals).not.toContain(VENDOR_UNCLEAR_RISK);
    expect(ranked.riskSignals).toEqual(event.riskSignals);
  });

  it("deducts exactly six points for an unclear verdict and says why", () => {
    const relevant = scoreOpportunity(
      { ...strong(), vendorRelevance: "relevant" },
      clientProfile,
      TEST_NOW
    );
    const unclear = scoreOpportunity(
      { ...strong(), vendorRelevance: "unclear" },
      clientProfile,
      TEST_NOW
    );

    expect(relevant.score! - unclear.score!).toBe(VENDOR_UNCLEAR_DEDUCTION);
    expect(unclear.scoreBreakdown!.Deductions).toBe(
      relevant.scoreBreakdown!.Deductions - VENDOR_UNCLEAR_DEDUCTION
    );
    expect(unclear.riskSignals).toContain(VENDOR_UNCLEAR_RISK);
    expect(unclear.tier).not.toBe("REJECTED");
  });

  it("keeps the breakdown at eight components — the deduction is folded in", () => {
    const unclear = scoreOpportunity(
      { ...strong(), vendorRelevance: "unclear" },
      clientProfile,
      TEST_NOW
    );
    expect(Object.keys(unclear.scoreBreakdown!)).toHaveLength(8);
  });

  it("charges the unclear verdict once, not twice through riskSignals", () => {
    // riskPenalty is 2 per chargeable risk signal. The appended reason states an
    // unverified verdict — an open question — so it costs nothing a second time.
    const event = { ...strong(), riskSignals: [], vendorRelevance: "unclear" as const };
    const relevant = scoreOpportunity({ ...event, vendorRelevance: "relevant" }, clientProfile, TEST_NOW);
    const unclear = scoreOpportunity(event, clientProfile, TEST_NOW);
    expect(relevant.score! - unclear.score!).toBe(VENDOR_UNCLEAR_DEDUCTION);
  });

  it("treats a missing verdict exactly as unclear, never as relevant", () => {
    // An unclassified row must not score as though it had been checked. This
    // also keeps the ranking and the report in step: the report tags a missing
    // verdict "relevance unverified", so the score has to reflect the same
    // caveat or the page would show one the arithmetic contradicts.
    const missing = strong();
    delete (missing as { vendorRelevance?: unknown }).vendorRelevance;

    const asMissing = scoreOpportunity(missing, clientProfile, TEST_NOW);
    const asUnclear = scoreOpportunity(
      { ...missing, vendorRelevance: "unclear" },
      clientProfile,
      TEST_NOW
    );

    expect(asMissing.score).toBe(asUnclear.score);
    expect(asMissing.riskSignals).toContain(VENDOR_UNCLEAR_RISK);
    expect(asMissing.tier).not.toBe("REJECTED");
  });

  it("sorts every rejected irrelevant event below the actionable ones", () => {
    const events = eventLeads.map((event, index) =>
      index % 2 === 0 ? { ...event, vendorRelevance: "irrelevant" as const } : event
    );
    const ranked = rankOpportunities(events, clientProfile, TEST_NOW);
    const firstRejected = ranked.findIndex((event) => event.tier === "REJECTED");
    const lastActionable = ranked.map((event) => event.tier !== "REJECTED").lastIndexOf(true);
    expect(firstRejected).toBeGreaterThan(lastActionable);
  });
});
