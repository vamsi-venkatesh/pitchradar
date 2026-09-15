/**
 * Vendor-relevance classifier.
 *
 * The cases below are REAL event names from the 2026-09-15 collection
 * (382 rows, public municipal and tourism calendars), not invented strings.
 * That matters: the defect this module fixes was found in production data, and
 * a rule list tuned against imagined German would not have caught it.
 */

import { describe, expect, it } from "vitest";
import {
  asVendorRelevance,
  classifyVendorRelevance,
  explainVendorRelevance,
  normalizeRelevanceText,
  VENDOR_RELEVANCE_RULE_COUNTS
} from "./vendor-relevance";

/* ------------------------------------------------------- real data, by class */

/** Real names that ARE food-vendor opportunities. */
const REAL_RELEVANT: Array<[string, string]> = [
  ["Street Food Thursday Markthalle Berlin-Kreuzberg", "street_food"],
  ["Foodtruckmeile Siegen", "street_food"],
  ["Weihnachtsmarkt Tempelhofer Hafen", "christmas"],
  ["Trödelmarkt Bad Belzig Turnplatz", "market"],
  ["Bauernmarkt Wittenbergplatz gegenüber dem KaDeWe", "market"],
  ["Hilchenbacher Herbstkirmes", "city_festival"],
  ["Kerwe Niederotterbach", "city_festival"],
  ["Stadtfest Eisenhüttenstadt", "city_festival"],
  ["Delitziöse Abendmärkte", "market"],
  ["Erntedankfest mit Handwerker- und Bauernmarkt in Großderschau", "market"],
  ["Nordberliner Weihnachtsrummel", "christmas"],
  ["Potsdamer Weihnachtszauber", "christmas"],
  ["Herbstbasar der  Freie Waldorfschule Kleinmachnow", "market"],
  ["Prenzlauer Berg kulinarisch | Adventure World Tours", "street_food"]
];

/** Real names that are consumer-calendar programme, not a pitch. */
const REAL_IRRELEVANT: Array<[string, string]> = [
  ["Emporenführung auf Deutsch", "street_food"],
  ["Sonderführung im Klostergarten", "street_food"],
  ["Der besondere Rundgang durch Dresden", "street_food"],
  ["Jüdisches Museum, Ausstellung „In Echt? – Virtuelle Begegnung mit NS-Zeitzeug:innen“", "street_food"],
  ["Wanderausstellung in Cottbus", "street_food"],
  ["Vortrag - Nepal „Wanderungen mit Inspektor Sanjit\"", "street_food"],
  ["LESUNG: \"Bakterien - die heimlichen Helden\"", "street_food"],
  ["Faszination Polarlichter | Planetarium Frankfurt", "street_food"],
  ["Romeo und Julia - Staatstheater Cottbus", "street_food"],
  ["Yoga im Klostergarten 2026", "street_food"],
  ["Bogenbaukurs | Frank Jannack - Kochsatreff", "street_food"],
  ["Creative Writing Workshop | Art House Berlin", "street_food"],
  ["1. FC Magdeburg U23 - Regionalliga Nordost Saison 2026/2027", "street_food"],
  ["Adventskonzert des Nationalparkchores in der Kirche Criewen", "street_food"],
  ["Bilderbuchkino", "street_food"],
  ["6. Cottbuser Boxnight", "street_food"]
];

/** Real names the rules genuinely cannot decide. "unclear" is the honest answer. */
const REAL_UNCLEAR: Array<[string, string]> = [
  ["21. Kranichtage · Weekend 1", "market"],
  ["Köpenicker Herbst", "street_food"],
  ["Westerntreffen Wershofen", "city_festival"],
  ["Tag der Sachsen 2027", "city_festival"],
  ["Galmer Kranzstechen", "market"],
  ["Philharmonische Konzerte - Brandenburgisches Staatsorchester", "street_food"]
];

