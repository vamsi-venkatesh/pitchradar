/**
 * THE WEEKLY DECISION PRODUCT.
 *
 * The report answers one question — "where should we try to get the truck
 * booked next, and what do we need to do now?" — so this suite is organised
 * around the derived decision fields that answer it, and around the invariant
 * that nothing is lost on the way to answering it: the register holds EVERY
 * non-irrelevant event in the snapshot, whatever the brief chose to show.
 *
 * The clock is pinned to the fixtures' own era so the seeded 2026 events are
 * future-dated. Nothing in this suite reads the machine clock, so the assertions
 * cannot rot into a different answer next month.
 */
import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot } from "./catalogue";
import {
  actionFor,
  APPROVAL_NOTICE,
  buildWeeklyReport,
  confidenceCauseFor,
  confidenceFor,
  deadlineSeverity,
  MAX_TOP_OPPORTUNITIES,
  pipelineLabelFor,
  recommendationFor,
  renderBriefHtml,
  renderRegisterXlsx,
  whyItFitsFrom,
  type ActionInput,
  type ConfidenceInput,
  type ReportDeadline
} from "./report";
import { scoreOpportunity, vendorRelevanceOf } from "../src/ranking";
import type { EventOpportunity, PipelineState } from "../src/types";
import type { ProductSnapshot } from "../src/product-data";

const NOW = new Date("2026-07-27T09:00:00+02:00");

function snapshot(): ProductSnapshot {
  return fixtureProductSnapshot();
}

/** A minimal, fully-specified event used to exercise one rule at a time. */
function syntheticEvent(overrides: Partial<EventOpportunity> & { id: string }): EventOpportunity {
  return {
    name: "Synthetic Test Event",
    city: "Potsdam",
    state: "Brandenburg",
    startsAt: "2026-08-15T10:00:00+02:00",
    endsAt: "2026-08-15T20:00:00+02:00",
    eventType: "street_food",
    verification: "verified",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [],
    riskSignals: [],
    missingFields: [],
    sources: [],
    pipeline: "discovered",
    // The normalizer classifies every row it writes, so a test event with no
    // recorded verdict would be "unclear" — and the unclear CAP would then be
    // the thing under test in every case. Relevance is stated here and
    // overridden explicitly wherever the gate itself is the subject.
    vendorRelevance: "relevant",
    ...overrides
  } as EventOpportunity;
}

function snapshotWith(events: EventOpportunity[]): ProductSnapshot {
  return { ...snapshot(), events, bookings: [] };
}

/** The register row for one id — the report's single source of truth per event. */
function rowFor(report: ReturnType<typeof buildWeeklyReport>, id: string) {
  return report.register.find((event) => event.id === id)!;
}

/* ================================================================ structure */

describe("weekly report — structure and the no-event-lost invariant", () => {
  it("reports the ISO week of the injected clock", () => {
    const report = buildWeeklyReport(snapshot(), NOW);

    expect(report.product).toBe("PitchRadar");
    expect(report.isoWeek).toBe("2026-W31");
    expect(report.weekStart).toBe("2026-07-27");
    expect(report.weekEnd).toBe("2026-08-02");
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it("carries EVERY non-irrelevant snapshot event in the register, exactly once", () => {
    // The brief is a selection; the register is the census. An event must never
    // fall out of the report because it sat outside a horizon, and it must never
    // appear twice because it spans two calendar weeks.
    const source = snapshot();
    const report = buildWeeklyReport(source, NOW);

    const expected = source.events.filter((event) => vendorRelevanceOf(event) !== "irrelevant");
    expect(report.register).toHaveLength(expected.length);
    expect(new Set(report.register.map((event) => event.id)).size).toBe(report.register.length);
    expect([...report.register.map((event) => event.id)].sort()).toEqual(
      [...expected.map((event) => event.id)].sort()
    );
  });

  it("draws every brief selection from the register and never from anywhere else", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const ids = new Set(report.register.map((event) => event.id));

    [report.actionNow, report.topOpportunities, report.radar, report.conflicts].forEach((selection) =>
      selection.forEach((event) => expect(ids.has(event.id)).toBe(true))
    );
    report.deadlineRadar.forEach((item) => expect(ids.has(item.eventId)).toBe(true));
    report.drafts.forEach((draft) => expect(ids.has(draft.eventId)).toBe(true));
  });

  it("states the data mode honestly and counts what the snapshot actually holds", () => {
    const source = snapshot();
    const report = buildWeeklyReport(source, NOW);

    expect(report.mode).toBe("fixtures");
    expect(report.modeStatement).toContain("fixture");
    expect(report.totals.events).toBe(source.events.length);
    expect(report.totals.sources).toBe(source.sources.length);
    expect(report.totals.evidenceRecords).toBe(
      source.events.reduce((total, event) => total + event.sources.length, 0) +
        source.bookings.reduce((total, booking) => total + booking.sources.length, 0)
    );
  });

  it("puts the technical counts in System health, and the mode out of the masthead", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const html = renderBriefHtml(report);

    // The reader's first line must be about opportunities, not about which
    // database the machine read.
    const masthead = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(masthead).not.toContain("postgres");
    expect(masthead).not.toContain("fixtures");
    expect(masthead).toContain("Data freshness");
    expect(masthead).toContain("speciality food truck");

    expect(html).toContain("System health");
    expect(report.systemHealth.eventsCollected).toBe(snapshot().events.length);
    expect(report.systemHealth.registeredSources).toBe(snapshot().sources.length);
  });
});

/* ====================================================== derived: fit verdict */

describe("derived field — recommendation", () => {
  const table: Array<[string, Parameters<typeof recommendationFor>[0], string]> = [
    ["a rejected event is SKIP", { tier: "REJECTED", vendorRelevance: "relevant", rejected: true }, "SKIP"],
    ["tier A and relevant is STRONG FIT", { tier: "A", vendorRelevance: "relevant", rejected: false }, "STRONG FIT"],
    ["tier B and relevant is GOOD FIT", { tier: "B", vendorRelevance: "relevant", rejected: false }, "GOOD FIT"],
    ["tier C is WATCH", { tier: "C", vendorRelevance: "relevant", rejected: false }, "WATCH"],
    ["tier A but unclear caps at WATCH", { tier: "A", vendorRelevance: "unclear", rejected: false }, "WATCH"],
    ["tier B but unclear caps at WATCH", { tier: "B", vendorRelevance: "unclear", rejected: false }, "WATCH"]
  ];

  table.forEach(([name, input, expected]) => {
    it(name, () => expect(recommendationFor(input)).toBe(expected));
  });

  it("never lets an unclear-relevance event reach Top opportunities or Action now", () => {
    // Strong on every commercial axis, and explicitly unverified as a vendor
    // opportunity. The cap must hold against the score, not beside it.
    const unclear = {
      ...syntheticEvent({
        id: "strong-but-unclear",
        name: "Köpenicker Herbst",
        vendorRelevance: "unclear",
        expectedVisitors: 120_000,
        organizer: "Stadt Berlin",
        contactEmail: "markt@example-berlin.de",
        applicationDeadline: "2026-08-01"
      }),
      deadlineEvidence: "published"
    } as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([unclear]), NOW);
    const row = rowFor(report, "strong-but-unclear");

    expect(row.recommendation).toBe("WATCH");
    expect(report.topOpportunities.map((event) => event.id)).not.toContain("strong-but-unclear");
    expect(report.actionNow.map((event) => event.id)).not.toContain("strong-but-unclear");
    // A near deadline cannot promote it either: relevance comes first.
    expect(row.action.action).toBe("NO ACTION");
    expect(row.action.because).toContain("vendor relevance is unverified");
    // It is still SHOWN — tagged, on the radar, never dropped.
    expect(report.radar.map((event) => event.id)).toContain("strong-but-unclear");
    expect(renderBriefHtml(report)).toContain("relevance unverified");
  });

  it("caps the Top opportunities at five however many qualify", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      syntheticEvent({
        id: `strong-${index}`,
        name: `Strong Fest ${index}`,
        expectedVisitors: 150_000,
        vendorRelevance: "relevant",
        organizer: "Stadt Potsdam",
        contactEmail: "markt@example-potsdam.de"
      })
    );
    const report = buildWeeklyReport(snapshotWith(many), NOW);
    expect(report.topOpportunities.length).toBeLessThanOrEqual(MAX_TOP_OPPORTUNITIES);
    expect(report.topOpportunities).toHaveLength(MAX_TOP_OPPORTUNITIES);
  });

  it("orders the Top opportunities by fit then by the highest score", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    // Eligibility deliberately admits WATCH events: on a real corpus most rows
    // lack fee/visitor evidence and sit in WATCH, and an empty section helps
    // nobody. Ordering still puts stronger fits first and the card labels stay
    // honest. Rejected and unclear-relevance rows remain excluded outright.
    const eligible = report.register.filter(
      (event) =>
        !event.rejected &&
        event.vendorRelevance === "relevant" &&
        new Date(event.endsAt).getTime() >= NOW.getTime()
    );
    const highestScores = [...eligible]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TOP_OPPORTUNITIES)
      .map((event) => event.score);

    // Strong fits come first, and within the shortlist the scores are the
    // highest eligible scores — the brief cannot promote a weaker event.
    expect(report.topOpportunities.map((event) => event.score).sort((a, b) => b - a)).toEqual(
      highestScores.sort((a, b) => b - a)
    );
    report.topOpportunities.forEach((event) => {
      expect(["STRONG FIT", "GOOD FIT", "WATCH"]).toContain(event.recommendation);
      expect(event.vendorRelevance).toBe("relevant");
    });
  });
});

