/**
 * PitchRadar — city hygiene.
 *
 * THE DEFECT THIS FIXES. Source rows carry a "location" that is sometimes a
 * city and sometimes the venue inside it. When a venue string reaches the city
 * column the product prints a place that does not exist: the real 2026-09-15
 * collection stored "Kirchplatz, Federal state unverified" and "Vorplatz
 * Einkaufszentrum" as cities, and "Alter Messplatz Landau" (a fairground, with
 * the actual city trailing behind it).
 *
 * THE RULE, and the trap inside it. German venue words are compound suffixes:
 * Kirch+platz, Stadt+halle, Markt+platz, Schloss+park, Linden+allee. But
 * several of those stems are ALSO complete city names on their own — Halle is
 * a city of 240,000 people, and Park, Markt and Brück begin real place names.
 * So the check fires only on a stem that ENDS A LONGER WORD: "Stadthalle" is a
 * venue, "Halle" is a city, and the difference is the prefix. A handful of
 * strings are venues even standing alone (Marktplatz, Einkaufszentrum) and are
 * listed separately.
 *
 * What happens to a row that fails is the honest path that already exists: the
 * occurrence is kept out, with the reason recorded. Nothing is invented — the
 * product never guesses a city it cannot read from the source.
 */

/**
 * Venue stems that mark a venue ONLY when they end a longer word.
 * "Kirchplatz" is a square; "Halle" is a city.
 */
const VENUE_SUFFIXES = [
  "platz",
  "straße",
  "strasse",
  "weg",
  "gasse",
  "allee",
  "halle",
  "hallen",
  "kirche",
  "museum",
  "park",
  "zentrum",
  "center",
  "centrum",
  "stadion",
  "arena",
  "saal",
  "garten",
  "ufer",
  "brücke",
  "bruecke",
  "bühne",
  "buehne",
  "anlage",
  "anlagen",
  "anger",
  // "markt" catches the fairground squares ("Kornmarkt") and the event names
  // that leaked into the city column ("Weihnachtsmarkt alt Buckow"). Real
  // towns built on the same stem are held in KNOWN_CITY_EXCEPTIONS below.
  "markt"
];

/**
 * Strings that are a venue even standing alone.
 *
 * Two groups. The first is whole venue words. The second is the bare stems
 * German hyphenates rather than fuses — "Alice-Salomon-Platz" splits into
 * "platz" as its own token, so the suffix rule never sees a compound. Only
 * stems that are not themselves place names may go here: "platz" is safe,
 * "halle" and "park" are not.
 */
const STANDALONE_VENUES = [
  "marktplatz",
  "kirchplatz",
  "einkaufszentrum",
  "messplatz",
  "festplatz",
  "rathaus",
  "schloss",
  "bahnhof",
  "flughafen",
  "innenstadt",
  "altstadt",
  "gelände",
  "gelaende",
  // Bare stems from hyphenated venue names.
  "platz",
  "straße",
  "strasse",
  "gasse",
  "allee",
  "kirche",
  "stadion",
  "arena",
  "ufer",
  "bühne",
  "buehne"
];

/**
 * Real places whose names end in a venue stem. Checked BEFORE the suffix rule,
 * which is the "known-city map wins" clause: Neumarkt in der Oberpfalz is a
 * town of 40,000, not a market square.
 */
const KNOWN_CITY_EXCEPTIONS = ["neumarkt", "altenmarkt", "friedrichsmarkt"];

/**
 * Placeholder text that a source published where a city belongs. These are not
 * venues and not misreadings — they are the calendar telling us it does not
 * know yet. Printing them as a place would be inventing one.
 */
const PLACEHOLDERS = [
  "details folgen",
  "änderungen vorbehalten",
  "anderungen vorbehalten",
  "wird bekannt gegeben",
  "wird noch bekannt gegeben",
  "steht noch nicht fest",
  "tba",
  "tbd",
  "unbekannt",
  "n a"
];

const LETTER = "a-zäöüß";

/** Lowercase and collapse punctuation; umlauts and ß are kept as written. */
function normalize(value: string): string {
  return value.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Split into words on anything that is not a German letter or digit. */
function words(value: string): string[] {
  return normalize(value)
    .split(new RegExp(`[^${LETTER}0-9]+`))
    .filter(Boolean);
}

/**
 * True when `word` ends with `suffix` AND carries a prefix before it — the
 * compound test that separates "Stadthalle" (venue) from "Halle" (city).
 */
function isSuffixCompound(word: string, suffix: string): boolean {
  return word.length > suffix.length && word.endsWith(suffix);
}

export interface VenueVerdict {
  venue: boolean;
  /** The word that triggered the verdict, so a decision can be explained. */
  matched?: string;
  /** Why it was refused: a venue string, or a source's own placeholder text. */
  kind?: "venue" | "placeholder";
}

/**
 * Does this string look like a venue rather than a city?
 *
 * Note the deliberate asymmetry: ANY word of a multi-word string being a venue
 * compound condemns the whole string. "Alter Messplatz Landau" contains a real
 * city, but a field holding a fairground plus a city is not a city field, and
 * guessing which token is the city is exactly the invention this product
 * forbids.
 */
export function inspectCityString(value: string): VenueVerdict {
  const tokens = words(value);
  if (tokens.length === 0) return { venue: false };

  const collapsed = tokens.join(" ");
  const placeholder = PLACEHOLDERS.find(
    (text) => collapsed === text || collapsed.startsWith(`${text} `)
  );
  if (placeholder) return { venue: true, matched: placeholder, kind: "placeholder" };

  for (const token of tokens) {
    // The known-city map wins over the suffix rule, never the other way round.
    if (KNOWN_CITY_EXCEPTIONS.includes(token)) continue;
    if (STANDALONE_VENUES.includes(token)) return { venue: true, matched: token, kind: "venue" };
    for (const suffix of VENUE_SUFFIXES) {
      if (isSuffixCompound(token, suffix)) return { venue: true, matched: token, kind: "venue" };
    }
  }
  return { venue: false };
}

/** Convenience predicate over {@link inspectCityString}. */
export function isVenueString(value: string | undefined | null): boolean {
  return value ? inspectCityString(value).venue : false;
}

/** The reason recorded when a source row's only city candidate is a venue. */
export const NO_VERIFIABLE_CITY_NOTE =
  "No verifiable city: the source row's city field carries a venue string, not a place name.";

/** What the report prints instead of a venue string it must not present as a place. */
export const LOCATION_NEEDS_VERIFICATION = "Location needs verification";