describe("classifyVendorRelevance over real 2026-09-15 collection rows", () => {
  it.each(REAL_RELEVANT)("treats %s as a vendor opportunity", (name, category) => {
    expect(classifyVendorRelevance(name, category)).toBe("relevant");
  });

  it.each(REAL_IRRELEVANT)("excludes %s as consumer-calendar noise", (name, category) => {
    expect(classifyVendorRelevance(name, category)).toBe("irrelevant");
  });

  it.each(REAL_UNCLEAR)("says unclear rather than guess for %s", (name, category) => {
    expect(classifyVendorRelevance(name, category)).toBe("unclear");
  });
});

/* ----------------------------------------------------------- the precedence */

describe("a strong market or food token beats an irrelevant one", () => {
  it("keeps a Kunstmarkt that happens to stand next to a museum", () => {
    // Real row. "Museumsinsel" is the address, "Kunstmarkt" is the event.
    const verdict = explainVendorRelevance("Berliner Kunstmarkt an der Museumsinsel", "market");
    expect(verdict.relevance).toBe("relevant");
    expect(verdict.irrelevantSignals).toContain("museum");
    expect(verdict.strongSignals).toContain("markt");
  });

  it("keeps a Kunstmarkt announced by a gallery", () => {
    // Real row: the publisher is a gallery, the event is still a market.
    expect(
      classifyVendorRelevance("Galerie am Kietz: Vorweihnachtlicher Kunstmarkt", "street_food")
    ).toBe("relevant");
  });

  it("keeps a festival held in the town of Lauf", () => {
    // Real row. "Lauf" is a Bavarian town; the wordEnd rule for races must not
    // outrank the food-truck festival that is plainly the event.
    const verdict = explainVendorRelevance("Food Truck Festival Lauf 2026", "street_food");
    expect(verdict.relevance).toBe("relevant");
    expect(verdict.irrelevantSignals).toContain("lauf");
  });

  it("would keep a Museumsfest — the Fest is the event, the museum the venue", () => {
    expect(classifyVendorRelevance("Museumsfest Magdeburg", "city_festival")).toBe("relevant");
  });

  it("excludes an Emporenführung, which carries no market token at all", () => {
    const verdict = explainVendorRelevance("Emporenführung auf Deutsch", "street_food");
    expect(verdict.relevance).toBe("irrelevant");
    expect(verdict.strongSignals).toHaveLength(0);
    expect(verdict.irrelevantSignals).toContain("führung");
  });
});

describe("a weak relevant token does NOT beat an irrelevant one", () => {
  it("still excludes Regionalliga football despite the word regional", () => {
    const verdict = explainVendorRelevance(
      "1. FC Magdeburg U23 - Regionalliga Nordost Saison 2026/2027",
      "street_food"
    );
    expect(verdict.relevance).toBe("irrelevant");
    expect(verdict.weakSignals).toContain("regional");
    expect(verdict.irrelevantSignals).toContain("liga");
  });

  it("accepts a regional market when nothing contradicts it", () => {
    // Real row, and the reason the weak tier exists rather than dropping the token.
    const verdict = explainVendorRelevance("Radikal Regional in Glashütte", "market");
    expect(verdict.relevance).toBe("relevant");
    expect(verdict.strongSignals).toHaveLength(0);
    expect(verdict.weakSignals).toContain("regional");
  });
});

/* ------------------------------------------------------- the Messe ambiguity */

describe("Messe is a trade fair or a church mass, decided on context only", () => {
  it("treats a Hobbymesse as a vendor opportunity", () => {
    // Real row, stored under category market.
    expect(classifyVendorRelevance("Hobbymesse Leipzig", "market")).toBe("relevant");
  });

  it("treats a Messe in a market category as a fair", () => {
    expect(classifyVendorRelevance("Frühjahrsmesse", "market")).toBe("relevant");
  });

  it("excludes a Messe in a church context", () => {
    const verdict = explainVendorRelevance("Heilige Messe in der Kirche St. Marien", "street_food");
    expect(verdict.relevance).toBe("irrelevant");
    expect(verdict.irrelevantSignals).toContain("messe (church context)");
  });

  it("stays unclear for a bare Messe with no context either way", () => {
    expect(classifyVendorRelevance("Messe", "sports")).toBe("unclear");
  });
});

