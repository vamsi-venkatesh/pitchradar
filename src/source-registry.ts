/**
 * SOURCE REGISTRY — the configured collection surface.
 *
 * PUBLIC REPOSITORY NOTE: the private deployment carries a curated registry of
 * dozens of municipal, tourism, organizer, directory and procurement sources.
 * This repository keeps ten representative entries: six whose extractors the
 * replay harness in `server/__replays__/` actually exercises (Tribe API, two
 * HTML adapters, a trader portal, ICS and JSON-LD) and four public municipal or
 * tourism census sources. Every other row is a placeholder marked "configured
 * per deployment". The extraction code is complete; only the curated list of
 * real sites is withheld.
 */
export type SourceKind =
  | "organizer"
  | "municipal"
  | "directory"
  | "official_service"
  | "procurement"
  | "trader_portal"
  | "association";
export type SourceLayer =
  | "event_census"
  | "organizer_network"
  | "application_route"
  | "procurement"
  | "private_demand";
export type ExtractionMode =
  | "api"
  | "json_ld_first"
  | "ics"
  | "html_adapter"
  | "pdf"
  | "manual_verification";
export type SourceHealthState =
  | "healthy"
  | "restricted"
  | "broken"
  | "degraded"
  | "unavailable"
  | "never_checked";

export interface RegisteredSource {
  id: string;
  name: string;
  baseUrl: string;
  collectorUrl?: string;
  kind: SourceKind;
  layer: SourceLayer;
  officialFor: string[];
  extractionMode: ExtractionMode;
  priority: 1 | 2 | 3 | 4;
  cadence: "daily" | "weekly" | "monthly" | "manual";
  trustRule: string;
  businessValue: string;
  healthState?: SourceHealthState;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastHttpStatus?: number;
}

