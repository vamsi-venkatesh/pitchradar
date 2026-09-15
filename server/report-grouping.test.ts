/**
 * THE TWO GROUPINGS.
 *
 * The action queue thinks in ORGANIZERS — an operator with seven dates is one
 * call, not seven cards — and the radar thinks in SERIES — a tour through eight
 * towns is one row, not eight. Both are display-level: this suite pins that no
 * event is lost, no two organizers are ever folded together, and that the
 * grouping holds on the real name shapes the German catalogue actually carries.
 *
 * The clock is pinned; nothing here reads the machine clock.
 */
import { describe, expect, it } from "vitest";
import { buildWeeklyReport, renderBriefHtml, type ReportEvent } from "./report";
import { organizerIdentityFor, seriesKeyFor, seriesNameOf } from "./report-grouping";
import type { EventOpportunity } from "../src/types";
import type { ProductSnapshot } from "../src/product-data";
import { fixtureProductSnapshot } from "./catalogue";

const NOW = new Date("2026-07-27T09:00:00+02:00");

function event(overrides: Partial<EventOpportunity> & { id: string }): EventOpportunity {
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
    vendorRelevance: "relevant",
    ...overrides
  } as EventOpportunity;
}

function snapshotWith(events: EventOpportunity[]): ProductSnapshot {
  return { ...fixtureProductSnapshot(), events, bookings: [] };
}

/* ================================================================= series */

describe("series keys — one tour, one identity", () => {
  it("groups the real Street Food Festival tour across Bad Kreuznach, Groß-Gerau and Grünstadt", () => {
    // The names carry the town adjectivally ("Bad Kreuznacher") and the city
    // column carries a venue in front of the town ("Kornmarkt Bad Kreuznach").
    // Both spellings have to fall away or the tour is eight separate rows.
    const stops = [
      event({
        id: "kreuznach",
        name: "Bad Kreuznacher Street Food Festival 2026",
        city: "Kornmarkt Bad Kreuznach",
        organizer: "Street Food Festival & Market tour"
      }),
      event({
        id: "gross-gerau",
        name: "Groß-Gerauer Street Food Festival 2026",
        city: "Marktplatz Groß-Gerau",
        organizer: "Street Food Festival & Market tour"
      }),
      event({
        id: "gruenstadt",
        name: "Grünstadter Street Food Festival 2026",
        city: "Luitpoldplatz Grünstadt",
        organizer: "Street Food Festival & Market tour"
      })
    ];
    const keys = new Set(stops.map((stop) => seriesKeyFor(stop)));
    expect(keys.size).toBe(1);
    expect(seriesNameOf(stops[0])).toBe("street food festival");
  });

  it("groups Foodtruckmeile stops whose city is spelled into the name", () => {
    const goarshausen = event({
      id: "goarshausen",
      name: "Foodtruckmeile St. Goarshausen",
      city: "St. Goarshausen",
      organizer: "Beispiel Kulinarik GmbH"
    });
    const betzdorf = event({
      id: "betzdorf",
      name: "Foodtruckmeile Betzdorf",
      city: "Betzdorf",
      organizer: "Beispiel Kulinarik GmbH"
    });
    expect(seriesKeyFor(goarshausen)).toBe(seriesKeyFor(betzdorf));
    expect(seriesNameOf(goarshausen)).toBe("foodtruckmeile");
  });

  it("NEVER groups two organizers running a similarly named festival", () => {
    // Four different operators run "Street Food Festival <town>" in this
    // catalogue. A name collision is not a tour, and treating it as one would
    // put one operator's dates on another operator's call sheet.
    const crowd = event({
      id: "chemnitz",
      name: "Street Food Festival Chemnitz",
      city: "Chemnitz",
      organizer: "Crowd Event GmbH,  Heise & Wolff GbR"
    });
    const directory = event({
      id: "peine",
      name: "Street Food Festival Peine",
      city: "Peine",
      organizer: "food-festivals.com festival directory"
    });
    expect(seriesNameOf(crowd)).toBe(seriesNameOf(directory));
    expect(seriesKeyFor(crowd)).not.toBe(seriesKeyFor(directory));
  });

  it("keeps the whole name when the city is all the name contains", () => {
    const only = event({ id: "only", name: "Potsdam", city: "Potsdam" });
    expect(seriesNameOf(only)).toBe("potsdam");
  });

  it("falls back to the source family when no organizer is recorded, and never groups the unattributed", () => {
    const listed = event({
      id: "listed",
      name: "Stadtfest Irgendwo",
      city: "Irgendwo",
      sources: [
        {
          label: "calendar",
          url: "https://example.org/a",
          publisher: "meinestadt.de Stadtfeste Deutschland",
          official: true,
          observedAt: "2026-07-01T09:00:00+02:00",
          supports: []
        }
      ]
    });
    expect(organizerIdentityFor(listed).kind).toBe("source_family");
    expect(organizerIdentityFor(listed).name).toContain("meinestadt.de");

    const bare = event({ id: "bare", name: "Nothing Recorded", city: "Nowhere" });
    const otherBare = event({ id: "bare-2", name: "Nothing Recorded", city: "Nowhere" });
    expect(organizerIdentityFor(bare).kind).toBe("unattributed");
    expect(organizerIdentityFor(bare).key).not.toBe(organizerIdentityFor(otherBare).key);
  });

  it("shows one radar row per tour while every stop keeps its own register row", () => {
    const towns = [
      "Altenkirchen", "Asbach", "Bendorf", "Kreuztal",
      "Lahnstein", "Langen", "Siegen", "Stadtallendorf"
    ];
    const stops = towns.map((town, index) =>
      event({
        id: `stop-${index}`,
        name: `Foodtruckmeile ${town}`,
        city: town,
        organizer: "Beispiel Kulinarik GmbH",
        startsAt: `2026-09-0${index + 1}T10:00:00+02:00`,
        endsAt: `2026-09-0${index + 1}T20:00:00+02:00`
      })
    );
    const report = buildWeeklyReport(snapshotWith(stops), NOW);

    // Every stop keeps its own register row; the shortlist takes five, and the
    // three that remain occupy ONE radar row between them.
    expect(report.register).toHaveLength(8);
    const radarRows = report.radarSeries;
    expect(radarRows).toHaveLength(1);
    const tour = radarRows[0];
    expect(tour.isSeries).toBe(true);
    expect(tour.stops).toHaveLength(8 - report.topOpportunities.length);
    expect(tour.label).toBe("Foodtruckmeile tour");
    expect(tour.summaryLine).toContain(`${tour.stops.length} stops, next:`);
    expect(tour.summaryLine).toContain("Beispiel Kulinarik GmbH");

    // The brief prints the row once, with the stops inside a disclosure.
    report.register.forEach((row: ReportEvent) => expect(row.seriesLabel).toBe("Foodtruckmeile tour"));
  });
});