/* ======================================================= derived: confidence */

describe("derived field — confidence", () => {
  function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
    return {
      verification: "verified",
      routeVerified: true,
      routeKind: "named",
      officialSources: 1,
      organizerIdentified: true,
      locationVerified: true,
      ...overrides
    };
  }

  it("is HIGH on a verified event with an official source and a named or reachable organizer", () => {
    expect(confidenceFor(input()).level).toBe("HIGH");
    // Either half of the organizer clause carries it on its own.
    expect(confidenceFor(input({ routeVerified: false })).level).toBe("HIGH");
    expect(confidenceFor(input({ organizerIdentified: false })).level).toBe("HIGH");
    // Neither half, or no official source, or not verified end to end: MEDIUM.
    expect(
      confidenceFor(input({ routeVerified: false, organizerIdentified: false })).level
    ).toBe("MEDIUM");
    expect(confidenceFor(input({ verification: "partial" })).level).toBe("MEDIUM");
    expect(confidenceFor(input({ officialSources: 0 })).level).toBe("MEDIUM");
  });

  it("counts no open questions — a row with facts outstanding is judged on its sources", () => {
    // The whole point of the recalibration: confidence measures how solid the
    // SHOWN facts are. There is no missing-fact input left to hand it.
    expect(Object.keys(input())).not.toContain("missingFieldCount");
    expect(confidenceFor(input()).level).toBe("HIGH");
  });

  it("is LOW on an aggregator-only listing with no official corroboration, or an unverified location", () => {
    expect(
      confidenceFor(input({ routeKind: "listing_only", routeVerified: false, officialSources: 0 })).level
    ).toBe("LOW");
    expect(
      confidenceFor(input({ routeKind: "none", routeVerified: false, officialSources: 0 })).level
    ).toBe("LOW");
    // A listing-only route that an OFFICIAL source corroborates is not LOW: the
    // corroboration is exactly the thing LOW says is absent.
    expect(confidenceFor(input({ routeKind: "listing_only", routeVerified: false })).level).toBe(
      "HIGH"
    );
    expect(confidenceFor(input({ locationVerified: false })).level).toBe("LOW");
  });

  it("takes the pessimistic reading when a row qualifies for both HIGH and LOW", () => {
    // Verified, routed, sourced — and its city is a venue string. The report
    // must not put a place it cannot name on a decision page under HIGH.
    const both = confidenceFor(input({ locationVerified: false }));
    expect(both.level).toBe("LOW");
    expect(both.reason).toContain("location");
  });

  it("carries the reason, so a reader never sees a level without a cause", () => {
    expect(confidenceFor(input()).reason).toContain("official source");
    expect(confidenceFor(input({ routeKind: "none", routeVerified: false, officialSources: 0 })).reason)
      .toContain("aggregator listing");
    expect(confidenceFor(input({ verification: "partial" })).reason).toBeTruthy();
  });

  it("is a separate axis from fit — a STRONG FIT can carry LOW confidence", () => {
    // A street-food festival on the profile's own trading days, three days
    // long, in the home region: a direct fit on facts we hold. Its only source
    // is an aggregator listing, so what we hold is thin — STRONG FIT, LOW
    // CONFIDENCE, and the two labels must be allowed to disagree.
    const strongButUnknown = syntheticEvent({
      id: "strong-low",
      name: "Strong But Unknown Fest",
      eventType: "street_food",
      state: "Brandenburg",
      vendorRelevance: "relevant",
      verification: "lead",
      applicationState: "open",
      sources: [
        {
          label: "Listing",
          url: "https://example-aggregator.test/strong-low",
          publisher: "Aggregator",
          official: false,
          observedAt: "2026-07-20T09:00:00+02:00",
          supports: ["dates"]
        }
      ],
      missingFields: ["organizer", "pitch fee", "power", "water", "category capacity"]
    });
    const report = buildWeeklyReport(snapshotWith([strongButUnknown]), NOW);
    const row = rowFor(report, "strong-low");
    expect(row.confidence).toBe("LOW");
    expect(row.tier).toBe("A");
    expect(row.recommendation).toBe("STRONG FIT");
  });
});

/* ========================================================= derived: pipeline */

describe("derived field — pipeline label", () => {
  const every: PipelineState[] = [
    "discovered",
    "verifying",
    "watching",
    "owner_review",
    "applied",
    "accepted",
    "waitlist",
    "rejected",
    "completed"
  ];

  it("maps every state the database enum can hold", () => {
    // The map is a total Record over PipelineState: a state added to the enum
    // without a decision about what it means to the owner is a BUILD error, not
    // a silent fallback. This asserts the runtime half of that contract.
    every.forEach((state) => expect(pipelineLabelFor(state)).toBeTruthy());
    expect(every.map(pipelineLabelFor)).toEqual([
      "Discovered",
      "Verifying",
      "Verifying",
      "Ready to contact",
      "Applied",
      "Booked",
      "Applied",
      "Lost",
      "Completed"
    ]);
  });

  it("calls an event whose dates have passed Expired, whatever the stored state says", () => {
    const past = syntheticEvent({
      id: "already-over",
      name: "Last Month Fest",
      startsAt: "2026-06-01T10:00:00+02:00",
      endsAt: "2026-06-02T20:00:00+02:00",
      pipeline: "discovered"
    });
    const report = buildWeeklyReport(snapshotWith([past]), NOW);
    expect(rowFor(report, "already-over").pipelineLabel).toBe("Expired");
  });

  it("counts the register by label, in a stable order, omitting empty labels", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const total = report.pipelineCounts.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(report.register.length);
    report.pipelineCounts.forEach((row) => expect(row.count).toBeGreaterThan(0));
  });
});

/* ============================================================ derived: action */

