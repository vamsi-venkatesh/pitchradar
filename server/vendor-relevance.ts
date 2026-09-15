/**
 * PitchRadar — vendor-relevance classifier.
 *
 * THE PRODUCT LAW THIS ENFORCES (AGENT_OPERATING_MODEL.md): an event in a
 * consumer calendar is not automatically a food-vendor opportunity. Municipal
 * and tourism calendars are Layer 1 census sources — they answer "where and
 * when?" for EVERY public happening in a city, which means a guided church
 * tour, a planetarium show and a Weihnachtsmarkt arrive through the same feed
 * in the same shape. Without this gate they also rank in the same list.
 *
 * WHY THIS IS NOT A CATEGORY CHECK. `events.event_type` cannot carry this
 * decision. The normalizer defaults an unrecognised occurrence to
 * `"street_food"` (see `server/normalizer.ts`), so in the real 2026-09-15
 * collection "Emporenführung auf Deutsch" and "Jüdisches Museum, Ausstellung"
 * are both stored as street_food. The category is therefore evidence of
 * nothing here, and this module reads it for exactly one narrowly-scoped
 * decision (the Messe ambiguity below) and never as a relevance signal.
 *
 * THE RULE, in order:
 *   1. A strong food/market token ("markt", "fest", "street food", …) makes an
 *      event relevant even when an irrelevant token is also present. A
 *      "Museumsfest" is a vendor opportunity; the museum is the venue, the
 *      Fest is the event. Likewise "Berliner Kunstmarkt an der Museumsinsel"
 *      and "Galerie am Kietz: Vorweihnachtlicher Kunstmarkt" — both carry a
 *      real market and a red-herring venue word.
 *   2. Otherwise an irrelevant token decides: "Emporenführung auf Deutsch" has
 *      a Führung and no market token at all, so it is not a vendor opportunity.
 *   3. A weak relevant token ("regional", "bauern", …) marks relevance but does
 *      NOT beat an irrelevant token — "Regionalliga" is football, not a
 *      regional market.
 *   4. Nothing matched → "unclear". Unclear is an honest verdict, not a
 *      failure: the ranking deducts for it and the report tags it, but it is
 *      never silently dropped the way an irrelevant row is.
 *
 * Deterministic and offline by construction: keyword rules over the event's own
 * recorded text. No model, no network, no clock.
 */

/** The three verdicts. `unclear` is the honest default, never a guess. */
export type VendorRelevance = "relevant" | "irrelevant" | "unclear";

export const VENDOR_RELEVANCE_VALUES: readonly VendorRelevance[] = [
  "relevant",
  "irrelevant",
  "unclear"
];

/**
 * How a token is allowed to match German text.
 *
 * `contains` — anywhere in the string. Correct for the long compound-forming
 *   stems German builds words from: "führung" must match inside
 *   "Emporenführung" and "Sonderführungen", "markt" inside "Weihnachtsmarkt"
 *   and "Trödelmarkt". A plain word-boundary match would miss every one of
 *   them, which is precisely the noise this module exists to catch.
 * `wordEnd` — the token ends a word. For short stems whose false friends put
 *   them mid-word: "kurs" must catch "Bogenbaukurs" but the mode is what keeps
 *   the rule honest about where it looked.
 * `word` — standalone word only. For stems too short or too common to match
 *   inside compounds at all.
 */
type MatchMode = "contains" | "wordEnd" | "word";

interface Rule {
  token: string;
  mode?: MatchMode;
  /**
   * A regex alternation of continuations that must NOT follow the token. This
   * is how "fest" stays usable: it has to match Stadtfest, Weinfest, Kirmes-
   * adjacent Volksfest and Festival, while refusing "Festwiese" and "Festsaal"
   * (venues) and "Festspiele" (a theatre season).
   */
  notFollowedBy?: string;
}

/** German letters after normalisation (ß has already become "ss"). */
const LETTER = "a-zäöü0-9";

function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(rule: Rule): RegExp {
  const token = escapeToken(rule.token);
  const guard = rule.notFollowedBy ? `(?!${rule.notFollowedBy})` : "";
  switch (rule.mode ?? "contains") {
    case "word":
      return new RegExp(`(?<![${LETTER}])${token}${guard}(?![${LETTER}])`);
    case "wordEnd":
      return new RegExp(`${token}${guard}(?![${LETTER}])`);
    default:
      return new RegExp(`${token}${guard}`);
  }
}

