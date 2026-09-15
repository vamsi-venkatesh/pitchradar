/**
 * City hygiene.
 *
 * The junk strings below were all found in the `events.city` column of the real
 * 2026-09-15 collection. The negative controls are real German places whose
 * names collide with venue stems — they are the reason the rule tests for a
 * compound SUFFIX rather than a substring.
 */

import { describe, expect, it } from "vitest";
import { inspectCityString, isVenueString } from "./city-hygiene";

/** Values found in the city column that are venues, not places. */
const REAL_JUNK = [
  "Kirchplatz",
  "Hermannplatz",
  "Luisenplatz",
  "Alice-Salomon-Platz",
  "Vorplatz Einkaufszentrum",
  "Alter Messplatz Landau",
  "Marktplatz Groß-Gerau",
  "Freiheitsplatz Hanau",
  "Luitpoldplatz Grünstadt",
  "Bölschestraße",
  "Bölschestraße fRIEDRICHSHAGEN",
  "Brandenburger Straße",
  "Kornmarkt Bad Kreuznach",
  "Mainanlagen Obernburg",
  "Dorfanger Schönefeld",
  "Freilichtbühne Beelitz",
  "Weihnachtsmarkt alt Buckow"
];

/** Real places that must keep working. Several end in a venue stem. */
const REAL_CITIES = [
  "Halle",
  "Halle (Saale)",
  "Stralsund",
  "Frankfurt (Oder)",
  "Berlin",
  "Berlin-Kreuzberg",
  "Berlin, Prenzlauer Berg",
  "Schwedt/Oder",
  "Grünheide (Mark)",
  "Saarbrücken",
  "Lauf an der Pegnitz",
  "Bad Belzig",
  "Neumarkt",
  "Markt Schwaben",
  "Anger",
  "Crimmitschau, OT Blankenhain",
  "Königs Wusterhausen",
  "Reichenbach im Vogtland",
  "Brandenburg an der Havel",
  "Werder (Havel)"
];

describe("venue strings found in the real city column", () => {
  it.each(REAL_JUNK)("refuses %s as a city", (value) => {
    expect(isVenueString(value)).toBe(true);
  });
});

describe("real cities keep working", () => {
  it.each(REAL_CITIES)("accepts %s", (value) => {
    expect(isVenueString(value)).toBe(false);
  });
});

describe("the compound-suffix rule", () => {
  it("separates the city Halle from a Stadthalle", () => {
    // The trap in one pair: same stem, opposite verdicts, and the difference is
    // only that one of them carries a prefix.
    expect(isVenueString("Halle")).toBe(false);
    expect(isVenueString("Stadthalle")).toBe(true);
    expect(isVenueString("Markthalle")).toBe(true);
  });

  it("separates the town Neumarkt from a Kornmarkt", () => {
    // The known-city exception must win over the -markt suffix rule.
    expect(isVenueString("Neumarkt")).toBe(false);
    expect(isVenueString("Kornmarkt")).toBe(true);
  });

  it("condemns a string that mixes a venue with a real city", () => {
    // "Alter Messplatz Landau" holds a town, but a field holding a fairground
    // AND a town is not a city field — and picking which token is the city
    // would be inventing the answer.
    const verdict = inspectCityString("Alter Messplatz Landau");
    expect(verdict.venue).toBe(true);
    expect(verdict.matched).toBe("messplatz");
  });

  it("catches bare stems from hyphenated venue names", () => {
    expect(inspectCityString("Alice-Salomon-Platz").matched).toBe("platz");
  });

  it("names the word that decided, so the verdict can be audited", () => {
    expect(inspectCityString("Kirchplatz")).toEqual({
      venue: true,
      matched: "kirchplatz",
      kind: "venue"
    });
  });
});

describe("a source's own placeholder text is not a place", () => {
  it.each(["Details Folgen", "Änderungen vorbehalten.", "wird noch bekannt gegeben", "TBA"])(
    "refuses %s",
    (value) => {
      const verdict = inspectCityString(value);
      expect(verdict.venue).toBe(true);
      expect(verdict.kind).toBe("placeholder");
    }
  );

  it("does not mistake a real city for a placeholder", () => {
    expect(inspectCityString("Tauche").venue).toBe(false);
  });
});

describe("edge cases", () => {
  it("treats empty and missing values as not-a-venue, leaving the caller's own check", () => {
    expect(isVenueString("")).toBe(false);
    expect(isVenueString(undefined)).toBe(false);
    expect(isVenueString(null)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isVenueString("KIRCHPLATZ")).toBe(true);
    expect(isVenueString("bölschestrasse")).toBe(true);
  });
});