describe("derived field — the action rule table", () => {
  function deadline(overrides: Partial<ReportDeadline> = {}): ReportDeadline {
    return { evidence: "unknown", line: "No deadline published — not yet found", severity: "WATCH", ...overrides };
  }
  function input(overrides: Partial<ActionInput> = {}): ActionInput {
    return {
      recommendation: "GOOD FIT",
      deadline: deadline(),
      routeKind: "application_url",
      routeVerified: false,
      missingFields: [],
      overlapsBooking: false,
      weatherRiskFlags: [],
      insideForecastWindow: false,
      decisionCritical: false,
      vendorRelevance: "relevant",
      ...overrides
    };
  }

  it("rule 1 — a published deadline within 7 days and any route is APPLY NOW / URGENT", () => {
    const result = actionFor(
      input({ deadline: deadline({ evidence: "published", daysRemaining: 5, severity: "URGENT" }) })
    );
    expect(result).toMatchObject({ action: "APPLY NOW", severity: "URGENT" });
    expect(result.because).toContain("5 days");
  });

  it("rule 1 does not fire without a route — there is nowhere to apply", () => {
    const result = actionFor(
      input({
        routeKind: "none",
        deadline: deadline({ evidence: "published", daysRemaining: 5, severity: "URGENT" })
      })
    );
    expect(result.action).toBe("CONTACT ORGANIZER");
  });

  it("rule 2 — a published deadline within 30 days is CONTACT ORGANIZER / SOON", () => {
    expect(
      actionFor(input({ deadline: deadline({ evidence: "published", daysRemaining: 21, severity: "SOON" }) }))
    ).toMatchObject({ action: "CONTACT ORGANIZER", severity: "SOON" });
  });

  it("rule 3 — a strong fit with a verified route is CONTACT ORGANIZER / SOON", () => {
    expect(
      actionFor(input({ recommendation: "STRONG FIT", routeVerified: true, routeKind: "named" }))
    ).toMatchObject({ action: "CONTACT ORGANIZER", severity: "SOON" });
  });

  it("rule 4 — a collision with a booking that holds the truck is REVIEW CONFLICT / URGENT", () => {
    expect(actionFor(input({ overlapsBooking: true }))).toMatchObject({
      action: "REVIEW CONFLICT",
      severity: "URGENT"
    });
  });

  it("rule 4 outranks rule 5 — a double-booked weekend is never downgraded to a fit question", () => {
    // The ordering that only showed once real events started reaching GOOD FIT:
    // a truck already promised to somebody is a harder fact than an open
    // category question, and must not be reported as WATCH.
    expect(
      actionFor(input({ overlapsBooking: true, missingFields: ["Category capacity for food vendors"] }))
    ).toMatchObject({ action: "REVIEW CONFLICT", severity: "URGENT" });
  });

  it("rule 5 — a good fit blocked by a NAMED unknown is VERIFY CATEGORY AVAILABILITY / WATCH", () => {
    const result = actionFor(input({ missingFields: ["Category capacity for food vendors"] }));
    expect(result).toMatchObject({ action: "VERIFY CATEGORY AVAILABILITY", severity: "WATCH" });
    expect(result.because).toContain("Category capacity");
  });

  it("rule 5 does not fire on an unnamed gap — 'we know little' is not a next action", () => {
    expect(actionFor(input({ missingFields: ["power supply", "water"] })).action).toBe("NO ACTION");
  });

  it("rule 6 — a weather risk on a decision-critical event in window is WEATHER CHECK / SOON", () => {
    const result = actionFor(
      input({ weatherRiskFlags: ["heavy rain"], insideForecastWindow: true, decisionCritical: true })
    );
    expect(result).toMatchObject({ action: "WEATHER CHECK", severity: "SOON" });
    expect(result.because).toContain("heavy rain");

    // Not decision-critical, or outside the window: not an action.
    expect(
      actionFor(input({ weatherRiskFlags: ["heavy rain"], insideForecastWindow: true })).action
    ).toBe("NO ACTION");
    expect(
      actionFor(input({ weatherRiskFlags: ["heavy rain"], decisionCritical: true })).action
    ).toBe("NO ACTION");
  });

  it("rule 7 — everything else is NO ACTION / WATCH", () => {
    expect(actionFor(input())).toMatchObject({ action: "NO ACTION", severity: "WATCH" });
  });

  it("a SKIP and an unverified-relevance event never receive an action", () => {
    expect(
      actionFor(
        input({
          recommendation: "SKIP",
          deadline: deadline({ evidence: "published", daysRemaining: 1, severity: "URGENT" })
        })
      ).action
    ).toBe("NO ACTION");
    expect(
      actionFor(
        input({
          vendorRelevance: "unclear",
          deadline: deadline({ evidence: "published", daysRemaining: 1, severity: "URGENT" })
        })
      ).action
    ).toBe("NO ACTION");
  });

  it("puts a far-future event with a near deadline in ACTION NOW, by its severity", () => {
    // German applications open 8–11 months ahead. A 2027 event whose deadline
    // closes next week is exactly what the owner must act on today, and burying
    // it under "further ahead" is how an application window is lost.
    const nextSpring = {
      ...syntheticEvent({
        id: "next-spring",
        name: "Frühlingsfest Next Spring",
        startsAt: "2027-04-10T10:00:00+02:00",
        endsAt: "2027-04-12T20:00:00+02:00",
        applicationUrl: "https://mainz.de/apply"
      }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-08-01"
    } as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([nextSpring]), NOW);
    const row = rowFor(report, "next-spring");
    expect(row.action).toMatchObject({ action: "APPLY NOW", severity: "URGENT" });
    expect(report.actionNow[0].id).toBe("next-spring");
    expect(renderBriefHtml(report)).toContain("Frühlingsfest Next Spring");
  });

  it("orders ACTION NOW urgent first, then by the nearest deadline", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const order = { URGENT: 0, SOON: 1, WATCH: 2 } as const;
    const severities = report.actionNow.map((event) => order[event.action.severity]);
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
  });
});

/* =========================================================== deadline bands */