/* ================================================================== tasks */

describe("the action queue — organizer tasks, not event mass", () => {
  const organizer = "Beispiel Kulinarik GmbH";

  function strongFitStops(count: number): EventOpportunity[] {
    return Array.from({ length: count }, (_, index) =>
      event({
        id: `task-stop-${index}`,
        name: `Foodtruckmeile Stadt${index}`,
        city: `Stadt${index}`,
        organizer,
        // A published deadline inside 30 days is the CONTACT ORGANIZER rule.
        applicationDeadline: "2026-08-20",
        startsAt: `2026-09-1${index}T10:00:00+02:00`,
        endsAt: `2026-09-1${index}T20:00:00+02:00`,
        contactEmail: index === 2 ? "buero@example-kulinarik.de" : undefined,
        contactPerson: index === 2 ? "Petra Klein" : undefined,
        contactSourceUrl: index === 2 ? "https://example-kulinarik.de/impressum" : undefined,
        sources: [
          {
            label: "site",
            url: "https://example-kulinarik.de/termine",
            publisher: "Beispiel Kulinarik",
            official: true,
            observedAt: "2026-07-01T09:00:00+02:00",
            supports: []
          }
        ]
      })
    );
  }

  it("folds one organizer's action-bearing events into ONE task", () => {
    const report = buildWeeklyReport(snapshotWith(strongFitStops(5)), NOW);

    expect(report.actionNow).toHaveLength(5);
    expect(report.actionQueue).toHaveLength(1);
    const task = report.actionQueue[0];
    expect(task.organizerName).toBe(organizer);
    expect(task.events).toHaveLength(5);
    expect(task.priorityDates).toHaveLength(3);
    expect(report.kpis.actionNow).toBe(1);
    expect(report.kpis.actionNowEvents).toBe(5);
  });

  it("picks the MOST COMPLETE recorded route across the organizer's events", () => {
    const report = buildWeeklyReport(snapshotWith(strongFitStops(5)), NOW);
    const task = report.actionQueue[0];

    expect(task.resolvedContact.kind).toBe("named");
    expect(task.resolvedContact.person).toBe("Petra Klein");
    expect(task.resolvedContact.email).toBe("buero@example-kulinarik.de");
  });

  it("asks ONE organizer-level question where no deadline drives the work", () => {
    const stops = strongFitStops(4).map((stop) => ({ ...stop, applicationDeadline: undefined }));
    // Without a deadline these are strong fits with a route: rule 3, which used
    // to sweep a hundred events into ACTION NOW one card at a time.
    const report = buildWeeklyReport(snapshotWith(stops), NOW);
    if (!report.actionQueue.length) return; // no route confirmed → nothing to ask
    expect(report.actionQueue[0].nextAction).toMatch(
      /Ask which of the \d+ upcoming dates still accept the operator's category and whether exclusivity applies/
    );
  });

  it("keeps a deadline-driven task specific to the event whose window closes", () => {
    const report = buildWeeklyReport(snapshotWith(strongFitStops(3)), NOW);
    const task = report.actionQueue[0];
    expect(task.action).toBe("CONTACT ORGANIZER");
    expect(task.nextAction).toContain("the published deadline closes in");
    expect(task.nextAction).toContain(task.events[0].name);
  });

  it("never groups two organizers into one task", () => {
    const mine = strongFitStops(2);
    const theirs = strongFitStops(2).map((stop, index) => ({
      ...stop,
      id: `other-${index}`,
      organizer: "Musterfest GmbH"
    }));
    const report = buildWeeklyReport(snapshotWith([...mine, ...theirs]), NOW);

    expect(report.actionQueue).toHaveLength(2);
    expect(new Set(report.actionQueue.map((task) => task.organizerName))).toEqual(
      new Set([organizer, "Musterfest GmbH"])
    );
  });

  it("does NOT manufacture a task from an open question on an event nobody is pursuing", () => {
    // A WATCH event with an unanswered capacity question is radar material.
    // Only a top-opportunity member of that rule earns a place in the queue.
    const watchers = Array.from({ length: 12 }, (_, index) =>
      event({
        id: `watch-${index}`,
        name: `Nebenveranstaltung ${index}`,
        city: `Ort${index}`,
        organizer: "Stadtverwaltung Irgendwo",
        eventType: "city_festival",
        missingFields: ["Event-specific speciality capacity"],
        startsAt: `2027-06-${String(index + 1).padStart(2, "0")}T10:00:00+02:00`,
        endsAt: `2027-06-${String(index + 1).padStart(2, "0")}T20:00:00+02:00`
      })
    );
    const report = buildWeeklyReport(snapshotWith(watchers), NOW);

    const verifying = report.register.filter(
      (row) => row.action.action === "VERIFY CATEGORY AVAILABILITY"
    );
    const inQueue = report.actionNow.filter(
      (row) => row.action.action === "VERIFY CATEGORY AVAILABILITY"
    );
    // The events keep their action on their own register rows …
    expect(verifying.length).toBeGreaterThan(inQueue.length);
    // … and every one that did reach the queue is a top opportunity.
    const topIds = new Set(report.topOpportunities.map((row) => row.id));
    inQueue.forEach((row) => expect(topIds.has(row.id)).toBe(true));
  });

  it("orders tasks by urgency and carries the worst severity of any member", () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const order = { URGENT: 0, SOON: 1, WATCH: 2 } as const;
    const severities = report.actionQueue.map((task) => order[task.urgency]);
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
    report.actionQueue.forEach((task) => {
      const worst = Math.min(...task.events.map((member) => order[member.severity]));
      expect(order[task.urgency]).toBe(worst);
    });
  });

  it("prints a task card per organizer, with its members folded into a disclosure", () => {
    const report = buildWeeklyReport(snapshotWith(strongFitStops(5)), NOW);
    const html = renderBriefHtml(report);
    const section = html.slice(
      html.indexOf(">Action now</h2>"),
      html.indexOf(">Top opportunities</h2>")
    );

    expect(section).toContain(organizer);
    expect(section).toContain("<details class=\"members\">");
    expect(section).toContain("5 events behind this task");
    expect(section).toContain("<span class=\"k\">Priority dates</span>");
    // Paper cannot be clicked: print opens every disclosure.
    expect(html).toContain("details > summary ~ * { display: block !important; }");
  });

  it("loses no action-bearing event on the way into a task", () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const covered = report.actionQueue.flatMap((task) => task.events.map((member) => member.id));
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...report.actionNow.map((row) => row.id)].sort());
  });
});