/**
 * Lowercase, fold ß to "ss", and reduce every run of non-letters to one space.
 * Umlauts are deliberately KEPT: they carry meaning in these stems and folding
 * them would merge distinct words. Where a source might spell a stem either
 * way, both spellings are listed in the rule tables instead.
 */
export function normalizeRelevanceText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFC")
    .replace(/ß/g, "ss")
    .replace(/[^a-zäöü0-9]+/g, " ")
    .trim();
}

/* --------------------------------------------------------------- the rules */

/**
 * STRONG relevant tokens — a real market, fair, funfair or food event. These
 * beat any irrelevant token (rule 1 above).
 *
 * Every entry below was chosen against the 382 rows of the 2026-09-15
 * collection, not from a general German word list.
 */
const STRONG_RELEVANT: Rule[] = [
  // Markets, in every compound the collection actually produced: Wochenmarkt,
  // Bauernmarkt, Flohmarkt, Trödelmarkt, Kunstmarkt, Töpfermarkt, Regional-
  // markt, Kreativmarkt, Lunchmarkt, Herbstmarkt, Martinsmarkt, Antikmarkt,
  // Kunsthandwerkermarkt, Markthalle, Markttag.
  { token: "markt" },
  { token: "märkt" },
  { token: "maerkt" },

  // Fest/Festival. The guard list is the set of false friends that appeared or
  // could plausibly appear as venue or non-vendor words.
  { token: "fest", notFollowedBy: "wiese|saal|spiel|halle|platz|ung|legen|nahme|stell" },
  { token: "festival" },

  // Street food and food trucks — the client's own category.
  { token: "street food" },
  { token: "streetfood" },
  { token: "food truck" },
  { token: "foodtruck" },
  { token: "food festival" },
  { token: "food markt" },

  // Fairs, funfairs and their regional names.
  { token: "kirmes" },
  { token: "kerwe" },
  { token: "kirchweih" },
  { token: "rummel" },
  { token: "jahrmarkt" },
  { token: "basar" },
  { token: "bazar" },

  // Christmas and Advent trading, which German calendars name many ways.
  { token: "weihnachtsmarkt" },
  { token: "adventsmarkt" },
  { token: "weihnachtszauber" },
  { token: "weihnachtsrummel" },
  { token: "weihnachtsrodeo" },
  { token: "winterlichter" },

  // Explicitly culinary framing.
  { token: "kulinarisch" },
  { token: "kulinarik" },
  { token: "schlemmer" },
  { token: "erntedank" }
];

/**
 * WEAK relevant tokens — they indicate a market-ish event but must not
 * override an irrelevant signal (rule 3). "Regionalliga" is the case that
 * forces this tier to exist: "regional" is genuinely a market word and
 * genuinely appears inside a football league's name.
 */
const WEAK_RELEVANT: Rule[] = [
  { token: "regional" },
  { token: "bauern" },
  { token: "kunsthandwerk" },
  { token: "töpfer" },
  { token: "toepfer" },
  { token: "trödel" },
  { token: "troedel" },
  { token: "winzer" },
  { token: "weinprobe" },
  { token: "hofladen" }
];

/**
 * IRRELEVANT tokens — consumer-calendar programme. Guided tours, exhibitions,
 * lectures, courses, worship, stage and screen, and sport fixtures.
 *
 * These are the rows that made 341 "actionable" opportunities out of a
 * 382-row census.
 */