describe("derived field — deadline severity bands", () => {
  it("bands at 7 and 30 days, and treats a missing or passed deadline as WATCH", () => {
    expect(deadlineSeverity(0)).toBe("URGENT");
    expect(deadlineSeverity(7)).toBe("URGENT");
    expect(deadlineSeverity(8)).toBe("SOON");
    expect(deadlineSeverity(30)).toBe("SOON");
    expect(deadlineSeverity(31)).toBe("WATCH");
    expect(deadlineSeverity(undefined)).toBe("WATCH");
    expect(deadlineSeverity(-1)).toBe("WATCH");
  });

  it("keeps the three evidence states verbatim — they are different facts", () => {
    const published = {
      ...syntheticEvent({ id: "synthetic-published", name: "Published Deadline Fest" }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-08-10"
    } as EventOpportunity;
    const rolling = {
      ...syntheticEvent({ id: "synthetic-rolling", name: "Rolling Applications Fest" }),
      deadlineEvidence: "none_rolling"
    } as EventOpportunity;
    const unfound = {
      ...syntheticEvent({ id: "synthetic-unfound", name: "Unfound Deadline Fest" }),
      deadlineEvidence: "not_found"
    } as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([published, rolling, unfound]), NOW);

    expect(rowFor(report, "synthetic-published").deadline).toMatchObject({
      evidence: "published",
      deadline: "2026-08-10",
      daysRemaining: 14,
      severity: "SOON"
    });
    expect(rowFor(report, "synthetic-published").deadline.line).toBe("Deadline 10 Aug — 14 days left");
    expect(rowFor(report, "synthetic-rolling").deadline.line).toBe("Rolling — no deadline exists");
    expect(rowFor(report, "synthetic-unfound").deadline.line).toBe("No deadline published — not yet found");

    const html = renderBriefHtml(report);
    expect(html).toContain("Rolling — no deadline exists");
    expect(html).toContain("No deadline published — not yet found");
    // "Rolling" and "not yet found" must never be collapsed into one another.
    expect(rowFor(report, "synthetic-rolling").deadline.evidence).not.toBe(
      rowFor(report, "synthetic-unfound").deadline.evidence
    );

    // Only the published deadline reaches the radar, with its countdown.
    expect(report.deadlineRadar.map((item) => item.eventId)).toEqual(["synthetic-published"]);
    expect(report.deadlineRadar[0].daysRemaining).toBe(14);
  });

  it("sorts the deadline radar soonest-first, omits passed deadlines, and names the route", () => {
    const soon = {
      ...syntheticEvent({
        id: "soon",
        name: "Soon Fest",
        startsAt: "2026-08-22T10:00:00+02:00",
        endsAt: "2026-08-22T20:00:00+02:00",
        applicationUrl: "https://example.org/apply"
      }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-08-03"
    } as EventOpportunity;
    const later = {
      ...syntheticEvent({
        id: "later",
        name: "Later Fest",
        startsAt: "2026-09-05T10:00:00+02:00",
        endsAt: "2026-09-05T20:00:00+02:00"
      }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-08-20"
    } as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([soon, later]), NOW);
    expect(report.deadlineRadar.map((item) => item.eventId)).toEqual(["soon", "later"]);
    expect(report.deadlineRadar.map((item) => item.daysRemaining)).toEqual([7, 24]);
    expect(report.deadlineRadar.map((item) => item.severity)).toEqual(["URGENT", "SOON"]);
    expect(report.deadlineRadar[0].routeStatus).toContain("portal");
    expect(report.deadlineRadar[0].recommendedAction).toBe("APPLY NOW");
  });
});

/* ========================================================= derived: why it fits */

describe("derived field — why it fits", () => {
  it("derives every phrase from a number the ranking produced", () => {
    expect(
      whyItFitsFrom({
        components: {
          EventTypeFit: 30,
          CalendarFit: 20,
          RegionFit: 15,
          TradingDuration: 10,
          ApplicationWindow: 10,
          DemandEvidence: 10,
          EconomicsEvidence: 5
        },
        tradingDays: 3,
        routeVerified: true
      })
    ).toEqual([
      "direct street-food fit",
      "every trading day is a normal trading day",
      "home region",
      "application window open",
      "strong visitor demand evidence",
      "pitch fee already recorded",
      "multi-day trading (3 days)",
      "verified organizer route"
    ]);
  });

  it("says nothing it cannot point at a component for", () => {
    expect(
      whyItFitsFrom({
        components: {
          EventTypeFit: 10,
          CalendarFit: 4,
          RegionFit: 8,
          TradingDuration: 4,
          ApplicationWindow: 5,
          DemandEvidence: 0,
          EconomicsEvidence: 0
        },
        tradingDays: 1,
        routeVerified: false
      })
    ).toEqual([]);
  });

  it("prints no phrase for absent evidence — a bonus nobody earned is silence, not a caveat", () => {
    // An event with a perfect known-facts profile and no commercial evidence at
    // all still reads as a strong fit. It just never claims a fee or a visitor
    // number it does not have.
    const phrases = whyItFitsFrom({
      components: {
        EventTypeFit: 30,
        CalendarFit: 20,
        RegionFit: 15,
        TradingDuration: 10,
        ApplicationWindow: 10,
        DemandEvidence: 0,
        EconomicsEvidence: 0
      },
      tradingDays: 3,
      routeVerified: false
    });
    expect(phrases).toContain("direct street-food fit");
    expect(phrases.join(" ")).not.toMatch(/visitor|fee/);
  });

  it("matches the real components on every shortlisted event in the fixture", () => {
    const source = snapshot();
    const report = buildWeeklyReport(source, NOW);
    report.topOpportunities.forEach((event) => {
      const original = source.events.find((item) => item.id === event.id)!;
      const scored = scoreOpportunity(original, source.profile, NOW);
      expect(event.whyItFits).toEqual(
        whyItFitsFrom({
          components: scored.scoreBreakdown ?? {},
          tradingDays: event.tradingDays,
          routeVerified: event.contactRoute.verified
        })
      );
    });
  });
});

/* ==================================================================== KPIs */

describe("executive summary — KPI arithmetic", () => {
  it("computes each KPI from the snapshot it was given, not from a section", () => {
    const events = [
      // Two tier-A relevant events → STRONG FIT.
      syntheticEvent({ id: "strong-a", name: "Strong A", expectedVisitors: 150_000 }),
      syntheticEvent({ id: "strong-b", name: "Strong B", expectedVisitors: 150_000 }),
      // One unclear → capped at WATCH, counted as neither shortlisted nor relevant.
      syntheticEvent({ id: "unclear", name: "Unclear One", vendorRelevance: "unclear" }),
      // One excluded outright by the relevance gate.
      syntheticEvent({ id: "noise", name: "Emporenführung", vendorRelevance: "irrelevant" }),
      // One closed by the gates → SKIP.
      syntheticEvent({ id: "far", name: "Far Away", travelMinutes: 10_000 })
    ];
    const report = buildWeeklyReport(snapshotWith(events), NOW);

    expect(report.kpis.eventsChecked).toBe(5);
    expect(report.kpis.vendorRelevant).toBe(3);
    expect(report.register).toHaveLength(4);
    expect(report.kpis.recommended).toBe(
      report.register.filter((event) => event.recommendation === "STRONG FIT").length
    );
    expect(report.kpis.shortlisted).toBe(
      report.register.filter(
        (event) => event.recommendation === "STRONG FIT" || event.recommendation === "GOOD FIT"
      ).length
    );
    // "Action now" counts TASKS; the events they cover are the secondary number.
    expect(report.kpis.actionNow).toBe(report.actionQueue.length);
    expect(report.kpis.actionNowEvents).toBe(report.actionNow.length);
    expect(report.kpis.currentBookings).toBe(0);
    expect(report.kpis.conflicts).toBe(0);
  });

  it("counts upcoming deadlines as the published ones closing within 30 days", () => {
    const inside = {
      ...syntheticEvent({ id: "inside", name: "Inside Fest" }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-08-20"
    } as EventOpportunity;
    const outside = {
      ...syntheticEvent({
        id: "outside",
        name: "Outside Fest",
        startsAt: "2026-11-01T10:00:00+01:00",
        endsAt: "2026-11-01T20:00:00+01:00"
      }),
      deadlineEvidence: "published",
      applicationDeadline: "2026-10-30"
    } as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([inside, outside]), NOW);
    expect(report.kpis.upcomingDeadlines).toBe(1);
    expect(report.deadlineRadar).toHaveLength(2);
  });

  it("writes one summary sentence out of those exact numbers and nothing else", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const sentence = report.summarySentence;

    expect(sentence).toContain(`${report.kpis.eventsChecked} events checked`);
    expect(sentence).toContain(`${report.kpis.vendorRelevant} vendor-relevant`);
    expect(sentence).toContain(`${report.kpis.shortlisted} shortlisted`);
    expect(sentence).toContain(`${report.kpis.recommended} recommended`);
    // TASKS first, the event mass second — the sentence says both, because
    // "106 need action now" was event mass presented as work.
    expect(sentence).toContain(
      `${report.kpis.actionNow} task${report.kpis.actionNow === 1 ? "" : "s"} covering ${
        report.kpis.actionNowEvents
      } event${report.kpis.actionNowEvents === 1 ? "" : "s"} need action now`
    );
    expect(renderBriefHtml(report)).toContain(sentence.slice(0, 40));
  });
});

/* ================================================================= bookings */