export const sourceRegistry: RegisteredSource[] = [
  {
    id: "brandenburg-tourism-calendar",
    name: "Brandenburg tourism event calendar",
    baseUrl: "https://eventcalendar.reiseland-brandenburg.de/?brandenburg_staatskanzlei",
    kind: "official_service",
    layer: "event_census",
    officialFor: ["Brandenburg event occurrences"],
    extractionMode: "manual_verification",
    priority: 1,
    cadence: "weekly",
    trustRule: "Confirms public event occurrences only; categories overlap and never prove a vendor place. The public calendar only serves a search form to automated clients, so occurrences are read by a person.",
    businessValue: "Broad census that exposes events missed by food-festival directories."
  },
  {
    id: "berlin-festival-list",
    name: "Berlin street and public festival list",
    baseUrl: "https://www.berlin.de/sen/web/service/maerkte-feste/strassen-volksfeste/",
    kind: "official_service",
    layer: "event_census",
    officialFor: ["Published Berlin street and public festivals"],
    extractionMode: "manual_verification",
    priority: 2,
    cadence: "weekly",
    trustRule: "Official but voluntary and explicitly incomplete; each organizer must be followed separately. The list is assembled in the browser, so the published entries are read by a person.",
    businessValue: "City-level discovery for non-food events that still commission catering."
  },
  {
    id: "hannover-events",
    name: "Hannover official event calendar",
    baseUrl: "https://www.hannover.de/Veranstaltungskalender",
    kind: "municipal",
    layer: "event_census",
    officialFor: ["Hannover event occurrences"],
    extractionMode: "manual_verification",
    priority: 1,
    cadence: "weekly",
    trustRule: "Confirms the event; gastronomy and availability require deeper event-page investigation. The calendar is rendered in the browser, so occurrences are read by a person.",
    businessValue: "Known source that exposes Seefest am Demo-Ufer and prevents the first coverage failure from recurring."
  },
  {
    id: "brandenburg-events",
    name: "Land Brandenburg public listings",
    baseUrl: "https://efre.brandenburg.de/efre/de/aktuelles/veranstaltungen/",
    kind: "official_service",
    layer: "event_census",
    officialFor: ["Brandenburg public event dates"],
    extractionMode: "html_adapter",
    priority: 2,
    cadence: "weekly",
    trustRule: "Confirms event/date/place only; does not prove vendor availability.",
    businessValue: "Secondary government source for regional events."
  },
  {
    id: "beispiel-events-foodtruck-festivals",
    name: "Beispiel Foodtruck-Festivals",
    baseUrl: "https://www.example-foodtruck-festivals.de/events/",
    collectorUrl: "https://www.example-foodtruck-festivals.de/wp-json/tribe/events/v1/events",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Beispiel Events festival tour"],
    extractionMode: "api",
    priority: 1,
    cadence: "daily",
    trustRule: "Authoritative for its tour; application availability still requires a current organizer response.",
    businessValue: "Reusable operator relationship across many German cities."
  },
  {
    id: "foodtruckmeile",
    name: "Beispiel Foodtruckmeile",
    baseUrl: "https://example-foodtruckmeile.de/",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Foodtruckmeile tour"],
    extractionMode: "html_adapter",
    priority: 1,
    cadence: "daily",
    trustRule: "Authoritative for tour dates and its partner application; acceptance is never assumed.",
    businessValue: "Direct food-partner route and named relationship contact."
  },
  {
    id: "tour-agentur",
    name: "Beispiel Tour-Agentur tour",
    baseUrl: "https://www.example-tour-agentur.de/tourplan2026",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Beispiel Tour-Agentur tour"],
    extractionMode: "html_adapter",
    priority: 2,
    cadence: "daily",
    trustRule: "Page sections can contain stale copy; each date needs cross-checking.",
    businessValue: "Another multi-city application route with announced future stops."
  },
  {
    id: "haendler-portal",
    name: "Agentur Beispiel Händlerportal",
    baseUrl: "https://www.example-haendler-portal.de/portal/events/edit/",
    kind: "trader_portal",
    layer: "application_route",
    officialFor: ["Events listed inside the trader portal"],
    extractionMode: "html_adapter",
    priority: 1,
    cadence: "daily",
    trustRule: "Dates and published deadlines are usable; account-only availability needs manual verification.",
    businessValue: "Surfaces applications, contracts and deadlines across several city events in one place."
  },
  {
    id: "street-food-market",
    name: "Street Food Festival & Market tour",
    baseUrl: "https://example-street-food-market.de/aktuelle-veranstaltungen/",
    collectorUrl: "https://example-street-food-market.de/theevents/?ical=1",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Street Food Festival & Market tour"],
    extractionMode: "ics",
    priority: 1,
    cadence: "daily",
    trustRule: "The operator's own calendar feed states dates and venues; it never states whether a speciality pitch is free.",
    businessValue: "Published iCalendar feed of a multi-city street-food operator, so new stops arrive without scraping."
  },
  {
    id: "street-food-music",
    name: "Street Food & Music Festivals",
    baseUrl: "https://www.example-street-food-music.de/",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: ["Street Food & Music Festival tour"],
    extractionMode: "json_ld_first",
    priority: 1,
    cadence: "daily",
    trustRule: "Authoritative for its own tour dates; vendor acceptance and category exclusivity still need an organizer reply.",
    businessValue: "One operator running a multi-city season, published as schema.org events."
  },
  {
    id: "placeholder-city-census-1",
    name: "Regional event census source — configured per deployment",
    baseUrl: "https://census-1.example-sources.de/",
    kind: "directory",
    layer: "event_census",
    officialFor: [],
    extractionMode: "json_ld_first",
    priority: 2,
    cadence: "weekly",
    trustRule: "Placeholder entry. The curated source this stands for — its URL, cadence and trust rule — is configured per deployment and is not published in this repository.",
    businessValue: "Stands in for one of the nationwide schema.org event directories in the private registry."
  },
  {
    id: "placeholder-city-census-2",
    name: "Municipal market calendar — configured per deployment",
    baseUrl: "https://census-2.example-sources.de/",
    kind: "municipal",
    layer: "event_census",
    officialFor: [],
    extractionMode: "manual_verification",
    priority: 2,
    cadence: "weekly",
    trustRule: "Placeholder entry. The curated source this stands for — its URL, cadence and trust rule — is configured per deployment and is not published in this repository.",
    businessValue: "Stands in for one of the municipal calendars that only a person can read."
  },
  {
    id: "placeholder-organizer-network-1",
    name: "Operator network source — configured per deployment",
    baseUrl: "https://operator-1.example-sources.de/",
    kind: "organizer",
    layer: "organizer_network",
    officialFor: [],
    extractionMode: "html_adapter",
    priority: 2,
    cadence: "weekly",
    trustRule: "Placeholder entry. The curated source this stands for — its URL, cadence and trust rule — is configured per deployment and is not published in this repository.",
    businessValue: "Stands in for one curated multi-city operator source in the private registry."
  },
  {
    id: "placeholder-application-route-1",
    name: "Trader application route — configured per deployment",
    baseUrl: "https://route-1.example-sources.de/",
    kind: "trader_portal",
    layer: "application_route",
    officialFor: [],
    extractionMode: "manual_verification",
    priority: 2,
    cadence: "weekly",
    trustRule: "Placeholder entry. The curated source this stands for — its URL, cadence and trust rule — is configured per deployment and is not published in this repository.",
    businessValue: "Stands in for one curated application or trader-portal route in the private registry."
  },
  {
    id: "placeholder-procurement-1",
    name: "Public concession notice feed — configured per deployment",
    baseUrl: "https://procurement-1.example-sources.de/",
    kind: "procurement",
    layer: "procurement",
    officialFor: [],
    extractionMode: "manual_verification",
    priority: 3,
    cadence: "monthly",
    trustRule: "Placeholder entry. The curated source this stands for — its URL, cadence and trust rule — is configured per deployment and is not published in this repository.",
    businessValue: "Stands in for the public procurement platforms that publish catering concessions."
  }
];

export const sourceLayerLabels: Record<SourceLayer, string> = {
  event_census: "City and event census",
  organizer_network: "Organizer networks",
  application_route: "Applications and trader portals",
  procurement: "Procurement and concession notices",
  private_demand: "Private and corporate requests"
};