const IRRELEVANT: Rule[] = [
  // Guided tours — the headline defect. "Emporenführung auf Deutsch",
  // "Sonderführung im Klostergarten", "Der besondere Rundgang durch Dresden".
  { token: "führung" },
  { token: "fuehrung" },
  { token: "rundgang" },
  { token: "stadtrundfahrt" },

  // Museums, galleries, exhibitions and collections.
  { token: "museum" },
  { token: "ausstellung" },
  { token: "galerie" },
  { token: "vernissage" },
  { token: "sammlung" },
  { token: "malerei" },
  { token: "atelier" },
  { token: "fotoausstellung" },

  // Talks, readings, courses and workshops.
  { token: "vortrag" },
  { token: "lesung" },
  { token: "seminar" },
  { token: "workshop" },
  { token: "kurs", mode: "wordEnd" },
  { token: "schnupperkurs" },
  { token: "training" },
  { token: "gespräch" },
  { token: "gespraech" },
  { token: "sprechstunde" },
  { token: "bibliothek" },
  { token: "nachmittag" },

  // Worship and church programme.
  { token: "gottesdienst" },
  { token: "andacht" },
  { token: "orgelkonzert" },
  { token: "kirchenkonzert" },

  // Stage, screen, cabaret and shows.
  { token: "theater" },
  { token: "kino" },
  { token: "semperoper" },
  { token: "opernhaus" },
  { token: "kabarett" },
  { token: "comedy" },
  { token: "musical" },
  { token: "tribute" },
  { token: "planetarium" },

  // Excursions, courses of movement, wellbeing.
  { token: "wanderung" },
  { token: "exkursion" },
  { token: "yoga" },
  { token: "meditation" },
  { token: "blutspende" },

  // Games, quizzes and ticketed attractions.
  { token: "turnier" },
  { token: "schatzsuche" },
  { token: "gaming" },
  { token: "tagesticket" },

  // Sport fixtures: "1. FC Magdeburg U23 - Regionalliga Nordost",
  // "6. Cottbuser Boxnight", "Schwedter Herbstlauf".
  { token: "liga", mode: "wordEnd" },
  { token: "boxnight" },
  { token: "lauf", mode: "wordEnd" }
];

/**
 * "Messe" is the one genuinely ambiguous stem in German event data: a trade
 * fair (a real vendor opportunity) and a Catholic mass share the word. It is
 * therefore excluded from the tables above and decided here, on context only.
 */
const FAIR_CONTEXT: Rule[] = [
  { token: "hobby" },
  { token: "handwerk" },
  { token: "gewerbe" },
  { token: "verbraucher" },
  { token: "garten" },
  { token: "freizeit" },
  { token: "tourismus" },
  { token: "hochzeit" },
  { token: "oldtimer" },
  { token: "mineralien" },
  { token: "kreativ" },
  { token: "karriere" },
  { token: "ausbildung" }
];

const CHURCH_CONTEXT: Rule[] = [
  { token: "kirche" },
  { token: "kirchen" },
  { token: "gottesdienst" },
  { token: "pfarr" },
  { token: "kapelle" },
  { token: "kloster" },
  { token: "münster" },
  { token: "muenster" },
  { token: "heilig" },
  { token: "dom", mode: "word" },
  { token: "chor" },
  { token: "orgel" },
  { token: "evangelisch" },
  { token: "katholisch" },
  { token: "advent" }
];

/** Categories in which a "Messe" is a trade fair rather than a church service. */
const FAIR_CATEGORIES = new Set(["market", "city_festival", "christmas"]);

const MESSE = buildPattern({ token: "messe" });
const KONZERT = buildPattern({ token: "konzert" });

/* ------------------------------------------------------------- compilation */

interface CompiledRule {
  token: string;
  pattern: RegExp;
}

function compile(rules: Rule[]): CompiledRule[] {
  return rules.map((rule) => ({ token: rule.token, pattern: buildPattern(rule) }));
}

const STRONG_RELEVANT_RULES = compile(STRONG_RELEVANT);
const WEAK_RELEVANT_RULES = compile(WEAK_RELEVANT);
const IRRELEVANT_RULES = compile(IRRELEVANT);
const FAIR_CONTEXT_RULES = compile(FAIR_CONTEXT);
const CHURCH_CONTEXT_RULES = compile(CHURCH_CONTEXT);

/** Rule-list sizes, so a report about this gate can state them rather than guess. */
export const VENDOR_RELEVANCE_RULE_COUNTS = {
  strongRelevant: STRONG_RELEVANT_RULES.length,
  weakRelevant: WEAK_RELEVANT_RULES.length,
  irrelevant: IRRELEVANT_RULES.length,
  fairContext: FAIR_CONTEXT_RULES.length,
  churchContext: CHURCH_CONTEXT_RULES.length
} as const;

function matches(rules: CompiledRule[], text: string): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.token);
}