describe("bookings — an elapsed booking is not a live booking", () => {
  const ELAPSED_BOOKING_ERA = new Date("2026-09-15T14:30:00+02:00");

  it("renders the elapsed Seefest am Demo-Ufer booking as completed, awaiting outcome", () => {
    // The real defect: ends_at 2026-08-09, state 'live', still rendering as a
    // live booking on 2026-09-15 and still blocking weeks.
    const report = buildWeeklyReport(snapshot(), ELAPSED_BOOKING_ERA);
    const booking = report.bookings.find((item) => item.eventName === "Seefest am Demo-Ufer")!;

    expect(booking.lifecycle).toBe("completed_outcome_pending");
    expect(booking.statusLine).toBe("Completed — outcome pending");
    expect(booking.blockedWeeks).toEqual([]);
    expect(report.blockedWeeks).toEqual([]);
    expect(report.kpis.currentBookings).toBe(0);

    const html = renderBriefHtml(report);
    expect(html).toContain("Completed — outcome pending");
    expect(html).toContain("Completed — awaiting outcome capture");
    // And every outcome fact still wanted is listed, not summarised away.
    booking.missingOutcomeInputs.forEach((field) => expect(html).toContain(field));
    expect(html).toContain("Daily portions and revenue");
  });

  it("still holds the truck while the booking is running", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const booking = report.bookings.find((item) => item.eventName === "Seefest am Demo-Ufer")!;
    expect(booking.lifecycle).toBe("live");
    expect(booking.blockedWeeks.length).toBeGreaterThan(0);
    expect(report.kpis.currentBookings).toBe(1);
  });

  it("says the outcome is recorded once outcome rows exist", () => {
    const base = snapshot();
    const report = buildWeeklyReport(
      {
        ...base,
        bookings: base.bookings.map((booking) => ({ ...booking, outcomesRecorded: 19 }))
      },
      ELAPSED_BOOKING_ERA
    );
    const booking = report.bookings[0];
    expect(booking.lifecycle).toBe("completed_outcome_recorded");
    expect(booking.statusLine).toContain("19 trading day(s) of outcome recorded");
    expect(renderBriefHtml(report)).not.toContain("Completed — outcome pending");
  });

  it("marks a prospect that collides with a booking that holds the truck", () => {
    const base = snapshot();
    const clash = syntheticEvent({
      id: "clashing",
      name: "Clashing Fest",
      startsAt: "2026-08-01T10:00:00+02:00",
      endsAt: "2026-08-02T20:00:00+02:00"
    });
    const report = buildWeeklyReport({ ...base, events: [clash] }, NOW);
    const row = rowFor(report, "clashing");

    expect(row.overlapsBooking).toBe(true);
    expect(row.action).toMatchObject({ action: "REVIEW CONFLICT", severity: "URGENT" });
    expect(report.conflicts.map((event) => event.id)).toContain("clashing");
    expect(report.kpis.conflicts).toBe(1);
  });

  it("stops marking that prospect once the booking has completed", () => {
    const base = snapshot();
    const clash = syntheticEvent({
      id: "clashing",
      name: "Clashing Fest",
      startsAt: "2026-08-01T10:00:00+02:00",
      endsAt: "2026-08-02T20:00:00+02:00"
    });
    const report = buildWeeklyReport({ ...base, events: [clash] }, ELAPSED_BOOKING_ERA);
    expect(report.conflicts).toEqual([]);
    expect(report.kpis.conflicts).toBe(0);
  });
});

/* ================================================================== the brief */

describe("the brief — what it shows and what it refuses to show", () => {
  function styleBlock(html: string): string {
    return html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  }

  it("carries the ten sections in order", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    const order = [
      "Where we stand",
      "Action now",
      "Top opportunities",
      "Opportunity radar",
      "Bookings &amp; conflicts",
      "Deadline radar",
      "Weather",
      "System health",
      "Organizer drafts"
    ];
    let cursor = -1;
    order.forEach((heading) => {
      // The heading TAG, not the words: the nav strip at the top of the brief
      // names six of these sections before any of them is printed.
      const at = html.indexOf(`>${heading}</h2>`);
      expect(at, `missing section: ${heading}`).toBeGreaterThan(-1);
      expect(at, `out of order: ${heading}`).toBeGreaterThan(cursor);
      cursor = at;
    });
  });

  it("shows no score-component grid — but the register carries every component", async () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const html = renderBriefHtml(report);

    // The eight-component grid was the single densest thing on the old page and
    // the thing no decision ever turned on. It is gone from the brief.
    expect(html).not.toContain('class="breakdown"');
    expect(html).not.toContain("EventTypeFit");
    expect(html).not.toContain("ApplicationWindow");
    expect(html).not.toContain("TradingDuration");

    // And it is all in the workbook, where it can be sorted.
    const xlsx = await renderRegisterXlsx(report);
    const text = xlsx.toString("latin1");
    expect(text.length).toBeGreaterThan(1000);
    const withComponents = report.register.find((event) => event.scoreBreakdown.length > 0)!;
    // Eight columns: five known-fact components, two evidence bonuses, and the
    // Deductions line that nets the genuine negatives.
    expect(withComponents.scoreBreakdown.map((part) => part.label)).toEqual([
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

  it("uses none of the internal planning vocabulary", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    // "Primary", "Backup", "Verify first" and "Tier C" are how the machine
    // thinks. The owner reads fit verdicts and next actions.
    expect(html).not.toMatch(/\bPrimary\b/);
    expect(html).not.toMatch(/\bBackup\b/);
    expect(html).not.toMatch(/Verify first/);
    expect(html).not.toMatch(/Tier [ABC]\b/);
  });

  it("keeps raw URLs out of the compact radar rows", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    const html = renderBriefHtml(report);
    const radarSection = html.slice(
      html.indexOf("Opportunity radar"),
      html.indexOf("Bookings &amp; conflicts")
    );
    expect(radarSection).not.toContain("http://");
    expect(radarSection).not.toContain("https://");
    // The route is still reported — as a status a person can read.
    report.radar.forEach((event) => expect(event.contactRoute.statusLine).toBeTruthy());
  });

  it("is fully self-contained: no script, stylesheet, image or font is fetched", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));

    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);

    expect(html).toContain("<style>");
    expect(html).toContain(
      "Every fact above links to its recorded source; unknowns are stated, never estimated."
    );
    // And it points at where the evidence went.
    expect(html).toContain("operational register workbook");
  });

  it("is byte-identical across two builds with the same snapshot and the same clock", () => {
    const first = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    const second = renderBriefHtml(buildWeeklyReport(snapshot(), new Date(NOW.getTime())));

    expect(second).toBe(first);
    // The two builds used two separately-constructed fixture snapshots, each of
    // which stamps its own `loadedAt` at read time. That wall-clock value must
    // never reach the page, or the artifact would differ on every run.
    expect(first).not.toContain(snapshot().loadedAt);
  });
});

/* ========================================================= fits an A4 page */