describe("Konzert is only excluded in a church context", () => {
  it("excludes a church concert", () => {
    expect(
      classifyVendorRelevance(
        "Gemeinsames Konzert der Schwedter Chöre in der evangelischen Kirche",
        "street_food"
      )
    ).toBe("irrelevant");
  });

  it("does not exclude a concert with no church context", () => {
    // A concert on a market square is a perfectly good pitch; the honest
    // verdict when nothing else is known is "unclear", never "irrelevant".
    expect(
      classifyVendorRelevance("Philharmonische Konzerte - Brandenburgisches Staatsorchester", "street_food")
    ).toBe("unclear");
  });

  it("keeps a Chorfest, which is a festival whatever the choir sings", () => {
    expect(classifyVendorRelevance("Internationales Chorfest Magdeburg 2026", "street_food")).toBe(
      "relevant"
    );
  });
});

/* ----------------------------------------------------------------- mechanics */

describe("matching mechanics", () => {
  it("matches compound stems inside German compounds", () => {
    // The whole reason `contains` exists: word-boundary matching finds neither.
    expect(classifyVendorRelevance("Sonderführungen - Klostergelände")).toBe("irrelevant");
    expect(classifyVendorRelevance("Weihnachtsmarkt Heidenau")).toBe("relevant");
  });

  it("does not let a venue word ending in -fest hijack a relevance verdict", () => {
    // "Festwiese" and "Festsaal" are places, not events. Both real: the
    // collection holds "Kreativmarkt an der Festwiese / Jahnallee Leipzig".
    const verdict = explainVendorRelevance("Führung über die Festwiese", "street_food");
    expect(verdict.strongSignals).not.toContain("fest");
    expect(verdict.relevance).toBe("irrelevant");
  });

  it("normalizes case, ß and punctuation while keeping umlauts", () => {
    expect(normalizeRelevanceText("Straßenfest, Grün-Heide!")).toBe("strassenfest grün heide");
  });

  it("is case-insensitive on real rows that shout", () => {
    // Real row, spelled exactly this way in the source.
    expect(classifyVendorRelevance("Street Food Festival bEELITZ", "street_food")).toBe("relevant");
  });

  it("returns unclear for empty text rather than inventing a verdict", () => {
    expect(classifyVendorRelevance("")).toBe("unclear");
    expect(classifyVendorRelevance("   ")).toBe("unclear");
  });

  it("reads a description when one is recorded", () => {
    expect(
      classifyVendorRelevance("Sommerprogramm", "street_food", "Geführter Rundgang durch die Altstadt")
    ).toBe("irrelevant");
  });

  it("narrows stored values honestly, defaulting to unclear", () => {
    expect(asVendorRelevance("relevant")).toBe("relevant");
    expect(asVendorRelevance("irrelevant")).toBe("irrelevant");
    expect(asVendorRelevance(null)).toBe("unclear");
    expect(asVendorRelevance("nonsense")).toBe("unclear");
  });

  it("is deterministic — the same input always gives the same verdict", () => {
    const name = "Street Food Festival Chemnitz";
    const first = classifyVendorRelevance(name, "street_food");
    for (let index = 0; index < 5; index += 1) {
      expect(classifyVendorRelevance(name, "street_food")).toBe(first);
    }
  });

  it("carries non-empty rule lists", () => {
    expect(VENDOR_RELEVANCE_RULE_COUNTS.strongRelevant).toBeGreaterThan(20);
    expect(VENDOR_RELEVANCE_RULE_COUNTS.irrelevant).toBeGreaterThan(40);
    expect(VENDOR_RELEVANCE_RULE_COUNTS.weakRelevant).toBeGreaterThan(0);
  });
});

describe("the category is not a relevance signal", () => {
  it("excludes a guided tour even though it is stored as street_food", () => {
    // The defect in one line. The normalizer defaults unrecognised occurrences
    // to street_food, so the category agrees with the noise, not with reality.
    expect(classifyVendorRelevance("Emporenführung auf Deutsch", "street_food")).toBe("irrelevant");
  });

  it("gives the same verdict whatever the stored category claims", () => {
    for (const category of ["street_food", "market", "city_festival", "sports", "christmas"]) {
      expect(classifyVendorRelevance("Sonderführung im Klostergarten", category)).toBe("irrelevant");
    }
  });
});