/* ------------------------------------------------------------ the verdict */

export interface VendorRelevanceVerdict {
  relevance: VendorRelevance;
  /** Which tokens fired, so a decision can always be explained and audited. */
  strongSignals: string[];
  weakSignals: string[];
  irrelevantSignals: string[];
  /** One plain sentence naming why, for the report and the risk signals. */
  reason: string;
}

/**
 * The reason line and the unclear tag live with the ranking gate that prints
 * them (`src/ranking.ts`) and are re-exported here so every consumer of the
 * classifier reaches the same strings. One definition, no drift.
 */
export { VENDOR_IRRELEVANT_REASON, VENDOR_UNCLEAR_TAG } from "../src/ranking";

/**
 * Classify an event as a food-vendor opportunity, or not, or honestly unknown.
 *
 * @param name     the canonical event name — the primary evidence
 * @param category the stored `event_type`. Read ONLY to disambiguate "Messe";
 *                 it is not a relevance signal (see the module note).
 * @param description optional extra recorded text, appended to the evidence.
 */
export function classifyVendorRelevance(
  name: string,
  category?: string,
  description?: string
): VendorRelevance {
  return explainVendorRelevance(name, category, description).relevance;
}

/** The same decision, with the evidence that produced it. */
export function explainVendorRelevance(
  name: string,
  category?: string,
  description?: string
): VendorRelevanceVerdict {
  const text = normalizeRelevanceText([name, description].filter(Boolean).join(" "));

  if (!text) {
    return {
      relevance: "unclear",
      strongSignals: [],
      weakSignals: [],
      irrelevantSignals: [],
      reason: "No event text was recorded, so vendor relevance could not be decided."
    };
  }

  const strongSignals = matches(STRONG_RELEVANT_RULES, text);
  const weakSignals = matches(WEAK_RELEVANT_RULES, text);
  const irrelevantSignals = matches(IRRELEVANT_RULES, text);

  // The Messe ambiguity, resolved on context only — never on the word alone.
  if (MESSE.test(text)) {
    const churchContext = matches(CHURCH_CONTEXT_RULES, text);
    const fairContext = matches(FAIR_CONTEXT_RULES, text);
    const fairCategory = category ? FAIR_CATEGORIES.has(category) : false;
    if (churchContext.length > 0) {
      irrelevantSignals.push("messe (church context)");
    } else if (fairContext.length > 0 || fairCategory) {
      strongSignals.push("messe (fair context)");
    }
    // Otherwise "messe" contributes nothing in either direction.
  }

  // A Konzert is only consumer-calendar programme in a church context; a
  // concert on a market square is a perfectly good pitch.
  if (KONZERT.test(text) && matches(CHURCH_CONTEXT_RULES, text).length > 0) {
    irrelevantSignals.push("konzert (church context)");
  }

  // Rule 1: a strong market/food token wins outright.
  if (strongSignals.length > 0) {
    return {
      relevance: "relevant",
      strongSignals,
      weakSignals,
      irrelevantSignals,
      reason: `Market or food event: matched ${strongSignals.join(", ")}.`
    };
  }

  // Rule 2: otherwise an irrelevant token decides.
  if (irrelevantSignals.length > 0) {
    return {
      relevance: "irrelevant",
      strongSignals,
      weakSignals,
      irrelevantSignals,
      reason: `Consumer-calendar programme: matched ${irrelevantSignals.join(", ")}.`
    };
  }

  // Rule 3: a weak token marks relevance only when nothing contradicts it.
  if (weakSignals.length > 0) {
    return {
      relevance: "relevant",
      strongSignals,
      weakSignals,
      irrelevantSignals,
      reason: `Market-adjacent event: matched ${weakSignals.join(", ")}.`
    };
  }

  // Rule 4: say so.
  return {
    relevance: "unclear",
    strongSignals,
    weakSignals,
    irrelevantSignals,
    reason: "No vendor-relevance signal was found in the recorded event text."
  };
}

/** Narrow an arbitrary stored value to a VendorRelevance, defaulting honestly. */
export function asVendorRelevance(value: unknown): VendorRelevance {
  return value === "relevant" || value === "irrelevant" || value === "unclear"
    ? value
    : "unclear";
}