describe("the brief — fits an A4 page", () => {
  function styleBlock(html: string): string {
    return html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  }
  const css = () => styleBlock(renderBriefHtml(buildWeeklyReport(snapshot(), NOW)));

  it("bounds the sheet to the page and prints at A4", () => {
    expect(css()).toContain(".sheet { max-width: 210mm;");
    expect(css()).toContain("@page { size: A4; margin: 16mm; }");
  });

  it("gives every table a fixed layout and lets long tokens break", () => {
    const style = css();
    expect(style).toContain(".grid { width: 100%; table-layout: fixed;");
    expect(style).toContain("table { max-width: 100%; }");
    expect(style).toContain("td, th, li, p { overflow-wrap: break-word; }");
    expect(style).toMatch(/a \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.grid th, \.grid td \{[^}]*overflow-wrap: anywhere/);
  });

  it("uses no nowrap rule anywhere — that is exactly how a page grows past its width", () => {
    expect(css()).not.toContain("nowrap");
  });

  it("sizes every multi-column layout in equal fractions, never by content", () => {
    const style = css();
    expect(style).toContain(".kpis { display: grid; grid-template-columns: repeat(4, 1fr);");
    expect(style).toContain(".health { display: grid; grid-template-columns: repeat(3, 1fr);");
    // A `min-width` on a grid cell would let content push the track wider.
    expect(style).toContain(".kpis .cell { background: #fffefb; padding: 5px 7px; min-width: 0; }");
    expect(style).toContain(".health .cell { background: #fffefb; padding: 4px 6px; min-width: 0; }");
  });

  it("declares a column width for every column of every table it renders", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    const tables = html.match(/<table class="grid">[\s\S]*?<\/table>/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    tables.forEach((table) => {
      const cols = (table.match(/<col style="width:\d+%" \/>/g) ?? []).length;
      // `<th[^>]*>` would also match `<thead>` — the lookahead pins a real cell.
      const headers = (table.match(/<th(?=[\s>])/g) ?? []).length;
      expect(cols).toBe(headers);
      const total = [...table.matchAll(/width:(\d+)%/g)].reduce(
        (sum, match) => sum + Number(match[1]),
        0
      );
      expect(total).toBe(100);
    });
  });

  it("caps the radar so the brief cannot grow without bound", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      syntheticEvent({ id: `radar-${index}`, name: `Radar Fest ${index}`, vendorRelevance: "relevant" })
    );
    const report = buildWeeklyReport(snapshotWith(many), NOW);
    expect(report.radar.length).toBeLessThanOrEqual(20);
    // Nothing is lost: every one of them is still in the register.
    expect(report.register).toHaveLength(60);
  });

  it("carries explicit page breaks so the section order survives pagination", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    expect((html.match(/class="page-break"/g) ?? []).length).toBeGreaterThan(0);
    expect(styleBlock(html)).toContain(".page-break { break-after: page;");
  });

  it("is denser on paper than on screen, and only on paper", () => {
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    const style = styleBlock(html);
    const print = style.slice(style.indexOf("@media print"));

    // The card groups exist on screen as plain blocks and become two columns
    // only inside the print block — the screen keeps the full-width stack.
    expect(html).toContain('<div class="cards">');
    expect(style.slice(0, style.indexOf("@media print"))).toContain(".cards { display: block; }");
    expect(print).toContain(".cards { column-count: 2");
    expect(print).toContain("break-inside: avoid");

    // Density must never cost a fact: every disclosure is still forced open on
    // paper, and the run-on lists are separators, not omissions.
    expect(print).toContain("details::details-content");
    expect(print).toContain(".why li { display: inline; }");
    expect(print).toContain(".radar ul.stops > li { display: inline;");
  });
});

/* ================================================================= drafts */

describe("organizer drafts", () => {
  it("indexes the drafts in the brief and keeps the full text for the workbook", () => {
    const contactable = syntheticEvent({
      id: "contactable",
      name: "Contactable Fest",
      organizer: "Stadt Potsdam",
      contactEmail: "markt@example-potsdam.de"
    });

    const report = buildWeeklyReport(snapshotWith([contactable]), NOW);
    expect(report.drafts.length).toBeGreaterThan(0);
    expect(report.drafts.length).toBeLessThanOrEqual(5);

    const draft = report.drafts.find((item) => item.eventId === "contactable")!;
    expect(draft.approvalNotice).toBe(APPROVAL_NOTICE);
    expect(draft.draftDe).toContain("Spezialitäten-Foodtruck");
    expect(draft.draftEn).toContain("speciality food truck");
    expect(draft.routeVerified).toBe(false);
    expect(draft.routeNote).toContain("not yet been confirmed reachable");

    const html = renderBriefHtml(report);
    expect(html).toContain(APPROVAL_NOTICE);
    expect(html).toContain("Draft ready — owner approval required");
    // The body text moved to the workbook; the brief says so instead of carrying it.
    expect(html).not.toContain(draft.draftDe);
    expect(html).not.toContain("English translation</h4>");
    expect(html).toContain('sheet "Organizer Drafts"');
  });

  it("never drafts for a rejected event", () => {
    const closed = syntheticEvent({
      id: "closed-with-contact",
      name: "Closed Fest",
      organizer: "Stadt Potsdam",
      contactEmail: "markt@example-potsdam.de",
      applicationState: "closed"
    });
    expect(buildWeeklyReport(snapshotWith([closed]), NOW).drafts).toHaveLength(0);
  });
});

/* ====================================================== rejected and routes */

describe("rejected events", () => {
  it("shows a rejected event only in the register, never as work", () => {
    const rejected = syntheticEvent({
      id: "synthetic-too-far",
      name: "Far Away Festival",
      travelMinutes: 10_000
    });
    const report = buildWeeklyReport(snapshotWith([rejected]), NOW);
    const row = rowFor(report, "synthetic-too-far");

    expect(row.rejected).toBe(true);
    expect(row.actionable).toBe(false);
    expect(row.recommendation).toBe("SKIP");
    expect(row.action.action).toBe("NO ACTION");
    expect(row.rejectionReason).toBe("The event is beyond the maximum travel time.");

    expect(report.actionNow.map((event) => event.id)).not.toContain("synthetic-too-far");
    expect(report.topOpportunities.map((event) => event.id)).not.toContain("synthetic-too-far");
    expect(report.radar.map((event) => event.id)).not.toContain("synthetic-too-far");
    expect(report.deadlineRadar.some((item) => item.eventId === rejected.id)).toBe(false);
    expect(report.drafts.some((draft) => draft.eventId === rejected.id)).toBe(false);
    // It has not been deleted: the register still carries it with its reason.
    expect(report.register.map((event) => event.id)).toContain("synthetic-too-far");
  });
});

describe("contact-route fallback chain", () => {
  function routeFor(event: EventOpportunity) {
    const report = buildWeeklyReport(snapshotWith([event]), NOW);
    return { row: rowFor(report, event.id), html: renderBriefHtml(report) };
  }

  it("prefers a named contact when one is recorded", () => {
    const { row } = routeFor(
      syntheticEvent({
        id: "named-route",
        organizer: "Stadt Potsdam",
        contactEmail: "markt@example-potsdam.de",
        applicationUrl: "https://potsdam.de/apply"
      })
    );
    expect(row.contactRoute.kind).toBe("named");
    expect(row.contactRoute.line).toContain("markt@example-potsdam.de");
    expect(row.contactRoute.statusLine).toBe("Named contact, unconfirmed");
  });

  it("falls back to the application URL rather than claiming nothing was found", () => {
    const { row } = routeFor(
      syntheticEvent({
        id: "url-route",
        applicationUrl: "https://forchheim.de/rathaus-service/service/annafest-bewerbungsmodalitaeten"
      })
    );
    // The old renderer printed "No decision-maker recorded yet" over the top of
    // a perfectly usable application URL. That is a false negative and it costs
    // an application window.
    expect(row.contactRoute.kind).toBe("application_url");
    expect(row.contactRoute.line).toContain("Apply via https://forchheim.de/");
    expect(row.contactRoute.statusLine).toBe("Application portal, unconfirmed");
  });

  it("marks the application URL verified only when the route was confirmed reachable", () => {
    const verified = {
      ...syntheticEvent({ id: "url-verified", applicationUrl: "https://mainz.de/apply" }),
      application: {
        route: "public_form",
        capacityState: "available",
        lastCheckedAt: null,
        nextCheckAt: null,
        routeReachable: true,
        note: "checked"
      }
    } as unknown as EventOpportunity;

    const { row } = routeFor(verified);
    expect(row.contactRoute.verified).toBe(true);
    expect(row.contactRoute.statusLine).toBe("Application portal, confirmed");
  });

  it("falls back to the organizer website published by an official source", () => {
    const { row } = routeFor(
      syntheticEvent({
        id: "site-route",
        sources: [
          {
            label: "Official market page",
            url: "https://halle.de/maerkte",
            publisher: "Stadt Halle (Saale)",
            official: true,
            observedAt: "2026-07-20T09:00:00+02:00",
            supports: ["dates"]
          }
        ]
      })
    );
    expect(row.contactRoute.kind).toBe("organizer_site");
    expect(row.contactRoute.statusLine).toBe("Organizer website · Stadt Halle (Saale)");
  });

  it("names the listing an event was merely spotted on, without calling it a route", () => {
    const { row } = routeFor(
      syntheticEvent({
        id: "listing-only",
        sources: [
          {
            label: "Event listing",
            url: "https://veranstaltungen.meinestadt.de/dresden/alle/alle",
            publisher: "meinestadt.de",
            official: false,
            observedAt: "2026-07-20T09:00:00+02:00",
            supports: ["dates"]
          }
        ]
      })
    );
    expect(row.contactRoute.kind).toBe("listing_only");
    expect(row.contactRoute.line).toBe(
      "No organizer route recorded — listed on meinestadt.de, contact still to be researched"
    );
    expect(row.contactRoute.statusLine).toBe("Research needed · listed on meinestadt.de");
    // And it costs confidence, because a listing is not a way in.
    expect(row.confidence).toBe("LOW");
  });

  it("says a route is missing only when every rung of the chain is empty", () => {
    const { row } = routeFor(syntheticEvent({ id: "no-route" }));
    expect(row.contactRoute.kind).toBe("none");
    expect(row.contactRoute.line).toBe("No contact route recorded yet");
    expect(row.contactRoute.statusLine).toBe("No route recorded");
  });
});

