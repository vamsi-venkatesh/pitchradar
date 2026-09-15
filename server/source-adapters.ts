import { createHash } from "node:crypto";
import type { ExtractedOccurrence } from "./source-probe";

type DateRange = {
  startsOn: string;
  endsOn: string;
  matchedText: string;
};

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  auml: "ä",
  Auml: "Ä",
  bdquo: "„",
  bull: "•",
  gt: ">",
  laquo: "«",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  ndash: "–",
  nbsp: " ",
  Ouml: "Ö",
  ouml: "ö",
  quot: "\"",
  raquo: "»",
  rdquo: "”",
  rsquo: "’",
  sbquo: "‚",
  szlig: "ß",
  Uuml: "Ü",
  uuml: "ü"
};

function unwrapSourceBody(body: string) {
  if (!body.trimStart().startsWith("{")) return body;
  try {
    const payload = JSON.parse(body) as { content?: unknown; headsection?: unknown };
    if (typeof payload.content !== "string") return body;
    return `${typeof payload.headsection === "string" ? payload.headsection : ""}\n${payload.content}`;
  } catch {
    return body;
  }
}

function decodeHtml(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return namedEntities[entity] ?? match;
  });
}

export function htmlToLines(html: string) {
  const unwrapped = unwrapSourceBody(html);
  return decodeHtml(
    unwrapped
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isoDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function parseGermanDateRange(value: string): DateRange | undefined {
  const full = value.match(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/
  );
  if (full) {
    const startsOn = isoDate(Number(full[3]), Number(full[2]), Number(full[1]));
    const endsOn = isoDate(Number(full[6]), Number(full[5]), Number(full[4]));
    if (startsOn && endsOn) return { startsOn, endsOn, matchedText: full[0] };
  }
  const short = value.match(
    /(\d{1,2})\.(?:(\d{1,2})\.)?\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.?\s*(?:[`´’']\s*)?(\d{2,4})/
  );
  if (!short) return undefined;
  const year = Number(short[5]) < 100 ? 2000 + Number(short[5]) : Number(short[5]);
  const startMonth = Number(short[2] || short[4]);
  const startsOn = isoDate(year, startMonth, Number(short[1]));
  const endsOn = isoDate(year, Number(short[4]), Number(short[3]));
  if (!startsOn || !endsOn) return undefined;
  return { startsOn, endsOn, matchedText: short[0] };
}

function occurrence(input: {
  key: string;
  name: string;
  city: string;
  startsOn: string;
  endsOn: string;
  payload: Record<string, unknown>;
}) {
  const rawPayload = {
    ...input.payload,
    city: input.city,
    startsOn: input.startsOn,
    endsOn: input.endsOn
  };
  return {
    sourceRecordKey: input.key,
    rawName: input.name,
    rawLocation: input.city,
    rawStartsAt: input.startsOn,
    rawEndsAt: input.endsOn,
    rawPayload,
    contentHash: createHash("sha256")
      .update(JSON.stringify({
        key: input.key,
        name: input.name,
        city: input.city,
        startsOn: input.startsOn,
        endsOn: input.endsOn
      }))
      .digest("hex")
  } satisfies ExtractedOccurrence;
}

function slug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractFoodtruckmeileEvents(html: string): ExtractedOccurrence[] {
  const lines = htmlToLines(html);
  const start = lines.findIndex((line) => /^Termine 2026$/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /^Mitmachen$/i.test(line));
  if (start < 0) return [];
  const section = lines.slice(start + 1, end > start ? end : undefined);
  const results: ExtractedOccurrence[] = [];
  for (let index = 2; index < section.length; index += 1) {
    const range = parseGermanDateRange(section[index]);
    if (!range) continue;
    const city = section[index - 2];
    const venue = section[index - 1];
    if (!city || !venue || /^(Entdecken|Route)$/i.test(city)) continue;
    const eventUrl = `https://example-foodtruckmeile.de/${slug(city)}`;
    results.push(occurrence({
      key: eventUrl,
      name: `Foodtruckmeile ${city}`,
      city,
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      payload: {
        venue,
        eventUrl,
        applicationUrl: "https://example-foodtruckmeile.de/dirketbewerbung",
        routeOwner: "Beispiel Kulinarik GmbH",
        eventType: "street_food"
      }
    }));
  }
  return results;
}

export function extractTourAgenturEvents(html: string): ExtractedOccurrence[] {
  const headings = [...unwrapSourceBody(html).matchAll(
    /<div\b[^>]*class=["'][^"']*\baccordion-title\b[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi
  )];
  const results: ExtractedOccurrence[] = [];
  for (const heading of headings) {
    const title = decodeHtml(heading[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const range = parseGermanDateRange(title);
    if (!range) continue;
    const city = title
      .replace(range.matchedText, "")
      .replace(/^[-–\s]+|[-–/\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!city || /weitere städte|termine folgen/i.test(city)) continue;
    results.push(occurrence({
      key: `tour-agentur:${range.startsOn}:${slug(city)}`,
      name: `Street Food Drink & Music Festival ${city}`,
      city,
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      payload: {
        eventUrl: "https://www.example-tour-agentur.de/tourplan2026",
        applicationUrl: "https://www.example-tour-agentur.de/bewerbungsformular",
        routeOwner: "Beispiel Tour-Agentur",
        eventType: "street_food"
      }
    }));
  }
  return results;
}

export function extractHaendlerPortalEvents(html: string): ExtractedOccurrence[] {
  const lines = htmlToLines(html);
  const start = lines.findIndex((line) => /^Unsere Veranstaltungen$/i.test(line));
  if (start < 0) return [];
  const section = lines.slice(start + 1);
  const results: ExtractedOccurrence[] = [];
  for (let index = 0; index < section.length; index += 1) {
    const range = parseGermanDateRange(section[index]);
    if (!range) continue;
    const name = section[index - 1]?.replace(/^Veranstaltung anzeigen\s*/i, "").trim();
    const city = section[index + 1]?.trim();
    if (!name || !city || /veranstaltung anzeigen/i.test(city)) continue;
    const nearby = section.slice(index + 2, index + 6);
    const deadlineLabel = nearby.findIndex((line) => /Frist für .*Bewerbungsphase/i.test(line));
    const deadlineRange = deadlineLabel >= 0
      ? parseGermanDateRange(`${nearby[deadlineLabel + 1]} - ${nearby[deadlineLabel + 1]}`)
      : undefined;
    results.push(occurrence({
      key: `haendler-portal:${range.startsOn}:${slug(name)}`,
      name,
      city,
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      payload: {
        eventUrl: "https://www.example-haendler-portal.de/portal/home/",
        applicationUrl: "https://www.example-haendler-portal.de/portal/home/",
        applicationDeadline: deadlineRange?.startsOn,
        routeOwner: "Agentur Beispiel Händlerportal",
        eventType: /weihnacht/i.test(name) ? "christmas" : "city_festival"
      }
    }));
  }
  return results;
}

/* ------------------------------------------------------------------------- *
 * Shared building blocks for the generic extractors
 * ------------------------------------------------------------------------- */

/** Every field below is read from the fetched page. Nothing is inferred. */
function buildOccurrence(input: {
  key?: string;
  name: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  payload: Record<string, unknown>;
  identity: unknown;
}): ExtractedOccurrence {
  return {
    sourceRecordKey: input.key,
    rawName: input.name,
    rawLocation: input.location,
    rawStartsAt: input.startsAt,
    rawEndsAt: input.endsAt,
    rawPayload: input.payload,
    contentHash: createHash("sha256").update(JSON.stringify(input.identity)).digest("hex")
  };
}

function dedupe(occurrences: ExtractedOccurrence[], limit: number) {
  return [...new Map(occurrences.map((item) => [item.contentHash, item])).values()].slice(0, limit);
}

/** `2026-08-14T18:00` -> `2026-08-14`. Anything unparseable stays undefined. */
function dayOf(value: string | undefined) {
  return value?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
}

function endedBefore(endsAt: string, now: Date | undefined) {
  if (!now) return false;
  const day = dayOf(endsAt);
  return Boolean(day && day < now.toISOString().slice(0, 10));
}

/** A German postal address states its own city: `03046 Cottbus`. */
const POSTAL_CITY = /\b(\d{5})\s+([A-ZÄÖÜ][\wÄÖÜäöüß.'\-/]*(?:[ -][A-ZÄÖÜ][\wÄÖÜäöüß.'\-/]*){0,2})/g;

/** Words that start the venue again after the city, e.g. "15738 Zeuthen Festwiese". */
const VENUE_NOUN =
  /^(?:Festwiese|Festplatz|Marktplatz|Platz|Park|Parkplatz|Halle|Gelände|Straße|Str\.?|Weg|Allee|Ring|Hof|Zentrum|Arena|Stadion|Schloss|Burg|Museum|Rathaus|Kulturpark|Promenade|Ufer|Wiese)$/i;

function postalCities(text: string) {
  return [...text.matchAll(POSTAL_CITY)]
    .map((match) => {
      const words = match[2].replace(/[.,;]+$/, "").trim().split(/\s+/);
      const stop = words.findIndex((word, position) => position > 0 && VENUE_NOUN.test(word));
      return (stop > 0 ? words.slice(0, stop) : words).join(" ");
    })
    .filter((city) => city.length >= 2 && city.length <= 40);
}

const COUNTRY_WORDS = /^(deutschland|germany|de|österreich|austria|schweiz|switzerland)$/i;

/**
 * Reads a city out of a free-text address exactly as the page wrote it.
 * Prefers the German postal-code form; otherwise the last comma-separated
 * segment, but only when it still looks like a place name.
 */
function cityFromAddressText(
  value: string | undefined,
  options: { requireDelimiter?: boolean } = {}
) {
  if (!value) return undefined;
  const postal = postalCities(value);
  if (postal.length) return postal[0];
  // "Marktplatz Neuwied" names a venue, not a city. Without a postal code or a
  // comma the page has not told us the city, so nothing is claimed.
  if (options.requireDelimiter && !value.includes(",")) return undefined;
  const segments = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index].replace(/\b\d{4,5}\b/g, "").trim();
    if (!segment || COUNTRY_WORDS.test(segment)) continue;
    // The city is the last real segment. An earlier one is a venue or street,
    // so a failed check means "no city on this line", never "try the venue".
    if (/\d/.test(segment)) return undefined;
    if (!/^[A-ZÄÖÜ]/.test(segment)) return undefined;
    if (segment.length > 40 || segment.split(/\s+/).length > 4) return undefined;
    return segment;
  }
  return undefined;
}

function documentTitle(html: string) {
  return unwrapSourceBody(html)
    .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The only event-type inference allowed: the page's own words.
 * Everything else falls back to the caller's declared default.
 */
function eventTypeFromName(name: string, fallback?: string) {
  if (/\bweihnacht|christkindl|adventsmarkt/i.test(name)) return "christmas";
  return fallback;
}

/* ------------------------------------------------------------------------- *
 * 1. Generic schema.org / JSON-LD Event extractor
 * ------------------------------------------------------------------------- */

export interface GenericExtractOptions {
  /** Occurrences that already ended before this day are dropped. */
  now?: Date;
  maxEvents?: number;
  /** Fields the registry knows about the source (never about the event). */
  payload?: Record<string, unknown>;
  /** Used only as the event URL fallback. */
  sourceUrl?: string;
  /** Default event type when the event name does not state one. */
  defaultEventType?: string;
}

const EVENT_SUBTYPES = new Set([
  "event",
  "festival",
  "musicevent",
  "foodevent",
  "socialevent",
  "exhibitionevent",
  "theaterevent",
  "sportsevent",
  "businessevent",
  "childrensevent",
  "comedyevent",
  "danceevent",
  "educationevent",
  "literaryevent",
  "salesevent",
  "saleevent",
  "screeningevent",
  "visualartsevent",
  "publicationevent",
  "hackathon",
  "eventseries"
]);

const NESTED_KEYS = [
  "@graph",
  "itemListElement",
  "item",
  "mainEntity",
  "subEvent",
  "subEvents",
  "hasPart",
  "event",
  "events",
  "workPerformed"
];

function jsonLdNodes(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 12) return [];
  if (Array.isArray(value)) return value.flatMap((item) => jsonLdNodes(item, depth + 1));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = NESTED_KEYS.flatMap((key) =>
    key in record ? jsonLdNodes(record[key], depth + 1) : []
  );
  return [record, ...nested];
}

function schemaTypeList(value: unknown) {
  return (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^https?:\/\/schema\.org\//i, "").trim());
}

function isEventType(value: unknown) {
  return schemaTypeList(value).some((type) => EVENT_SUBTYPES.has(type.toLowerCase()));
}

/**
 * JSON-LD strings routinely carry HTML entities, sometimes double encoded
 * (`&amp;uuml;`). Two passes are enough and never invent characters.
 */
function decodeText(value: string) {
  const once = decodeHtml(value);
  return /&(?:[a-z]+|#x?[\da-f]+);/i.test(once) ? decodeHtml(once) : once;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return decodeText(value).trim() || undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textValue(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record.name) || textValue(record["@value"]) || textValue(record["@id"]);
  }
  return undefined;
}

function urlValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text && /^https?:\/\//i.test(text) ? text : undefined;
}

/**
 * Accepts the two forms schema.org allows in the wild: a plain date and a full
 * ISO datetime. German sites sometimes emit `14.08.2026`; that is converted, it
 * is never guessed. Anything else returns undefined and the event is dropped.
 */
function schemaDate(value: unknown) {
  const text = textValue(value);
  if (!text) return undefined;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const day = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (!day) return undefined;
    return iso[4] ? `${day}T${iso[4]}:${iso[5]}:${iso[6] || "00"}` : day;
  }
  const german = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (german) return isoDate(Number(german[3]), Number(german[2]), Number(german[1]));
  return undefined;
}

interface SchemaAddress {
  label?: string;
  city?: string;
  postalCode?: string;
  region?: string;
  street?: string;
  country?: string;
}

function schemaLocation(value: unknown): SchemaAddress {
  if (typeof value === "string") {
    return { label: value.trim() || undefined, city: cityFromAddressText(value) };
  }
  if (Array.isArray(value)) return schemaLocation(value[0]);
  if (!value || typeof value !== "object") return {};
  const node = value as Record<string, unknown>;
  const rawAddress = node.address;
  const address = rawAddress && typeof rawAddress === "object" && !Array.isArray(rawAddress)
    ? rawAddress as Record<string, unknown>
    : {};
  const name = textValue(node.name);
  const city = textValue(address.addressLocality)
    || (typeof rawAddress === "string" ? cityFromAddressText(rawAddress) : undefined);
  const postalCode = textValue(address.postalCode);
  const label = [name, city, postalCode].filter(Boolean).join(", ")
    || (typeof rawAddress === "string" ? rawAddress.trim() : undefined)
    || undefined;
  return {
    label,
    city,
    postalCode,
    region: textValue(address.addressRegion),
    street: textValue(address.streetAddress),
    country: textValue(address.addressCountry)
  };
}

function schemaOffers(value: unknown) {
  const offers = (Array.isArray(value) ? value : [value]).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"
  );
  const mapped = offers.map((offer) => ({
    url: urlValue(offer.url),
    price: textValue(offer.price),
    priceCurrency: textValue(offer.priceCurrency),
    availability: textValue(offer.availability)
  })).filter((offer) => offer.url || offer.price || offer.availability);
  return mapped.length ? mapped : undefined;
}

/**
 * Walks every `application/ld+json` block (and a raw JSON-LD body) and returns
 * the schema.org events it finds. A malformed block is skipped, never guessed
 * at; an event without a parseable start date is dropped, never invented.
 */
export function extractJsonLdEvents(
  html: string,
  options: GenericExtractOptions = {}
): ExtractedOccurrence[] {
  const body = unwrapSourceBody(html);
  const blocks = [...body.matchAll(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map((match) => match[1]);
  if (!blocks.length && /^[[{]/.test(body.trimStart())) blocks.push(body);

  const occurrences: ExtractedOccurrence[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    for (const node of jsonLdNodes(parsed)) {
      if (!isEventType(node["@type"])) continue;
      const name = textValue(node.name) || textValue(node.headline);
      if (!name) continue;
      const status = textValue(node.eventStatus) || "";
      if (/cancell?ed/i.test(status)) continue;
      const attendance = textValue(node.eventAttendanceMode) || "";
      if (/OnlineEventAttendanceMode/i.test(attendance)) continue;

      const startsAt = schemaDate(node.startDate);
      if (!startsAt) continue;
      const endsAt = schemaDate(node.endDate) || dayOf(startsAt) || startsAt;
      if (dayOf(endsAt)! < dayOf(startsAt)!) continue;
      if (endedBefore(endsAt, options.now)) continue;

      const location = schemaLocation(node.location);
      const eventUrl = urlValue(node.url) || urlValue(node["@id"]) || options.sourceUrl;
      const organizer = textValue(node.organizer);
      const eventType = eventTypeFromName(name, options.defaultEventType);
      const identity = {
        id: textValue(node["@id"]),
        name,
        startsAt,
        endsAt,
        location: location.label,
        url: eventUrl
      };
      occurrences.push(buildOccurrence({
        key: textValue(node["@id"]) || eventUrl || `${name}|${startsAt}`,
        name,
        location: location.label,
        startsAt,
        endsAt,
        identity,
        payload: {
          ...options.payload,
          extraction: "json_ld",
          schemaTypes: schemaTypeList(node["@type"]),
          startsOn: dayOf(startsAt),
          endsOn: dayOf(endsAt),
          ...(location.city ? { city: location.city } : {}),
          ...(location.postalCode ? { postalCode: location.postalCode } : {}),
          ...(location.region ? { federalStateHint: location.region } : {}),
          ...(location.street ? { street: location.street } : {}),
          ...(location.country ? { country: location.country } : {}),
          ...(eventUrl ? { eventUrl } : {}),
          ...(organizer ? { routeOwner: organizer } : {}),
          ...(schemaOffers(node.offers) ? { offers: schemaOffers(node.offers) } : {}),
          ...(eventType ? { eventType } : {})
        }
      }));
    }
  }
  return dedupe(occurrences, options.maxEvents || 200);
}

/* ------------------------------------------------------------------------- *
 * 2. Generic ICS / iCalendar extractor
 * ------------------------------------------------------------------------- */

/** RFC5545 §3.1: a CRLF followed by a space or tab continues the line. */
function unfoldIcs(text: string) {
  return text.replace(/^﻿/, "").replace(/\r?\n[ \t]/g, "");
}

function unescapeIcs(value: string) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/\s+/g, " ")
    .trim();
}

function berlinWallTime(instant: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * Handles both RFC5545 forms: `VALUE=DATE:20260814` and
 * `20260814T100000` / `20260814T080000Z`. UTC stamps are rendered as the
 * Europe/Berlin wall time the venue actually keeps.
 */
function parseIcsStamp(rawValue: string, params: string) {
  const value = rawValue.trim();
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || /VALUE=DATE(?!-TIME)/i.test(params)) {
    if (!dateOnly) return undefined;
    const day = isoDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    return day ? { value: day, allDay: true } : undefined;
  }
  const stamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!stamp) return undefined;
  const day = isoDate(Number(stamp[1]), Number(stamp[2]), Number(stamp[3]));
  if (!day) return undefined;
  const time = `${stamp[4]}:${stamp[5]}:${stamp[6] || "00"}`;
  if (stamp[7]) {
    const instant = Date.parse(`${day}T${time}Z`);
    if (!Number.isFinite(instant)) return undefined;
    return { value: berlinWallTime(instant), allDay: false };
  }
  return { value: `${day}T${time}`, allDay: false };
}

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a VCALENDAR body into occurrences. Folded lines are unfolded first,
 * an all-day DTEND is converted from RFC5545's exclusive form to the last day
 * the event actually runs, and events that already ended are skipped.
 */
export function extractIcsEvents(
  text: string,
  options: GenericExtractOptions = {}
): ExtractedOccurrence[] {
  if (!/BEGIN:VEVENT/i.test(text)) return [];
  const lines = unfoldIcs(text).split(/\r?\n/);
  const occurrences: ExtractedOccurrence[] = [];
  let current: Record<string, { value: string; params: string }> | undefined;

  for (const line of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) {
      current = {};
      continue;
    }
    if (/^END:VEVENT\s*$/i.test(line)) {
      const event = current;
      current = undefined;
      if (!event) continue;
      const summary = event.summary ? unescapeIcs(event.summary.value) : "";
      if (!summary) continue;
      if (event.status && /CANCELLED/i.test(event.status.value)) continue;
      const start = event.dtstart
        ? parseIcsStamp(event.dtstart.value, event.dtstart.params)
        : undefined;
      if (!start) continue;
      const rawEnd = event.dtend
        ? parseIcsStamp(event.dtend.value, event.dtend.params)
        : undefined;
      let endsAt = rawEnd?.value || dayOf(start.value) || start.value;
      if (rawEnd?.allDay && start.allDay && rawEnd.value > start.value) {
        endsAt = addDays(rawEnd.value, -1);
      }
      if (dayOf(endsAt)! < dayOf(start.value)!) endsAt = start.value;
      if (endedBefore(endsAt, options.now)) continue;

      const locationText = event.location ? unescapeIcs(event.location.value) : undefined;
      const city = cityFromAddressText(locationText, { requireDelimiter: true });
      const url = event.url ? unescapeIcs(event.url.value) : undefined;
      const eventUrl = url && /^https?:\/\//i.test(url) ? url : options.sourceUrl;
      const uid = event.uid ? unescapeIcs(event.uid.value) : undefined;
      const description = event.description ? unescapeIcs(event.description.value) : undefined;
      occurrences.push(buildOccurrence({
        key: uid || eventUrl || `${summary}|${start.value}`,
        name: summary,
        location: locationText,
        startsAt: start.value,
        endsAt,
        identity: { uid, name: summary, startsAt: start.value, endsAt, location: locationText },
        payload: {
          ...options.payload,
          extraction: "ics",
          startsOn: dayOf(start.value),
          endsOn: dayOf(endsAt),
          ...(city ? { city } : {}),
          ...(locationText ? { locationText } : {}),
          ...(eventUrl ? { eventUrl } : {}),
          ...(uid ? { icsUid: uid } : {}),
          ...(description ? { description: description.slice(0, 600) } : {}),
          ...(eventTypeFromName(summary, options.defaultEventType)
            ? { eventType: eventTypeFromName(summary, options.defaultEventType) }
            : {})
        }
      }));
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const head = line.slice(0, separator);
    const [name, ...params] = head.split(";");
    current[name.trim().toLowerCase()] = {
      value: line.slice(separator + 1),
      params: params.join(";")
    };
  }
  return dedupe(occurrences, options.maxEvents || 300);
}

/* ------------------------------------------------------------------------- *
 * 3. Generic German heading + date HTML extractor
 * ------------------------------------------------------------------------- */

const MONTH_PATTERN =
  "Januar|Jänner|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember" +
  "|Jan|Feb|Mrz|Apr|Jun|Jul|Aug|Sept|Sep|Okt|Nov|Dez";

const MONTH_NUMBERS: Record<string, number> = {
  januar: 1, jänner: 1, jan: 1,
  februar: 2, feb: 2,
  märz: 3, maerz: 3, mrz: 3,
  april: 4, apr: 4,
  mai: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12
};

function monthNumber(value: string | undefined) {
  return value ? MONTH_NUMBERS[value.toLowerCase().replace(/\./g, "")] : undefined;
}

/** "-", "–", "bis", "bis zum" — the German ways a page joins two dates. */
const RANGE_SEPARATOR = "(?:[-–—]|bis(?:\\s+zum)?)";
const NUMERIC_RANGE = new RegExp(
  `(?<!\\d)(\\d{1,2})[.\\-](\\d{1,2})[.\\-](\\d{4})\\s*${RANGE_SEPARATOR}\\s*` +
  "(?:[A-Za-zÄÖÜäöüß]+,?\\s*)?(\\d{1,2})[.\\-](\\d{1,2})[.\\-](\\d{4})(?!\\d)",
  "i"
);
const NUMERIC_SHORT_RANGE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\.(?:(\\d{1,2})\\.?)?\\s*${RANGE_SEPARATOR}\\s*` +
  "(\\d{1,2})\\.(\\d{1,2})\\.\\s*(?:[`´’']\\s*)?(\\d{2,4})(?!\\d)",
  "i"
);
const NAMED_RANGE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\.?\\s*(?:(${MONTH_PATTERN})\\.?\\s*)?` +
  `(?:[-–—]|bis|und|&|u\\.)\\s*(\\d{1,2})\\.?\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{4})(?!\\d)`,
  "i"
);
const NAMED_SINGLE = new RegExp(
  `(?<!\\d)(\\d{1,2})\\.?\\s*(${MONTH_PATTERN})\\.?\\s+(\\d{4})(?!\\d)`,
  "i"
);
const NUMERIC_SINGLE = /(?<!\d)(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})(?!\d)/;
const NUMERIC_SINGLE_SHORT = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.\s*(?:[`´’']\s*)?(\d{2})(?!\d)/;
const DAY_MONTH_RANGE =
  /(?<![\d.])(\d{1,2})\.(\d{1,2})\.\s*(?:[-–—]|bis)\s*(\d{1,2})\.(\d{1,2})\.(?!\d)/;
const DAY_MONTH_ONLY = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(?!\d)/;
const MONTH_HEADING = new RegExp(`^(${MONTH_PATTERN})\\.?\\s+(\\d{4})$`, "i");
/** "bis 15.03." states an end date only — the start is not on the page. */
const OPEN_ENDED_ROW = /^\s*(?:noch\s+)?bis\b/i;

export interface ParsedGermanDate {
  startsOn: string;
  endsOn: string;
  matchedText: string;
  index: number;
}

function ranged(
  startsOn: string | undefined,
  endsOn: string | undefined,
  match: RegExpMatchArray
): ParsedGermanDate | undefined {
  if (!startsOn || !endsOn) return undefined;
  if (endsOn < startsOn) return undefined;
  const span = (Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000;
  if (!Number.isFinite(span) || span > 365) return undefined;
  return { startsOn, endsOn, matchedText: match[0], index: match.index ?? 0 };
}

function plausibleYear(year: number) {
  return year >= 2000 && year <= 2100;
}

/**
 * Reads the German date forms that appear on public event pages. `context`
 * carries a `Monat JJJJ` heading that the same page printed above the row —
 * it is never a guess about the current year.
 */
export function parseGermanDate(
  value: string,
  context: { year?: number } = {}
): ParsedGermanDate | undefined {
  const numericRange = value.match(NUMERIC_RANGE);
  if (numericRange && plausibleYear(Number(numericRange[3]))) {
    const result = ranged(
      isoDate(Number(numericRange[3]), Number(numericRange[2]), Number(numericRange[1])),
      isoDate(Number(numericRange[6]), Number(numericRange[5]), Number(numericRange[4])),
      numericRange
    );
    if (result) return result;
  }

  const shortRange = value.match(NUMERIC_SHORT_RANGE);
  if (shortRange) {
    const year = Number(shortRange[5]) < 100 ? 2000 + Number(shortRange[5]) : Number(shortRange[5]);
    if (plausibleYear(year)) {
      const startMonth = Number(shortRange[2] || shortRange[4]);
      const result = ranged(
        isoDate(year, startMonth, Number(shortRange[1])),
        isoDate(year, Number(shortRange[4]), Number(shortRange[3])),
        shortRange
      );
      if (result) return result;
    }
  }

  const namedRange = value.match(NAMED_RANGE);
  if (namedRange && plausibleYear(Number(namedRange[5]))) {
    const endMonth = monthNumber(namedRange[4]);
    const startMonth = monthNumber(namedRange[2]) ?? endMonth;
    const endYear = Number(namedRange[5]);
    // "30. Dezember bis 2. Januar 2027" — the printed year belongs to the end.
    const startYear = startMonth && endMonth && startMonth > endMonth ? endYear - 1 : endYear;
    const result = ranged(
      startMonth ? isoDate(startYear, startMonth, Number(namedRange[1])) : undefined,
      endMonth ? isoDate(endYear, endMonth, Number(namedRange[3])) : undefined,
      namedRange
    );
    if (result) return result;
  }

  const namedSingle = value.match(NAMED_SINGLE);
  if (namedSingle && plausibleYear(Number(namedSingle[3]))) {
    const month = monthNumber(namedSingle[2]);
    const day = month ? isoDate(Number(namedSingle[3]), month, Number(namedSingle[1])) : undefined;
    const result = ranged(day, day, namedSingle);
    if (result) return result;
  }

  const numericSingle = value.match(NUMERIC_SINGLE);
  if (numericSingle && plausibleYear(Number(numericSingle[3]))) {
    const day = isoDate(
      Number(numericSingle[3]),
      Number(numericSingle[2]),
      Number(numericSingle[1])
    );
    const result = ranged(day, day, numericSingle);
    if (result) return result;
  }

  const shortSingle = value.match(NUMERIC_SINGLE_SHORT);
  if (shortSingle) {
    const day = isoDate(
      2000 + Number(shortSingle[3]),
      Number(shortSingle[2]),
      Number(shortSingle[1])
    );
    const result = ranged(day, day, shortSingle);
    if (result) return result;
  }

  if (context.year) {
    const dayMonthRange = value.match(DAY_MONTH_RANGE);
    if (dayMonthRange) {
      const startsOn = isoDate(context.year, Number(dayMonthRange[2]), Number(dayMonthRange[1]));
      const endMonth = Number(dayMonthRange[4]);
      const endYear = endMonth < Number(dayMonthRange[2]) ? context.year + 1 : context.year;
      const result = ranged(
        startsOn,
        isoDate(endYear, endMonth, Number(dayMonthRange[3])),
        dayMonthRange
      );
      if (result) return result;
    }
    const dayMonth = value.match(DAY_MONTH_ONLY);
    if (dayMonth) {
      const day = isoDate(context.year, Number(dayMonth[2]), Number(dayMonth[1]));
      const result = ranged(day, day, dayMonth);
      if (result) return result;
    }
  }
  return undefined;
}

/** Page furniture that is a label, never an event name. */
const LABEL_WORDS = new Set([
  "abo", "agb", "aktuelles", "alle termine", "anfahrt", "anmeldung", "ansprechpartner",
  "archiv", "aussteller", "bewerbung", "bewerbungen", "bilder", "datenschutz", "datum",
  "details", "downloads", "eventart", "eventinfo", "fakten", "galerie", "highlights",
  "hinweis", "hinweise", "impressum", "information", "informationen", "jahresrückblick",
  "kalender", "kontakt", "location", "mehr", "mehr erfahren", "menü", "navigation",
  "news", "ort", "presse", "programm", "service", "sonstiges", "startseite", "suche",
  "teilnahmebedingungen", "teilnahmebedingung", "termin", "termine", "tickets",
  "uhrzeit", "veranstaltung", "veranstaltungen", "veranstaltungskalender",
  "veranstaltungsort", "weiterlesen", "weitere informationen", "zurück",
  "öffnungszeiten", "übersicht"
]);

/** Openers that mark a line as page furniture rather than a name or a place. */
const FURNITURE_PREFIX =
  /^(?:weitere|weiterlesen|weiter|mehr\b|alle\b|hier\b|foto\b|bild\b|webseite|website|eintritt|preis|kosten|anmelde|lesen sie|zurück|mehr erfahren|jetzt\b|ab \d)/i;

const EVENT_WORDS =
  /fest|markt|festival|messe|rummel|kirmes|jahrmarkt|spektakel|party|konzert|nacht|tag\b|lauf\b|open air|weihnacht|ostern|karneval|jubiläum|feier|schau|tour|meile|woche|scholle|sommer|winter|frühling|herbst/i;

function isHeadingCandidate(line: string) {
  if (line.length < 4 || line.length > 90) return false;
  if (line.endsWith(":")) return false;
  if (!/[A-Za-zÄÖÜäöüß]{3}/.test(line)) return false;
  if (/^[\d\s.,:\-–—/]+$/.test(line)) return false;
  if (MONTH_HEADING.test(line)) return false;
  if (LABEL_WORDS.has(line.toLowerCase().replace(/[.:!]+$/, ""))) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !EVENT_WORDS.test(line)) return false;
  return true;
}

function isLocationCandidate(line: string) {
  if (line.length < 2 || line.length > 90) return false;
  // "Infos: Brandenburger Theater" is a labelled link, not a place.
  if (line.includes(":")) return false;
  if (MONTH_HEADING.test(line)) return false;
  if (FURNITURE_PREFIX.test(line)) return false;
  if (LABEL_WORDS.has(line.toLowerCase().replace(/[.:!]+$/, ""))) return false;
  // A "Venue, City" line may carry four words; a bare line must be a place name.
  const words = line.split(/\s+/).filter(Boolean).length;
  if (!line.includes(",") && words > 3) return false;
  return /[A-Za-zÄÖÜäöüß]{2}/.test(line);
}

/** The name has to read like an event, not like a time, a postcode or a caption. */
function isNameCandidate(value: string) {
  if (value.length < 4 || value.length > 140) return false;
  if (!/[A-Za-zÄÖÜäöüß]{3}/.test(value)) return false;
  if (/^[([)\]]/.test(value)) return false;
  if (/^\d{5}\s/.test(value)) return false;
  if (/^\d{1,2}[:.]\d{2}\b/.test(value)) return false;
  if (FURNITURE_PREFIX.test(value)) return false;
  if (LABEL_WORDS.has(value.toLowerCase().replace(/[.:!]+$/, ""))) return false;
  return true;
}

function isCityCandidate(value: string) {
  if (value.length < 2 || value.length > 40) return false;
  if (/[&()/\\@]/.test(value) && !/^[A-ZÄÖÜ][\wÄÖÜäöüß.\-]*\/[A-ZÄÖÜ]/.test(value)) return false;
  if (FURNITURE_PREFIX.test(value)) return false;
  if (LABEL_WORDS.has(value.toLowerCase().replace(/[.:!]+$/, ""))) return false;
  return /^[A-ZÄÖÜ]/.test(value);
}

/** Call-to-action tails the page appends to a heading link. */
const CALL_TO_ACTION =
  /\s*[-–—|]\s*(?:hier\s*klicken|klicken\s*sie\s*hier|mehr\s*info(?:rmation)?(?:en)?|weitere\s*info(?:rmation)?(?:en)?|zu\s*den\s*tickets?|zur\s*den\s*tickets?|tickets?|mehr\s*erfahren|weiterlesen|anmelden|details?)\s*$/i;

/** Trailing "…, www.example.de" is a link the page appended, not part of the name. */
function tidyName(value: string) {
  let name = value
    .replace(/[,;•|]?\s*(?:https?:\/\/|www\.)\S+\s*$/i, "")
    .replace(/[\s,;:.–—-]+$/, "")
    .trim();
  for (let pass = 0; pass < 2 && CALL_TO_ACTION.test(name); pass += 1) {
    name = name.replace(CALL_TO_ACTION, "").trim();
  }
  return name;
}

export interface GermanListOptions extends GenericExtractOptions {
  /** Stable prefix for the synthetic record key. */
  keyPrefix: string;
  /**
   * A city the source is scoped to. It is only applied when the page's own
   * <title> repeats it, and it is always recorded as page-level evidence.
   */
  cityScope?: string;
}

/**
 * Finds German dates in a rendered event list and pairs each with the nearest
 * preceding heading. Nothing is invented: a row without a heading or without a
 * city that the page itself states is skipped rather than filled in.
 */
export function extractGermanListEvents(
  html: string,
  options: GermanListOptions
): ExtractedOccurrence[] {
  const lines = htmlToLines(html);
  const title = documentTitle(html);
  const scopeSource = title || lines[0] || "";
  const scopeCity = options.cityScope
    && scopeSource.toLowerCase().includes(options.cityScope.toLowerCase())
    ? options.cityScope
    : undefined;

  type Row = {
    index: number;
    date: ParsedGermanDate;
    name?: string;
    headingIndex?: number;
    locationHint?: string;
  };
  const rows: Row[] = [];
  let contextYear: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(MONTH_HEADING);
    if (heading) {
      contextYear = Number(heading[2]);
      continue;
    }
    if (OPEN_ENDED_ROW.test(line)) continue;
    const date = parseGermanDate(line, { year: contextYear });
    if (!date) continue;
    rows.push({ index, date });
  }

  const dateLines = new Set(rows.map((row) => row.index));
  for (const row of rows) {
    const line = lines[row.index];
    const residual = tidyName(
      line.slice(row.date.index + row.date.matchedText.length).replace(/^[\s,;:.–—-]+/, "")
    );
    // "Lychen - Flößerfest: Vom 31.07 bis zum 02.08.2026" — when the page put a
    // labelled name in front of the date on the same row, that beats any
    // heading further up the page.
    const prefix = line
      .slice(0, row.date.index)
      .replace(/\s*\b(?:vom|von|am|ab|bis|zum|beginn)\b\s*$/i, "")
      .trim();
    if (/[:,\-–—]$/.test(prefix)) {
      const label = tidyName(prefix.replace(/[\s:,\-–—]+$/, "").replace(/^[\s:,\-–—]+/, ""));
      if (isHeadingCandidate(label) && isNameCandidate(label)) {
        row.name = label;
        if (residual) row.locationHint = residual;
        continue;
      }
    }
    // Otherwise the nearest preceding heading is the event's name. Only when
    // the page gives none does the text after the date become the name (a
    // "03.01., Neujahrsturnier" row); elsewhere that text is the place.
    for (let back = row.index - 1; back >= Math.max(0, row.index - 6); back -= 1) {
      if (dateLines.has(back)) break;
      // The document title names the page, never one of its events.
      if (title && lines[back] === title) continue;
      if (!isHeadingCandidate(lines[back])) continue;
      const heading = tidyName(lines[back]);
      if (!isNameCandidate(heading)) continue;
      row.name = heading;
      row.headingIndex = back;
      break;
    }
    if (row.name) {
      if (residual) row.locationHint = residual;
      continue;
    }
    if (row.date.index <= 3 && isNameCandidate(residual)) row.name = residual;
  }

  const named = rows.filter((row) => row.name);
  const headingIndexes = new Set(named.map((row) => row.headingIndex).filter((value) => value !== undefined));
  const pageCities = [...new Set(postalCities(lines.join("\n")))];
  const occurrences: ExtractedOccurrence[] = [];

  for (const row of named) {
    const name = row.name!;
    let city: string | undefined;
    let cityEvidence: string | undefined;

    // A German postal address states its own city. Scan the row and the lines
    // that follow it, stopping at the next dated row so one event's address is
    // never borrowed by another.
    for (let ahead = row.index; ahead <= row.index + 4 && ahead < lines.length; ahead += 1) {
      if (ahead > row.index && dateLines.has(ahead)) break;
      const postal = postalCities(lines[ahead])[0];
      if (postal) {
        city = postal;
        cityEvidence = "postal_address";
        break;
      }
    }
    if (!city && row.locationHint && isLocationCandidate(row.locationHint)) {
      const candidate = cityFromAddressText(row.locationHint);
      if (candidate) {
        city = candidate;
        cityEvidence = "row_location";
      }
    }
    if (!city) {
      const next = lines[row.index + 1];
      const usable = next
        && !dateLines.has(row.index + 1)
        && !headingIndexes.has(row.index + 1)
        && isLocationCandidate(next);
      const candidate = usable ? cityFromAddressText(next) : undefined;
      if (candidate) {
        city = candidate;
        cityEvidence = "location_line";
      }
    }
    // One address on a page that lists one or two events is that event's
    // address. On a longer list it is the publisher's own imprint, so it is
    // never borrowed.
    if (!city && pageCities.length === 1 && named.length <= 2) {
      city = pageCities[0];
      cityEvidence = "page_address";
    }
    if (!city && scopeCity) {
      city = scopeCity;
      cityEvidence = "page_title_scope";
    }
    if (!city || !isCityCandidate(city)) continue;

    const identity = {
      source: options.keyPrefix,
      name,
      city,
      startsOn: row.date.startsOn,
      endsOn: row.date.endsOn
    };
    occurrences.push(buildOccurrence({
      key: `${options.keyPrefix}:${row.date.startsOn}:${slug(name).slice(0, 60)}`,
      name,
      location: city,
      startsAt: row.date.startsOn,
      endsAt: row.date.endsOn,
      identity,
      payload: {
        ...options.payload,
        extraction: "german_list",
        city,
        cityEvidence,
        startsOn: row.date.startsOn,
        endsOn: row.date.endsOn,
        matchedDateText: row.date.matchedText,
        ...(options.sourceUrl ? { eventUrl: options.sourceUrl } : {}),
        ...(eventTypeFromName(name, options.defaultEventType)
          ? { eventType: eventTypeFromName(name, options.defaultEventType) }
          : {})
      }
    }));
  }

  return dedupe(
    occurrences.filter((item) => !endedBefore(item.rawEndsAt!, options.now)),
    options.maxEvents || 80
  );
}

/* ------------------------------------------------------------------------- *
 * Routing
 * ------------------------------------------------------------------------- */

/**
 * Registry-level facts about a source's application route. These describe the
 * source, never an individual event, and are only attached to rows that the
 * source itself published.
 */
export const sourceRouteHints: Record<string, Record<string, unknown>> = {
  "beispiel-events-foodtruck-festivals": {
    applicationUrl: "https://www.example-foodtruck-festivals.de/trucker/",
    routeOwner: "Beispiel Events GmbH",
    eventType: "street_food"
  },
  "street-food-market": { eventType: "street_food" },
  "street-food-music": { eventType: "street_food" },
  "street-food-beach": { eventType: "street_food" },
  "food-festivals-directory": { eventType: "street_food" },
  "mft-streetfood-berlin": { eventType: "street_food" },
  "mft-streetfood-brandenburg": { eventType: "street_food" },
  "mft-streetfood-sachsen": { eventType: "street_food" },
  "mft-streetfood-sachsen-anhalt": { eventType: "street_food" },
  "mft-maerkte-brandenburg": { eventType: "market" },
  "mkt-kunsthandwerk-berlin": { eventType: "market" },
  "mkt-kunsthandwerk-brandenburg": { eventType: "market" },
  "mkt-kunsthandwerk-sachsen": { eventType: "market" },
  "meinestadt-stadtfeste": { eventType: "city_festival" },
  "meinestadt-volksfeste": { eventType: "city_festival" }
};

type AdapterStrategy =
  | { kind: "json_ld"; options?: GenericExtractOptions }
  | { kind: "ics"; options?: GenericExtractOptions }
  | { kind: "german_list"; options: Omit<GermanListOptions, "now"> };

const adapterStrategies: Record<string, AdapterStrategy> = {
  "brandenburg-events": {
    kind: "german_list",
    options: {
      keyPrefix: "brandenburg-events",
      sourceUrl: "https://efre.brandenburg.de/efre/de/aktuelles/veranstaltungen/"
    }
  },
  "marktverband-berlin": {
    kind: "german_list",
    options: {
      keyPrefix: "marktverband-berlin",
      sourceUrl: "https://volksfest-berlin.de/volksfest-2026/",
      cityScope: "Berlin",
      defaultEventType: "city_festival",
      payload: { routeOwner: "Beispiel Marktverband Berlin e.V." }
    }
  },
  "schwedt-annual-events": {
    kind: "german_list",
    options: {
      keyPrefix: "schwedt-annual-events",
      sourceUrl: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
      cityScope: "Schwedt/Oder",
      maxEvents: 120
    }
  },
  "hauptstadtkultur-berlin": {
    kind: "german_list",
    options: {
      keyPrefix: "hauptstadtkultur-berlin",
      sourceUrl: "https://www.hauptstadtkultur.berlin/events/",
      maxEvents: 120
    }
  },
  "foodtruckbooking-festivals": {
    kind: "german_list",
    options: {
      keyPrefix: "foodtruckbooking-festivals",
      sourceUrl: "https://www.foodtruckbooking.de/festivals",
      defaultEventType: "street_food"
    }
  }
};

export function extractAdapterEvents(
  sourceId: string,
  html: string,
  options: { now?: Date } = {}
): ExtractedOccurrence[] {
  if (sourceId === "foodtruckmeile") return extractFoodtruckmeileEvents(html);
  if (sourceId === "tour-agentur") return extractTourAgenturEvents(html);
  if (sourceId === "haendler-portal") return extractHaendlerPortalEvents(html);
  const strategy = adapterStrategies[sourceId];
  if (!strategy) return [];
  if (strategy.kind === "json_ld") {
    return extractJsonLdEvents(html, { ...strategy.options, now: options.now });
  }
  if (strategy.kind === "ics") {
    return extractIcsEvents(html, { ...strategy.options, now: options.now });
  }
  return extractGermanListEvents(html, { ...strategy.options, now: options.now });
}