describe("organizer honesty", () => {
  it("names the official publisher when the organizer itself is unpublished", () => {
    const event = syntheticEvent({
      id: "unpublished-organizer",
      sources: [
        {
          label: "Municipal event calendar",
          url: "https://potsdam.de/veranstaltungen",
          publisher: "Landeshauptstadt Potsdam",
          official: true,
          observedAt: "2026-07-20T09:00:00+02:00",
          supports: ["dates"]
        }
      ]
    });
    const report = buildWeeklyReport(snapshotWith([event]), NOW);
    const row = rowFor(report, event.id);

    expect(row.organizer).toBeUndefined();
    expect(row.organizerLine).toBe("Organizer unpublished — source: Landeshauptstadt Potsdam");
  });

  it("still says nothing is identified when no official source exists either", () => {
    const report = buildWeeklyReport(snapshotWith([syntheticEvent({ id: "nothing" })]), NOW);
    expect(rowFor(report, "nothing").organizerLine).toBe("Not yet identified");
  });

  it("prints the recorded organizer unchanged when there is one", () => {
    const report = buildWeeklyReport(
      snapshotWith([syntheticEvent({ id: "known", organizer: "Stadt Potsdam" })]),
      NOW
    );
    expect(rowFor(report, "known").organizerLine).toBe("Stadt Potsdam");
  });
});

/* ----------------------------------------------- the vendor-relevance gate */

describe("the vendor-relevance gate", () => {
  const NOISE_NAME = "Emporenführung auf Deutsch";

  function withNoise(): ProductSnapshot {
    const base = snapshot();
    const noise = syntheticEvent({
      id: "consumer-calendar-noise",
      name: NOISE_NAME,
      vendorRelevance: "irrelevant",
      applicationState: "open",
      applicationDeadline: "2026-08-01",
      applicationUrl: "https://example.org/apply",
      organizer: "Consumer Calendar"
    });
    return { ...base, events: [...base.events, noise] };
  }

  it("keeps an irrelevant event out of the register and out of every selection", () => {
    const report = buildWeeklyReport(withNoise(), NOW);
    expect(report.register.map((event) => event.name)).not.toContain(NOISE_NAME);
    expect(report.deadlineRadar.map((item) => item.eventName)).not.toContain(NOISE_NAME);
    expect(report.drafts.map((draft) => draft.eventName)).not.toContain(NOISE_NAME);
  });

  it("keeps an irrelevant event out of the rendered brief entirely", () => {
    // Not "rendered as rejected" — absent. A consumer-calendar entry must not
    // occupy a line of the owner's briefing at all.
    expect(renderBriefHtml(buildWeeklyReport(withNoise(), NOW))).not.toContain("Emporenf");
  });

  it("states in the footer how many entries were excluded", () => {
    const report = buildWeeklyReport(withNoise(), NOW);
    expect(report.totals.excludedIrrelevant).toBe(1);
    expect(report.relevanceStatement).toBe(
      "1 consumer-calendar entry (tours, lectures, …) excluded as not vendor-relevant."
    );
    expect(renderBriefHtml(report)).toContain("excluded as not vendor-relevant");
  });

  it("pluralises the footer line and states zero honestly", () => {
    const base = snapshot();
    const two = {
      ...base,
      events: [
        ...base.events,
        syntheticEvent({ id: "noise-a", name: "Sonderführung A", vendorRelevance: "irrelevant" }),
        syntheticEvent({ id: "noise-b", name: "Sonderführung B", vendorRelevance: "irrelevant" })
      ]
    };
    expect(buildWeeklyReport(two, NOW).relevanceStatement).toContain("2 consumer-calendar entries");

    // Zero must still be stated: "nothing was filtered" and "the filter did not
    // run" are different facts, and the reader is entitled to tell them apart.
    const clean = buildWeeklyReport(snapshot(), NOW);
    expect(clean.totals.excludedIrrelevant).toBe(0);
    expect(clean.relevanceStatement).toMatch(/No consumer-calendar entries were excluded/);
  });

  it("does not present a venue string as a place", () => {
    const base = snapshot();
    const report = buildWeeklyReport(
      {
        ...base,
        events: [
          ...base.events,
          syntheticEvent({
            id: "junk-city-event",
            name: "Street Food Festival Test",
            city: "Kirchplatz",
            state: "Federal state unverified"
          })
        ]
      },
      NOW
    );
    const row = rowFor(report, "junk-city-event");
    expect(row.locationVerified).toBe(false);
    expect(row.locationLine).toBe("Location needs verification");
    expect(row.confidence).toBe("LOW");
    expect(renderBriefHtml(report)).not.toContain("Kirchplatz, Federal state unverified");
  });

  it("still prints a real city plainly, including one that collides with a venue stem", () => {
    const base = snapshot();
    const report = buildWeeklyReport(
      {
        ...base,
        events: [
          ...base.events,
          syntheticEvent({
            id: "halle-event",
            name: "Laternenfest Halle",
            city: "Halle",
            state: "Sachsen-Anhalt"
          })
        ]
      },
      NOW
    );
    const row = rowFor(report, "halle-event");
    expect(row.locationVerified).toBe(true);
    expect(row.locationLine).toBe("Halle, Sachsen-Anhalt");
  });

  it("stays byte-identical across builds with the gate in place", () => {
    const first = renderBriefHtml(buildWeeklyReport(withNoise(), NOW));
    const second = renderBriefHtml(buildWeeklyReport(withNoise(), new Date(NOW.getTime())));
    expect(second).toBe(first);
  });
});

/* ================================================================== weather */

describe("weather — only the rows a decision turns on", () => {
  it("says the enrichment has not activated when no weather record exists", () => {
    const report = buildWeeklyReport(snapshot(), NOW);
    expect(report.weatherAllRows).toHaveLength(0);
    expect(report.weatherDecisionRows).toHaveLength(0);
    expect(renderBriefHtml(report)).toContain("No decision this week turns on the weather");
  });

  it("keeps a risk-free forecast out of the brief and in the register", () => {
    const calm = {
      ...syntheticEvent({
        id: "calm",
        name: "Calm Fest",
        startsAt: "2026-07-30T10:00:00+02:00",
        endsAt: "2026-07-30T20:00:00+02:00"
      }),
      weather: { fetchedAt: "2026-07-27T06:00:00+02:00", source: "open-meteo", riskFlags: [] }
    } as unknown as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([calm]), NOW);
    expect(report.weatherAllRows.map((row) => row.eventId)).toContain("calm");
    expect(report.weatherDecisionRows).toHaveLength(0);
  });

  it("keeps a risk flag on an unverified-relevance event out of the brief", () => {
    // Nine theatre performances with a rain flag crowded out the one market
    // that mattered on real W38 data. A forecast on something we have not
    // established as work is not a decision — it stays in the register.
    const theatre = {
      ...syntheticEvent({
        id: "theatre",
        name: "Harry P.Otter und die Zauberprüfung",
        vendorRelevance: "unclear",
        startsAt: "2026-07-30T19:00:00+02:00",
        endsAt: "2026-07-30T21:00:00+02:00"
      }),
      weather: { fetchedAt: "2026-07-27T06:00:00+02:00", source: "open-meteo", riskFlags: ["rain"] }
    } as unknown as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([theatre]), NOW);
    expect(report.weatherAllRows.map((row) => row.eventId)).toContain("theatre");
    expect(report.weatherDecisionRows).toHaveLength(0);
  });

  it("surfaces a risk flag on a shortlisted event inside the forecast window", () => {
    const rainy = {
      ...syntheticEvent({
        id: "rainy",
        name: "Rainy Fest",
        startsAt: "2026-07-30T10:00:00+02:00",
        endsAt: "2026-07-30T20:00:00+02:00",
        expectedVisitors: 150_000,
        organizer: "Stadt Potsdam",
        contactEmail: "markt@example-potsdam.de"
      }),
      weather: { fetchedAt: "2026-07-27T06:00:00+02:00", source: "open-meteo", riskFlags: ["rain", "wind"] }
    } as unknown as EventOpportunity;

    const report = buildWeeklyReport(snapshotWith([rainy]), NOW);
    expect(report.weatherDecisionRows.map((row) => row.eventId)).toContain("rainy");
    const html = renderBriefHtml(report);
    expect(html).toContain("rain, wind");
    expect(html).not.toContain("No decision this week turns on the weather");
  });
});

/* ============================================ the cause behind the label */

describe("confidence carries its cause", () => {
  it("names the publisher the stated basis actually rests on", () => {
    expect(
      confidenceCauseFor({
        confidenceReason: "official source, organizer identified",
        officialPublisher: "Stadt Schwedt/Oder"
      })
    ).toBe("official source (Stadt Schwedt/Oder), organizer identified");
  });

  it("says nothing about the facts still open — those are KEY UNKNOWNS, not a confidence cause", () => {
    // The double penalty, as a test. A row with five open questions and a solid
    // official source reads as solid, because the source is what confidence
    // measures. The open questions are printed where the owner can close them.
    const cause = confidenceCauseFor({
      confidenceReason: "official source, organizer route confirmed reachable",
      officialPublisher: "Stadt Cottbus"
    });
    expect(cause).not.toMatch(/facts? open|still missing|more/);
  });

  it("says only the reason when no official publisher backs it", () => {
    expect(
      confidenceCauseFor({
        confidenceReason: "the recorded location still needs verification"
      })
    ).toBe("the recorded location still needs verification");
  });

  it("prints the cause next to EVERY confidence label on a card", () => {
    // The founder's complaint, as a test: "LOW CONFIDENCE" with no reason is a
    // verdict a reader cannot act on. Every label on a card must be followed by
    // the cause that produced it.
    const report = buildWeeklyReport(snapshot(), NOW);
    const html = renderBriefHtml(report);

    const labels = html.match(/(HIGH|MEDIUM|LOW) CONFIDENCE[^<]*/g) ?? [];
    expect(labels.length).toBeGreaterThan(0);
    labels.forEach((label) => expect(label).toMatch(/CONFIDENCE — $/));

    [...report.actionNow, ...report.topOpportunities].forEach((event) => {
      expect(event.confidenceCause).toBeTruthy();
      expect(html).toContain(
        `${event.confidence} CONFIDENCE — <span class="cause">${event.confidenceCause
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;")}</span>`
      );
    });
  });
});

/* ====================================== evidence-linked routes on cards */

describe("the route is printed as something the owner can act on", () => {
  function briefFor(event: EventOpportunity) {
    const report = buildWeeklyReport(snapshotWith([event]), NOW);
    return { report, html: renderBriefHtml(report) };
  }

  it("renders the application URL as a real href on the card", () => {
    const { html } = briefFor(
      syntheticEvent({
        id: "portal-card",
        name: "Portal Card Event",
        applicationUrl: "https://example-forchheim.de/rathaus-service/service/annafest-bewerbung"
      })
    );
    expect(html).toContain(
      `href="https://example-forchheim.de/rathaus-service/service/annafest-bewerbung"`
    );
    // The label is short; the href is the whole address.
    expect(html).toContain("example-forchheim.de/rathaus-service/…");
  });

  it("renders a named contact as mailto: and tel:, with the person's name", () => {
    const { html } = briefFor(
      syntheticEvent({
        id: "named-card",
        name: "Named Card Event",
        organizer: "Stadt Potsdam",
        contactPerson: "Andrea Weber",
        contactRole: "Marktleitung",
        contactEmail: "markt@example-potsdam.de",
        contactPhone: "+49 30 000 1234",
        contactSourceUrl: "https://example-potsdam.de/impressum",
        contactSourcePublisher: "Stadt Potsdam",
        contactObservedAt: "2026-07-20T09:00:00+02:00"
      })
    );
    expect(html).toContain(`href="mailto:markt@example-potsdam.de"`);
    expect(html).toContain(`href="tel:+49300001234"`);
    expect(html).toContain("Andrea Weber (Marktleitung)");
    // …and the page it was read from, linked, so the claim can be checked.
    expect(html).toContain(`href="https://example-potsdam.de/impressum"`);
    expect(html).toContain("Source:");
  });

  it("a resolved named contact outranks the portal fallback on the card", () => {
    const withPortalOnly = briefFor(
      syntheticEvent({
        id: "fallback-card",
        name: "Fallback Card Event",
        organizer: "Stadt Potsdam",
        applicationUrl: "https://example-potsdam.de/bewerbung"
      })
    );
    expect(withPortalOnly.report.register[0].contactRoute.kind).toBe("application_url");
    expect(withPortalOnly.html).toContain("Apply via");
    expect(withPortalOnly.html).not.toContain("mailto:");

    const resolved = briefFor(
      syntheticEvent({
        id: "fallback-card",
        name: "Fallback Card Event",
        organizer: "Stadt Potsdam",
        applicationUrl: "https://example-potsdam.de/bewerbung",
        contactPerson: "Andrea Weber",
        contactRole: "Ansprechpartner",
        contactEmail: "markt@example-potsdam.de",
        contactSourceUrl: "https://example-potsdam.de/impressum",
        contactObservedAt: "2026-07-20T09:00:00+02:00"
      })
    );
    expect(resolved.report.register[0].contactRoute.kind).toBe("named");
    expect(resolved.html).toContain("Andrea Weber (Ansprechpartner)");
    expect(resolved.html).toContain(`href="mailto:markt@example-potsdam.de"`);
  });

  it("gives every ACTION NOW task its route — a task without one is not actionable", () => {
    // The card is now the TASK, so the route is the organizer's resolved
    // contact: one per card, and never a card without one.
    const report = buildWeeklyReport(snapshot(), NOW);
    const html = renderBriefHtml(report);
    const section = html.slice(html.indexOf(">Action now</h2>"), html.indexOf(">Top opportunities</h2>"));
    expect(report.actionQueue.length).toBeGreaterThan(0);
    expect(section.match(/<span class="k">Contact<\/span>/g)!.length).toBe(report.actionQueue.length);
  });

  it("keeps every raw URL out of the opportunity-radar table", () => {
    // Founder rule: the compact table states WHAT the route is, never prints
    // one. The clickable route belongs on the cards, where it fits.
    const html = renderBriefHtml(buildWeeklyReport(snapshot(), NOW));
    const radar = html.slice(
      html.indexOf(">Opportunity radar</h2>"),
      html.indexOf(">Bookings &amp; conflicts</h2>")
    );
    expect(radar).not.toMatch(/href="https?:/);
    expect(radar).not.toMatch(/https?:\/\//);
  });
});
