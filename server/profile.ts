import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { clientProfile as fixtureProfile } from "../src/profile";
import {
  databaseConfigured,
  readClientProfileIntakeRow,
  withClientProfileIntakeLock,
  type ClientProfileIntakeRow
} from "./database";

/**
 * PitchRadar client intake.
 *
 * The whole product rests on one law: an unknown stays unknown. Nothing here
 * may turn a blank into a zero, a guess into a fact, or a founder-authored
 * placeholder into a client-confirmed answer. Every field therefore carries a
 * value AND a state:
 *
 *   "unknown"   — never answered, or the client explicitly said "I don't know
 *                 yet". Both are honest; the second one is timestamped.
 *   "provided"  — the client supplied it.
 *   "confirmed" — the client explicitly confirmed a value PitchRadar had
 *                 already recorded (menu lines, prefilled operating rules).
 *
 * `missing_inputs` is recomputed from the intake on every write and again on
 * every read in catalogue.ts, so the dashboards, ranking and agent all keep
 * telling the truth about what is still open.
 */

export type IntakeFieldState = "unknown" | "provided" | "confirmed";

export type IntakeFieldKind =
  | "text"
  | "longtext"
  | "email"
  | "phone"
  | "url"
  | "postcode"
  | "integer"
  | "money"
  | "percent"
  | "dimension"
  | "boolean"
  | "select"
  | "multiselect"
  | "weekdays"
  | "stringlist"
  | "consent"
  | "statement"
  | "document"
  | "asset"
  | "event_history";

export interface IntakeFieldOption {
  value: string;
  label: string;
}

export interface IntakeFieldDefinition {
  id: string;
  label: string;
  /** One short line telling the client what we mean. Always present. */
  helper: string;
  /** What the product can do once this is known. Present where it matters. */
  unlocks?: string;
  kind: IntakeFieldKind;
  unit?: string;
  options?: IntakeFieldOption[];
  /** Which sub-parts a document field collects beyond `held`. */
  parts?: Array<"reference" | "issuer" | "expiry">;
  required?: boolean;
  /** Hard operating gate: an event that cannot supply it is rejected. */
  hardGate?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface IntakeSectionDefinition {
  id: string;
  title: string;
  intro: string;
  unlocks: string;
  fields: IntakeFieldDefinition[];
}

export interface IntakeDocumentValue {
  held: "yes" | "no" | "expired";
  reference?: string;
  issuer?: string;
  expiry?: string;
}

export interface IntakeAssetValue {
  have: boolean;
  link?: string;
  note?: string;
}

export interface IntakePastEvent {
  name: string;
  city?: string;
  year?: number;
  outcome?: "strong" | "ok" | "poor";
  wouldReturn?: boolean;
  notes?: string;
}

export type IntakeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | IntakeDocumentValue
  | IntakeAssetValue
  | IntakePastEvent[]
  | null;

export interface IntakeAnswer {
  value: IntakeValue;
  state: IntakeFieldState;
  updatedAt: string;
  /** Set only when a consent field is switched on. */
  consentedAt?: string;
}

export type IntakeSectionAnswers = Record<string, IntakeAnswer>;
export type IntakeRecord = Record<string, IntakeSectionAnswers>;

export interface IntakeSectionStatus {
  total: number;
  answered: number;
  /** Explicitly marked "I don't know yet" — a real answer, not a known input. */
  deferred: number;
  untouched: number;
  complete: boolean;
  updatedAt?: string;
}

export interface IntakeMenuItem {
  name: string;
  priceEur: number;
  description?: string;
  vegetarian?: boolean;
  vegan?: boolean;
  allergens?: string;
  /** True while the line is PitchRadar's draft and not the client's answer. */
  confirmationRequired?: boolean;
}

export interface ClientIntakeView {
  storage: "postgres" | "local_json";
  sections: IntakeSectionDefinition[];
  answers: IntakeRecord;
  status: Record<string, IntakeSectionStatus>;
  progress: {
    totalFields: number;
    answered: number;
    deferred: number;
    outstanding: number;
    sectionsComplete: number;
    sectionsTotal: number;
  };
  prefill: Record<string, Record<string, IntakeValue>>;
  menu: IntakeMenuItem[];
  menuConfirmedAt: string | null;
  menuLinesNeedingConfirmation: number;
  intakeCompletedAt: string | null;
  missingInputs: string[];
}

export class IntakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

export class UnknownIntakeSectionError extends Error {
  constructor(sectionId: string) {
    super(`Intake section "${sectionId}" does not exist.`);
    this.name = "UnknownIntakeSectionError";
  }
}

const YES_NO_EXPIRED: IntakeFieldOption[] = [
  { value: "yes", label: "Yes, current" },
  { value: "no", label: "No, not held" },
  { value: "expired", label: "Held but expired" }
];

const GERMAN_STATES: IntakeFieldOption[] = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen"
].map((name) => ({ value: name, label: name }));

/**
 * The ten intake sections. Order is the order the client fills them in.
 * Every field carries a label and a helper line; "unlocks" is written only
 * where the product genuinely gains a capability from the answer.
 */
export const INTAKE_SECTIONS: IntakeSectionDefinition[] = [
  {
    id: "business_contact",
    title: "Business & contact",
    intro: "Who you are on paper, and how organizers reach you.",
    unlocks: "Lets PitchRadar prepare applications with your real business details instead of placeholders.",
    fields: [
      { id: "legalName", kind: "text", label: "Legal business name", helper: "Exactly as it appears on your Gewerbeanmeldung.", unlocks: "Used verbatim on every application form.", maxLength: 160 },
      { id: "tradingName", kind: "text", label: "Display / trading name", helper: "The name the public sees on the truck.", maxLength: 160 },
      { id: "ownerName", kind: "text", label: "Owner full name", helper: "The person responsible for the business.", maxLength: 160 },
      { id: "email", kind: "email", label: "Business email", helper: "Where organizers should reply. International addresses are fine.", unlocks: "Lets PitchRadar draft email applications addressed from you." },
      { id: "phone", kind: "phone", label: "Business phone", helper: "Include the country code, e.g. +49 …" },
      { id: "whatsappNumber", kind: "phone", label: "WhatsApp number", helper: "Leave empty if you do not want WhatsApp used at all." },
      { id: "whatsappOptIn", kind: "consent", label: "WhatsApp opt-in", helper: "Switch on only if you want PitchRadar to reach you on WhatsApp. Timestamped when you do.", unlocks: "Turns on the WhatsApp channel; without it PitchRadar stays inside this app." },
      { id: "website", kind: "url", label: "Website", helper: "Full address, e.g. https://…" },
      { id: "instagram", kind: "text", label: "Instagram", helper: "Handle or profile link.", maxLength: 160 },
      { id: "facebook", kind: "text", label: "Facebook", helper: "Page name or link.", maxLength: 160 },
      {
        id: "preferredLanguage",
        kind: "select",
        label: "Preferred language",
        helper: "The language PitchRadar writes to you in. Applications to German organizers stay German either way.",
        options: [
          { value: "de", label: "Deutsch" },
          { value: "en", label: "English" }
        ]
      },
      { id: "vatNumber", kind: "text", label: "VAT / tax number", helper: "Optional. Some organizers ask for it (USt-IdNr. or Steuernummer).", maxLength: 60 }
    ]
  },
  {
    id: "home_base",
    title: "Home base & travel",
    intro: "Where every journey starts, and how far you are willing to go.",
    unlocks: "Turns on travel time and distance on every single event — today they are blank because the starting point is missing.",
    fields: [
      { id: "streetAddress", kind: "text", label: "Exact street address", helper: "Street and number where the truck is parked between events.", maxLength: 200 },
      { id: "postcode", kind: "postcode", label: "Postcode", helper: "Five digits, e.g. 10115.", unlocks: "REQUIRED: without it PitchRadar cannot calculate travel time or distance for any event.", required: true },
      { id: "city", kind: "text", label: "City", helper: "The town your postcode belongs to.", maxLength: 120 },
      { id: "normalMaxTravelMinutes", kind: "integer", label: "Normal maximum travel time", helper: "One-way, in minutes. 480 minutes = 8 hours.", unit: "minutes", unlocks: "Events beyond this are ranked down instead of filling your shortlist.", min: 1, max: 1440 },
      { id: "exceptionalMaxTravelMinutes", kind: "integer", label: "Absolute maximum for an exceptional opportunity", helper: "One-way, in minutes. Must be at least your normal maximum.", unit: "minutes", min: 1, max: 1440 },
      { id: "overnightPossible", kind: "boolean", label: "Willing to stay overnight", helper: "Yes if you can sleep away from home for an event.", unlocks: "Opens multi-day and long-distance events for ranking." },
      { id: "maxConsecutiveNights", kind: "integer", label: "Maximum consecutive nights away", helper: "How many nights in a row you can be away.", unit: "nights", min: 0, max: 60 },
      {
        id: "operatingDays",
        kind: "weekdays",
        label: "Operating days",
        helper: "The days you normally trade. PitchRadar has Friday, Saturday and Sunday on record — confirm or change.",
        unlocks: "Events that do not run on your days stop competing for your attention."
      },
      { id: "thursdayPossible", kind: "boolean", label: "Thursday possible", helper: "PitchRadar has this recorded as yes — confirm or change.", unlocks: "Lets four-day events be ranked as full weekends." },
      { id: "blackoutDates", kind: "stringlist", label: "Blackout / unavailable dates", helper: "One entry per line, e.g. \"2026-12-24\" or \"first two weeks of August\".", unlocks: "Events on these dates are never suggested." }
    ]
  },
  {
    id: "menu",
    title: "Menu — confirm or correct",
    intro: "PitchRadar drafted this menu from what the founder wrote down. None of it is confirmed by you yet.",
    unlocks: "A confirmed menu is what goes into every application, and it is the basis of every revenue estimate.",
    fields: [
      {
        id: "signatureDish",
        kind: "longtext",
        label: "Signature dish / what makes your speciality different",
        helper: "A few honest sentences. Organizers choose between vendors with this.",
        unlocks: "Becomes the heart of your application text instead of a generic description.",
        maxLength: 1200
      }
    ]
  },
  {
    id: "capacity",
    title: "Capacity & throughput",
    intro: "What you can realistically serve — not the best hour you ever had.",
    unlocks: "Lets PitchRadar judge whether a large event is an opportunity or a queue you cannot serve.",
    fields: [
      { id: "portionsPerHour", kind: "integer", label: "Realistic portions per hour, sustained", helper: "The rate you can hold for hours, not a peak.", unit: "portions/h", unlocks: "Caps every revenue estimate at what you can actually produce.", min: 0, max: 2000 },
      { id: "portionsPerDay", kind: "integer", label: "Maximum portions per day", helper: "Everything the truck can deliver in one full trading day.", unit: "portions/day", min: 0, max: 20000 },
      { id: "staffCount", kind: "integer", label: "Staff working the truck", helper: "How many people are on the truck during service, including you.", unit: "people", unlocks: "Feeds staff cost into the margin forecast.", min: 0, max: 50 },
      { id: "setupMinutes", kind: "integer", label: "Minutes needed to set up", helper: "From arriving on the pitch to being ready to sell.", unit: "minutes", min: 0, max: 1440 },
      { id: "packdownMinutes", kind: "integer", label: "Minutes to pack down", helper: "From last sale to being ready to drive away.", unit: "minutes", min: 0, max: 1440 },
      { id: "twoServiceWindows", kind: "boolean", label: "Can you run two service windows", helper: "For example a lunch block and an evening block on the same day." }
    ]
  },
  {
    id: "economics",
    title: "Economics",
    intro: "The numbers behind every recommendation. PitchRadar will not invent a single one of them.",
    unlocks: "Unlocks real margin forecasts: until these are known, every profit figure stays deliberately blank.",
    fields: [
      { id: "foodCostPerPortion", kind: "money", label: "Food cost per portion", helper: "Ingredients only, per sold portion.", unit: "€", unlocks: "Turns revenue estimates into margin estimates.", min: 0, max: 1000 },
      { id: "packagingCostPerPortion", kind: "money", label: "Packaging cost per portion", helper: "Plate, napkin, bag — per sold portion.", unit: "€", min: 0, max: 1000 },
      { id: "staffCostPerPersonPerDay", kind: "money", label: "Staff cost per person per day", helper: "What one person on the truck costs you for one trading day.", unit: "€", min: 0, max: 5000 },
      { id: "travelCostPerKm", kind: "money", label: "Fuel / travel cost per km", helper: "Fuel plus wear, per kilometre driven.", unit: "€/km", unlocks: "With your postcode, this prices the journey to every event.", min: 0, max: 100 },
      { id: "overnightCostPerNight", kind: "money", label: "Overnight accommodation cost per night", helper: "What a night away actually costs you.", unit: "€", min: 0, max: 5000 },
      { id: "maxPitchFeeEur", kind: "money", label: "Maximum acceptable pitch fee per event", helper: "Above this, an event is not worth applying to.", unit: "€", unlocks: "Events above your ceiling are rejected before they reach your shortlist.", min: 0, max: 100000 },
      { id: "maxRevenueSharePercent", kind: "percent", label: "Maximum acceptable revenue share", helper: "The highest percentage of turnover you will hand to an organizer.", unit: "%", min: 0, max: 100 },
      { id: "minRevenuePerEventDay", kind: "money", label: "Minimum acceptable revenue per event day", helper: "Below this a trading day is not worth doing.", unit: "€", min: 0, max: 1000000 },
      { id: "minProfitPerEvent", kind: "money", label: "Minimum acceptable profit per event", helper: "What has to be left over after every cost.", unit: "€", unlocks: "Becomes the go / no-go line on every ranked event.", min: 0, max: 1000000 }
    ]
  },
  {
    id: "truck_technical",
    title: "Truck & technical",
    intro: "The physical facts of the truck. These are hard gates: an event that cannot supply them is rejected automatically.",
    unlocks: "Removes every event whose pitch, power, water or gas provision cannot physically host you.",
    fields: [
      {
        id: "vehicleType",
        kind: "select",
        label: "Vehicle type",
        helper: "What actually arrives on the pitch.",
        hardGate: true,
        options: [
          { value: "trailer", label: "Trailer (Anhänger)" },
          { value: "truck", label: "Truck (LKW)" },
          { value: "van", label: "Van (Transporter)" }
        ]
      },
      { id: "lengthM", kind: "dimension", label: "Length", helper: "Vehicle length in metres.", unit: "m", hardGate: true, min: 0, max: 30 },
      { id: "widthM", kind: "dimension", label: "Width", helper: "Vehicle width in metres.", unit: "m", hardGate: true, min: 0, max: 15 },
      { id: "heightM", kind: "dimension", label: "Height", helper: "Vehicle height in metres, including anything on the roof.", unit: "m", hardGate: true, min: 0, max: 10 },
      { id: "pitchLengthM", kind: "dimension", label: "Total pitch length needed", helper: "Including awning, drawbar and service side.", unit: "m", hardGate: true, unlocks: "Events with smaller pitches are rejected instead of wasting an application.", min: 0, max: 40 },
      { id: "pitchWidthM", kind: "dimension", label: "Total pitch width needed", helper: "Including awning and the side you serve from.", unit: "m", hardGate: true, min: 0, max: 20 },
      { id: "weightKg", kind: "integer", label: "Weight", helper: "Total weight in kilograms, ready to trade.", unit: "kg", hardGate: true, min: 0, max: 40000 },
      { id: "powerKw", kind: "money", label: "Power requirement", helper: "Total kilowatts you need at the pitch.", unit: "kW", hardGate: true, unlocks: "Events whose power provision is below this are rejected automatically.", min: 0, max: 500 },
      {
        id: "voltage",
        kind: "select",
        label: "Voltage",
        helper: "What your connection expects.",
        hardGate: true,
        options: [
          { value: "230", label: "230 V" },
          { value: "400", label: "400 V" }
        ]
      },
      {
        id: "phases",
        kind: "select",
        label: "Phases",
        helper: "Single phase or three phase.",
        hardGate: true,
        options: [
          { value: "1", label: "1 phase" },
          { value: "3", label: "3 phase" }
        ]
      },
      {
        id: "amperage",
        kind: "select",
        label: "Amperage",
        helper: "The CEE socket you need.",
        hardGate: true,
        options: [
          { value: "16", label: "16 A" },
          { value: "32", label: "32 A" },
          { value: "63", label: "63 A" }
        ]
      },
      { id: "ownGenerator", kind: "boolean", label: "Own generator", helper: "Yes if you can run without organizer power.", unlocks: "Keeps events with no power supply in play instead of rejecting them." },
      { id: "generatorKw", kind: "money", label: "Generator output", helper: "Kilowatts your generator delivers. Leave unknown if you have none.", unit: "kW", min: 0, max: 500 },
      { id: "freshWaterLitresPerDay", kind: "integer", label: "Fresh water needed", helper: "Litres per trading day.", unit: "l/day", hardGate: true, min: 0, max: 10000 },
      { id: "waterConnectionRequired", kind: "boolean", label: "Water connection required", helper: "Yes if you need a tap on the pitch rather than your own tank.", hardGate: true },
      { id: "wastewaterHandling", kind: "text", label: "Wastewater handling", helper: "For example \"own 120 l tank, emptied on site\".", maxLength: 240 },
      { id: "gasType", kind: "text", label: "Gas type", helper: "For example Propan or Butan.", hardGate: true, maxLength: 120 },
      { id: "gasBottleCount", kind: "integer", label: "Number of gas bottles", helper: "How many bottles are on board during trading.", unit: "bottles", hardGate: true, min: 0, max: 50 },
      { id: "refrigerationNeeds", kind: "longtext", label: "Refrigeration needs", helper: "Fridges, freezers and whether they must run overnight.", maxLength: 800 },
      {
        id: "servingSide",
        kind: "select",
        label: "Serving side",
        helper: "Which side customers are served from, seen from behind the vehicle.",
        hardGate: true,
        unlocks: "Lets an organizer place you correctly the first time.",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
          { value: "rear", label: "Rear" }
        ]
      }
    ]
  },
  {
    id: "documents",
    title: "Documents & compliance",
    intro: "For each one: do you hold it, its reference where relevant, and when it expires.",
    unlocks: "PitchRadar can flag an application you cannot legally complete before you spend time on it — and warn you before a document expires mid-season.",
    fields: [
      { id: "gewerbeanmeldung", kind: "document", label: "Gewerbeanmeldung", helper: "Your business registration.", parts: ["reference"], options: YES_NO_EXPIRED },
      { id: "reisegewerbekarte", kind: "document", label: "Reisegewerbekarte", helper: "Travelling trade card. Many Volksfeste ask for it.", parts: ["reference", "expiry"], options: YES_NO_EXPIRED },
      { id: "ifsg43", kind: "document", label: "§43 IfSG Belehrung", helper: "Required per staff member handling food.", parts: ["expiry"], options: YES_NO_EXPIRED },
      { id: "hygieneHaccp", kind: "document", label: "Food hygiene / HACCP concept", helper: "Your written hygiene concept.", parts: ["expiry"], options: YES_NO_EXPIRED },
      { id: "publicLiabilityInsurance", kind: "document", label: "Public liability insurance", helper: "Betriebshaftpflicht — insurer, policy number and expiry.", parts: ["issuer", "reference", "expiry"], options: YES_NO_EXPIRED, unlocks: "Almost every organizer asks for the certificate up front." },
      { id: "vehicleInsurance", kind: "document", label: "Vehicle insurance", helper: "For the truck or trailer itself.", parts: ["issuer", "reference", "expiry"], options: YES_NO_EXPIRED },
      { id: "gasInspection", kind: "document", label: "Gas system inspection (Gasprüfung)", helper: "The certificate and its expiry date.", parts: ["expiry"], options: YES_NO_EXPIRED, unlocks: "Checked against every event that inspects gas on arrival." },
      { id: "electricalInspection", kind: "document", label: "Electrical inspection (E-Check)", helper: "The certificate and its expiry date.", parts: ["expiry"], options: YES_NO_EXPIRED },
      { id: "healthOfficeRegistration", kind: "document", label: "Health office registration", helper: "Registration with the Gesundheitsamt / Lebensmittelüberwachung.", parts: ["reference", "expiry"], options: YES_NO_EXPIRED }
    ]
  },
  {
    id: "application_material",
    title: "Application material",
    intro: "Uploads come later. For now just tell PitchRadar what exists and, if it is online, where.",
    unlocks: "An application with photos is answered far more often than one without. PitchRadar can tell you exactly which piece is missing.",
    fields: [
      { id: "truckExteriorPhoto", kind: "asset", label: "Truck exterior photo", helper: "The whole vehicle, set up and open." },
      { id: "servingCounterPhoto", kind: "asset", label: "Serving / counter photo", helper: "The counter as a customer sees it." },
      { id: "foodCloseUpPhoto", kind: "asset", label: "Food close-up photo", helper: "One good, sharp photo of the speciality itself." },
      { id: "teamPhoto", kind: "asset", label: "Team photo", helper: "You and the people working the truck." },
      { id: "logoFile", kind: "asset", label: "Logo file", helper: "Ideally a PNG or SVG with a transparent background." },
      { id: "vendorApplicationPdf", kind: "asset", label: "Existing vendor application PDF", helper: "Any application you have already filled in for another event." },
      { id: "kurzvorstellung", kind: "longtext", label: "Short German business introduction (Kurzvorstellung)", helper: "About 60 words, in German. Organizers read this first.", unlocks: "Becomes the opening paragraph of every German application.", maxLength: 1200 },
      { id: "longDescription", kind: "longtext", label: "Longer description", helper: "The full story: your speciality, your equipment, your experience.", maxLength: 4000 }
    ]
  },
  {
    id: "history_preferences",
    title: "Event history & preferences",
    intro: "What you have already done, and what you want more of.",
    unlocks: "Past results and stated preferences move matching events up your ranking — and keep known-bad organizers out of it.",
    fields: [
      { id: "pastEvents", kind: "event_history", label: "Past events", helper: "Add one row per event: name, city, year, how it went, and whether you would return." },
      { id: "bestEvent", kind: "longtext", label: "Best event ever, and why", helper: "What made it work — location, crowd, organizer, pitch?", unlocks: "PitchRadar looks for the same pattern in new events.", maxLength: 1200 },
      { id: "worstExperience", kind: "longtext", label: "Worst experience, and why", helper: "Be blunt. This is how PitchRadar learns what to keep away from you.", maxLength: 1200 },
      {
        id: "preferredEventTypes",
        kind: "multiselect",
        label: "Preferred event types",
        helper: "Pick every type you want to be offered.",
        options: [
          { value: "stadtfest", label: "Stadtfest" },
          { value: "volksfest", label: "Volksfest" },
          { value: "weihnachtsmarkt", label: "Weihnachtsmarkt" },
          { value: "foodtruck_festival", label: "Foodtruck festival" },
          { value: "street_food_festival", label: "Street-food festival" },
          { value: "market", label: "Market" },
          { value: "corporate_private", label: "Corporate / private" },
          { value: "sport_event", label: "Sport event" }
        ]
      },
      { id: "preferredRegions", kind: "multiselect", label: "Preferred regions / states", helper: "Where you actually want to trade.", options: GERMAN_STATES },
      { id: "organizersToAvoid", kind: "longtext", label: "Organizers to avoid", helper: "Names and, if you want, one line on why. PitchRadar will not suggest them again.", maxLength: 1200 }
    ]
  },
  {
    id: "consent_authority",
    title: "Consent & authority",
    intro: "Nothing leaves PitchRadar without your approval. These answers are recorded with a timestamp.",
    unlocks: "Lets PitchRadar hold your business data and prepare drafts. Sending always remains a separate decision by you.",
    fields: [
      { id: "consentStoreBusinessData", kind: "consent", label: "I consent to PitchRadar storing this business data for event applications", helper: "Required. Without it PitchRadar cannot keep your details at all.", required: true },
      { id: "consentPrepareDrafts", kind: "consent", label: "I consent to PitchRadar preparing draft applications on my behalf", helper: "Drafts only. They wait for you.", unlocks: "Lets PitchRadar write applications ahead of a deadline so you only have to approve them." },
      { id: "neverSendsWithoutApproval", kind: "statement", label: "PitchRadar never sends anything without your approval", helper: "This is how the product is built, not a setting. No outbound connector is enabled." },
      { id: "authorisedApproverName", kind: "text", label: "Who is authorised to approve", helper: "The name of the person who may approve an application.", maxLength: 160 },
      { id: "authorisedApproverRole", kind: "text", label: "Their role", helper: "For example Owner, Partner, Manager.", maxLength: 120 }
    ]
  }
];

const SECTION_BY_ID = new Map(INTAKE_SECTIONS.map((section) => [section.id, section]));

/** Display-only statements are never answerable and never counted. */
function answerableFields(section: IntakeSectionDefinition) {
  return section.fields.filter((field) => field.kind !== "statement");
}

export function intakeSchema(): IntakeSectionDefinition[] {
  return INTAKE_SECTIONS;
}

export function totalIntakeFields() {
  return INTAKE_SECTIONS.reduce((sum, section) => sum + answerableFields(section).length, 0);
}

/* ------------------------------------------------------------------ *
 * Validation. Nothing below may invent a value.
 * ------------------------------------------------------------------ */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s().\/-]{4,31}$/;
const POSTCODE_PATTERN = /^\d{5}$/;
const URL_PATTERN = /^https?:\/\/[^\s]{3,}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function blank(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function text(value: unknown, limit: number, label: string) {
  if (typeof value !== "string") throw new IntakeValidationError(`${label} must be text.`);
  // Free text is clamped, not rejected: the client should never lose a save
  // because they wrote one sentence too many.
  return value.trim().slice(0, limit);
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IntakeValidationError(`${label} must be a number.`);
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    const parsed = Number(normalized);
    if (normalized === "" || !Number.isFinite(parsed)) {
      throw new IntakeValidationError(`${label} must be a number.`);
    }
    return parsed;
  }
  throw new IntakeValidationError(`${label} must be a number.`);
}

function boolean(value: unknown, label: string) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  throw new IntakeValidationError(`${label} must be yes or no.`);
}

function round(value: number, places: number) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function isoDate(value: unknown, label: string) {
  const raw = text(value, 10, label);
  if (!DATE_PATTERN.test(raw)) {
    throw new IntakeValidationError(`${label} must be a date in the form YYYY-MM-DD.`);
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new IntakeValidationError(`${label} is not a real date.`);
  }
  return raw;
}

function optionalPart(source: Record<string, unknown>, key: string, limit: number, label: string) {
  const raw = source[key];
  if (blank(raw)) return undefined;
  return text(raw, limit, label);
}

function coerceValue(field: IntakeFieldDefinition, raw: unknown): IntakeValue {
  const label = field.label;
  switch (field.kind) {
    case "text":
      return text(raw, field.maxLength ?? 240, label);
    case "longtext":
      return text(raw, field.maxLength ?? 4000, label);
    case "email": {
      const value = text(raw, 200, label).toLowerCase();
      if (!EMAIL_PATTERN.test(value)) {
        throw new IntakeValidationError(`${label} does not look like an email address.`);
      }
      return value;
    }
    case "phone": {
      const value = text(raw, 40, label);
      if (!PHONE_PATTERN.test(value)) {
        throw new IntakeValidationError(`${label} does not look like a phone number.`);
      }
      return value;
    }
    case "url": {
      const typed = text(raw, 300, label);
      const value = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
      if (!URL_PATTERN.test(value)) {
        throw new IntakeValidationError(`${label} must be a web address.`);
      }
      return value;
    }
    case "postcode": {
      const value = text(raw, 16, label).replace(/\s+/g, "");
      if (!POSTCODE_PATTERN.test(value)) {
        throw new IntakeValidationError(`${label} must be a 5-digit German postcode.`);
      }
      return value;
    }
    case "integer": {
      const value = Math.round(finiteNumber(raw, label));
      const min = field.min ?? 0;
      const max = field.max ?? 1_000_000;
      if (value < min) throw new IntakeValidationError(`${label} cannot be lower than ${min}.`);
      return Math.min(value, max);
    }
    case "money": {
      const value = round(finiteNumber(raw, label), 2);
      const min = field.min ?? 0;
      const max = field.max ?? 1_000_000;
      if (value < min) throw new IntakeValidationError(`${label} cannot be negative.`);
      return Math.min(value, max);
    }
    case "percent": {
      const value = round(finiteNumber(raw, label), 2);
      if (value < 0 || value > 100) {
        throw new IntakeValidationError(`${label} must be between 0 and 100.`);
      }
      return value;
    }
    case "dimension": {
      const value = round(finiteNumber(raw, label), 3);
      if (value <= 0) throw new IntakeValidationError(`${label} must be greater than zero.`);
      return Math.min(value, field.max ?? 100);
    }
    case "boolean":
    case "consent":
      return boolean(raw, label);
    case "select": {
      const value = text(raw, 80, label);
      if (!field.options?.some((option) => option.value === value)) {
        throw new IntakeValidationError(`${label} must be one of the offered options.`);
      }
      return value;
    }
    case "multiselect": {
      if (!Array.isArray(raw)) throw new IntakeValidationError(`${label} must be a list of options.`);
      const values = [...new Set(raw.map((entry) => text(entry, 80, label)))];
      for (const value of values) {
        if (!field.options?.some((option) => option.value === value)) {
          throw new IntakeValidationError(`${label} contains an option that does not exist.`);
        }
      }
      return values;
    }
    case "weekdays": {
      if (!Array.isArray(raw)) throw new IntakeValidationError(`${label} must be a list of weekdays.`);
      const days = [...new Set(raw.map((entry) => Math.round(finiteNumber(entry, label))))];
      for (const day of days) {
        if (day < 0 || day > 6) throw new IntakeValidationError(`${label} must use 0 (Sunday) to 6 (Saturday).`);
      }
      return days.sort((a, b) => a - b);
    }
    case "stringlist": {
      if (!Array.isArray(raw)) throw new IntakeValidationError(`${label} must be a list.`);
      return raw
        .map((entry) => text(entry, 120, label))
        .filter((entry) => entry !== "")
        .slice(0, 40);
    }
    case "document": {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new IntakeValidationError(`${label} must record whether you hold it.`);
      }
      const source = raw as Record<string, unknown>;
      const held = text(source.held, 16, label);
      if (!["yes", "no", "expired"].includes(held)) {
        throw new IntakeValidationError(`${label} must be recorded as yes, no or expired.`);
      }
      const value: IntakeDocumentValue = { held: held as IntakeDocumentValue["held"] };
      const reference = optionalPart(source, "reference", 120, `${label} reference`);
      if (reference) value.reference = reference;
      const issuer = optionalPart(source, "issuer", 160, `${label} issuer`);
      if (issuer) value.issuer = issuer;
      if (!blank(source.expiry)) value.expiry = isoDate(source.expiry, `${label} expiry date`);
      return value;
    }
    case "asset": {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new IntakeValidationError(`${label} must record whether you have it.`);
      }
      const source = raw as Record<string, unknown>;
      const value: IntakeAssetValue = { have: boolean(source.have, label) };
      if (!blank(source.link)) {
        const link = text(source.link, 300, `${label} link`);
        const normalized = /^https?:\/\//i.test(link) ? link : `https://${link}`;
        if (!URL_PATTERN.test(normalized)) {
          throw new IntakeValidationError(`${label} link must be a web address.`);
        }
        value.link = normalized;
      }
      const note = optionalPart(source, "note", 400, `${label} note`);
      if (note) value.note = note;
      return value;
    }
    case "event_history": {
      if (!Array.isArray(raw)) throw new IntakeValidationError(`${label} must be a list of events.`);
      return raw.slice(0, 40).map((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new IntakeValidationError(`Past event ${index + 1} is not filled in.`);
        }
        const source = entry as Record<string, unknown>;
        const name = text(source.name, 160, `Past event ${index + 1} name`);
        if (!name) throw new IntakeValidationError(`Past event ${index + 1} needs a name.`);
        const row: IntakePastEvent = { name };
        const city = optionalPart(source, "city", 120, `Past event ${index + 1} city`);
        if (city) row.city = city;
        if (!blank(source.year)) {
          const year = Math.round(finiteNumber(source.year, `Past event ${index + 1} year`));
          if (year < 1950 || year > 2100) {
            throw new IntakeValidationError(`Past event ${index + 1} year must be between 1950 and 2100.`);
          }
          row.year = year;
        }
        if (!blank(source.outcome)) {
          const outcome = text(source.outcome, 16, `Past event ${index + 1} outcome`);
          if (!["strong", "ok", "poor"].includes(outcome)) {
            throw new IntakeValidationError(`Past event ${index + 1} outcome must be strong, ok or poor.`);
          }
          row.outcome = outcome as IntakePastEvent["outcome"];
        }
        if (!blank(source.wouldReturn)) {
          row.wouldReturn = boolean(source.wouldReturn, `Past event ${index + 1} return answer`);
        }
        const notes = optionalPart(source, "notes", 600, `Past event ${index + 1} notes`);
        if (notes) row.notes = notes;
        return row;
      });
    }
    case "statement":
      throw new IntakeValidationError(`${label} is display-only and cannot be answered.`);
    default:
      throw new IntakeValidationError(`${label} has an unsupported field type.`);
  }
}

/**
 * Validates one section's supplied answers. Fields that are not supplied are
 * left alone by the caller (a partial save), so autosave can send one field.
 *
 * A blank never becomes a zero: it is stored as `{ value: null, state:
 * "unknown" }` with a timestamp, which is exactly how "I don't know yet" is
 * recorded too. That is a real answer, and it stays visible as unknown.
 */
export function validateSectionAnswers(
  sectionId: string,
  input: unknown,
  now = new Date().toISOString()
): IntakeSectionAnswers {
  const section = SECTION_BY_ID.get(sectionId);
  if (!section) throw new UnknownIntakeSectionError(sectionId);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new IntakeValidationError("answers must be an object of field values.");
  }
  const supplied = input as Record<string, unknown>;
  const result: IntakeSectionAnswers = {};

  for (const [fieldId, entry] of Object.entries(supplied)) {
    const field = section.fields.find((candidate) => candidate.id === fieldId);
    if (!field) {
      throw new IntakeValidationError(`Field "${fieldId}" does not exist in section "${sectionId}".`);
    }
    if (field.kind === "statement") {
      throw new IntakeValidationError(`${field.label} is display-only and cannot be answered.`);
    }

    // Both shapes are accepted: a bare value, or { value, state }.
    const wrapped = typeof entry === "object" && entry !== null && !Array.isArray(entry) && "value" in entry
      ? entry as { value: unknown; state?: unknown }
      : { value: entry };
    const requestedState = typeof wrapped.state === "string" ? wrapped.state : undefined;
    if (requestedState && !["unknown", "provided", "confirmed"].includes(requestedState)) {
      throw new IntakeValidationError(`Field "${fieldId}" has an unsupported state.`);
    }

    if (requestedState === "unknown" || blank(wrapped.value)) {
      result[fieldId] = { value: null, state: "unknown", updatedAt: now };
      continue;
    }

    const value = coerceValue(field, wrapped.value);
    // A cleared list or emptied string comes back blank after coercion: it is
    // still an unknown, never a zero-length "answer".
    if (blank(value) && typeof value !== "boolean" && typeof value !== "number") {
      result[fieldId] = { value: null, state: "unknown", updatedAt: now };
      continue;
    }
    const answer: IntakeAnswer = {
      value,
      state: requestedState === "confirmed" ? "confirmed" : "provided",
      updatedAt: now
    };
    if (field.kind === "consent" && value === true) answer.consentedAt = now;
    result[fieldId] = answer;
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Menu
 * ------------------------------------------------------------------ */

export function normalizeMenuItems(input: unknown): IntakeMenuItem[] {
  if (!Array.isArray(input)) {
    throw new IntakeValidationError("items must be a list of menu lines.");
  }
  if (input.length > 60) {
    throw new IntakeValidationError("A menu cannot hold more than 60 lines.");
  }
  return input.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new IntakeValidationError(`Menu line ${index + 1} is not filled in.`);
    }
    const source = entry as Record<string, unknown>;
    const name = text(source.name, 120, `Menu line ${index + 1} name`);
    if (!name) throw new IntakeValidationError(`Menu line ${index + 1} needs a name.`);
    const priceEur = round(finiteNumber(source.priceEur, `Menu line ${index + 1} price`), 2);
    if (priceEur < 0) throw new IntakeValidationError(`Menu line ${index + 1} price cannot be negative.`);
    if (priceEur > 1000) throw new IntakeValidationError(`Menu line ${index + 1} price is not plausible.`);
    const item: IntakeMenuItem = { name, priceEur, confirmationRequired: false };
    const description = optionalPart(source, "description", 400, `Menu line ${index + 1} description`);
    if (description) item.description = description;
    if (!blank(source.vegetarian)) item.vegetarian = boolean(source.vegetarian, `Menu line ${index + 1} vegetarian`);
    if (!blank(source.vegan)) item.vegan = boolean(source.vegan, `Menu line ${index + 1} vegan`);
    const allergens = optionalPart(source, "allergens", 400, `Menu line ${index + 1} allergens`);
    if (allergens) item.allergens = allergens;
    return item;
  });
}

function readStoredMenu(value: unknown): IntakeMenuItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is IntakeMenuItem =>
    typeof entry === "object" && entry !== null && typeof (entry as IntakeMenuItem).name === "string");
}

/* ------------------------------------------------------------------ *
 * Progress + missing inputs
 * ------------------------------------------------------------------ */

export function sectionStatus(
  section: IntakeSectionDefinition,
  answers: IntakeSectionAnswers | undefined,
  menuConfirmedAt: string | null
): IntakeSectionStatus {
  const fields = answerableFields(section);
  let answered = 0;
  let deferred = 0;
  let updatedAt: string | undefined;
  for (const field of fields) {
    const answer = answers?.[field.id];
    if (!answer) continue;
    if (answer.state === "unknown") deferred += 1;
    else answered += 1;
    if (!updatedAt || answer.updatedAt > updatedAt) updatedAt = answer.updatedAt;
  }
  const touched = answered + deferred;
  // The menu section is only complete once the client has confirmed the list
  // itself — the fields alone can never complete it.
  const complete = touched === fields.length && (section.id !== "menu" || Boolean(menuConfirmedAt));
  return {
    total: fields.length,
    answered,
    deferred,
    untouched: fields.length - touched,
    complete,
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function intakeStatus(intake: IntakeRecord, menuConfirmedAt: string | null) {
  const status: Record<string, IntakeSectionStatus> = {};
  for (const section of INTAKE_SECTIONS) {
    status[section.id] = sectionStatus(section, intake[section.id], menuConfirmedAt);
  }
  return status;
}

function known(intake: IntakeRecord, sectionId: string, fieldId: string) {
  const answer = intake[sectionId]?.[fieldId];
  return Boolean(answer) && answer.state !== "unknown" && answer.value !== null;
}

function knownAll(intake: IntakeRecord, sectionId: string, fieldIds: string[]) {
  return fieldIds.every((fieldId) => known(intake, sectionId, fieldId));
}

/**
 * The single source of truth for "what is still missing". Every label here is
 * one the rest of the product already speaks (see src/profile.ts), plus the two
 * the intake itself introduces: an unconfirmed menu and missing consent.
 */
const MISSING_INPUT_RULES: Array<{
  label: string;
  satisfied: (intake: IntakeRecord, menuConfirmedAt: string | null) => boolean;
}> = [
  {
    label: "Client confirmation of the menu names and prices",
    satisfied: (_intake, menuConfirmedAt) => Boolean(menuConfirmedAt)
  },
  {
    label: "Exact postcode / starting address",
    satisfied: (intake) => knownAll(intake, "home_base", ["postcode", "streetAddress"])
  },
  {
    label: "Portions per hour and per day",
    satisfied: (intake) => knownAll(intake, "capacity", ["portionsPerHour", "portionsPerDay"])
  },
  {
    label: "Food, labour and travel costs",
    satisfied: (intake) => knownAll(intake, "economics", [
      "foodCostPerPortion",
      "staffCostPerPersonPerDay",
      "travelCostPerKm"
    ])
  },
  {
    label: "Truck dimensions and pitch footprint",
    satisfied: (intake) => knownAll(intake, "truck_technical", [
      "lengthM",
      "widthM",
      "heightM",
      "pitchLengthM",
      "pitchWidthM"
    ])
  },
  {
    label: "Power, water and gas requirements",
    satisfied: (intake) => knownAll(intake, "truck_technical", [
      "powerKw",
      "voltage",
      "amperage",
      "freshWaterLitresPerDay",
      "waterConnectionRequired",
      "gasType"
    ])
  },
  {
    label: "Maximum pitch fee",
    satisfied: (intake) => known(intake, "economics", "maxPitchFeeEur")
  },
  {
    label: "Minimum revenue or margin",
    satisfied: (intake) =>
      known(intake, "economics", "minRevenuePerEventDay") ||
      known(intake, "economics", "minProfitPerEvent")
  },
  {
    label: "Permits, insurance and hygiene documents",
    satisfied: (intake) => knownAll(intake, "documents", [
      "gewerbeanmeldung",
      "publicLiabilityInsurance",
      "ifsg43",
      "hygieneHaccp"
    ])
  },
  {
    label: "Photos and existing application material",
    satisfied: (intake) => knownAll(intake, "application_material", [
      "truckExteriorPhoto",
      "servingCounterPhoto",
      "foodCloseUpPhoto",
      "kurzvorstellung"
    ])
  },
  {
    label: "WhatsApp number and consent",
    satisfied: (intake) => knownAll(intake, "business_contact", ["whatsappNumber", "whatsappOptIn"])
  },
  {
    label: "Consent to store business data for applications",
    satisfied: (intake) => intake.consent_authority?.consentStoreBusinessData?.value === true
  }
];

export function recomputeMissingInputs(
  intake: IntakeRecord,
  menuConfirmedAt: string | null
): string[] {
  return MISSING_INPUT_RULES
    .filter((rule) => !rule.satisfied(intake, menuConfirmedAt))
    .map((rule) => rule.label);
}

function intakeComplete(status: Record<string, IntakeSectionStatus>) {
  return INTAKE_SECTIONS.every((section) => status[section.id]?.complete);
}

/**
 * Projects intake answers onto the legacy profile columns the rest of the
 * product already reads. Only values that satisfy the table's own constraints
 * are returned; anything else is left exactly as it was.
 */
export function projectLegacyColumns(
  intake: IntakeRecord,
  current: {
    home_postcode: string | null;
    normal_days: number[];
    optional_thursday: boolean;
    preferred_max_travel_minutes: number;
    exceptional_max_travel_minutes: number;
  }
) {
  const next = { ...current };
  const postcode = intake.home_base?.postcode;
  if (postcode && postcode.state !== "unknown" && typeof postcode.value === "string") {
    next.home_postcode = postcode.value;
  }
  const days = intake.home_base?.operatingDays;
  if (days && days.state !== "unknown" && Array.isArray(days.value) && days.value.length) {
    next.normal_days = (days.value as number[]).filter((day) => Number.isInteger(day));
  }
  const thursday = intake.home_base?.thursdayPossible;
  if (thursday && thursday.state !== "unknown" && typeof thursday.value === "boolean") {
    next.optional_thursday = thursday.value;
  }
  const preferred = intake.home_base?.normalMaxTravelMinutes;
  if (preferred && preferred.state !== "unknown" && typeof preferred.value === "number" && preferred.value > 0) {
    next.preferred_max_travel_minutes = Math.round(preferred.value);
  }
  const exceptional = intake.home_base?.exceptionalMaxTravelMinutes;
  if (exceptional && exceptional.state !== "unknown" && typeof exceptional.value === "number" && exceptional.value > 0) {
    next.exceptional_max_travel_minutes = Math.round(exceptional.value);
  }
  // The table requires exceptional >= preferred; never write a row that would
  // violate it, and never silently lower what the owner already answered.
  if (next.exceptional_max_travel_minutes < next.preferred_max_travel_minutes) {
    next.exceptional_max_travel_minutes = next.preferred_max_travel_minutes;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Storage. PostgreSQL when configured; a local JSON file otherwise, so
 * local development and tests behave identically without ever touching
 * the owner's operating database.
 * ------------------------------------------------------------------ */

interface IntakeStoreState {
  version: 1;
  intake: IntakeRecord;
  intakeStatus: Record<string, IntakeSectionStatus>;
  menu: IntakeMenuItem[];
  menuConfirmedAt: string | null;
  intakeCompletedAt: string | null;
  missingInputs: string[];
  homePostcode: string | null;
  normalDays: number[];
  optionalThursday: boolean;
  preferredMaxTravelMinutes: number;
  exceptionalMaxTravelMinutes: number;
}

function runtimeDirectory() {
  return process.env.PITCHRADAR_RUNTIME_DIR || path.join(process.cwd(), ".pitchradar-runtime");
}

function intakePath() {
  return path.join(runtimeDirectory(), "client-intake.json");
}

function emptyLocalState(): IntakeStoreState {
  const intake: IntakeRecord = {};
  return {
    version: 1,
    intake,
    intakeStatus: intakeStatus(intake, null),
    // Two separate facts, never conflated: `menuConfirmedAt === null` means the
    // client has confirmed no line at all (the founder wrote the list), while
    // per-line `confirmationRequired` marks the lines whose name or composition
    // nobody can decode yet — Variante A, Variante B and Komplett.
    menu: fixtureProfile.menu.map((item) => ({ ...item })),
    menuConfirmedAt: null,
    intakeCompletedAt: null,
    missingInputs: recomputeMissingInputs(intake, null),
    homePostcode: fixtureProfile.homePostcode ?? null,
    normalDays: fixtureProfile.normalDays,
    optionalThursday: fixtureProfile.optionalThursday,
    preferredMaxTravelMinutes: fixtureProfile.preferredMaxTravelMinutes,
    exceptionalMaxTravelMinutes: fixtureProfile.exceptionalMaxTravelMinutes
  };
}

let localWriteQueue = Promise.resolve();

async function readLocalState(): Promise<IntakeStoreState> {
  try {
    const parsed = JSON.parse(await readFile(intakePath(), "utf8")) as Partial<IntakeStoreState>;
    const empty = emptyLocalState();
    return {
      ...empty,
      ...parsed,
      intake: parsed.intake || {},
      menu: readStoredMenu(parsed.menu).length ? readStoredMenu(parsed.menu) : empty.menu,
      menuConfirmedAt: parsed.menuConfirmedAt ?? null,
      intakeCompletedAt: parsed.intakeCompletedAt ?? null
    };
  } catch {
    return emptyLocalState();
  }
}

async function updateLocalState(
  updater: (state: IntakeStoreState) => IntakeStoreState
): Promise<IntakeStoreState> {
  let result = emptyLocalState();
  localWriteQueue = localWriteQueue.then(async () => {
    result = updater(await readLocalState());
    await mkdir(runtimeDirectory(), { recursive: true });
    const temporary = `${intakePath()}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
    await rename(temporary, intakePath());
  });
  await localWriteQueue;
  return result;
}

function isoOrNull(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stateFromRow(row: ClientProfileIntakeRow): IntakeStoreState {
  const intake = (row.intake || {}) as IntakeRecord;
  const menuConfirmedAt = isoOrNull(row.menu_confirmed_at);
  return {
    version: 1,
    intake,
    intakeStatus: intakeStatus(intake, menuConfirmedAt),
    // Stored flags are passed through untouched: they say "this line's name or
    // composition needs decoding", which is a different claim from "the client
    // has confirmed the list" (that one is menuConfirmedAt alone).
    menu: readStoredMenu(row.menu),
    menuConfirmedAt,
    intakeCompletedAt: isoOrNull(row.intake_completed_at),
    missingInputs: recomputeMissingInputs(intake, menuConfirmedAt),
    homePostcode: row.home_postcode,
    normalDays: row.normal_days || [],
    optionalThursday: row.optional_thursday,
    preferredMaxTravelMinutes: row.preferred_max_travel_minutes,
    exceptionalMaxTravelMinutes: row.exceptional_max_travel_minutes
  };
}

function viewFromState(
  state: IntakeStoreState,
  storage: ClientIntakeView["storage"]
): ClientIntakeView {
  const status = intakeStatus(state.intake, state.menuConfirmedAt);
  let answered = 0;
  let deferred = 0;
  let sectionsComplete = 0;
  for (const section of INTAKE_SECTIONS) {
    const entry = status[section.id];
    answered += entry.answered;
    deferred += entry.deferred;
    if (entry.complete) sectionsComplete += 1;
  }
  const totalFields = totalIntakeFields();
  return {
    storage,
    sections: INTAKE_SECTIONS,
    answers: state.intake,
    status,
    progress: {
      totalFields,
      answered,
      deferred,
      outstanding: totalFields - answered - deferred,
      sectionsComplete,
      sectionsTotal: INTAKE_SECTIONS.length
    },
    prefill: {
      home_base: {
        postcode: state.homePostcode,
        operatingDays: state.normalDays,
        thursdayPossible: state.optionalThursday,
        normalMaxTravelMinutes: state.preferredMaxTravelMinutes,
        exceptionalMaxTravelMinutes: state.exceptionalMaxTravelMinutes
      }
    },
    menu: state.menu,
    menuConfirmedAt: state.menuConfirmedAt,
    menuLinesNeedingConfirmation: state.menu.filter((item) => item.confirmationRequired).length,
    intakeCompletedAt: state.intakeCompletedAt,
    missingInputs: recomputeMissingInputs(state.intake, state.menuConfirmedAt)
  };
}

/**
 * Reads whichever store is actually in force, and says which one it was: the
 * marker must never claim PostgreSQL for a local file that happened to answer.
 */
async function currentState(): Promise<{
  state: IntakeStoreState;
  storage: ClientIntakeView["storage"];
}> {
  if (databaseConfigured()) {
    const row = await readClientProfileIntakeRow();
    if (row) return { state: stateFromRow(row), storage: "postgres" };
  }
  return { state: await readLocalState(), storage: "local_json" };
}

/** GET /api/profile/intake — schema, answers, and honest progress. */
export async function readClientIntake(): Promise<ClientIntakeView> {
  const current = await currentState();
  return viewFromState(current.state, current.storage);
}

function applySectionSave(
  state: IntakeStoreState,
  sectionId: string,
  validated: IntakeSectionAnswers,
  now: string
): IntakeStoreState {
  const intake: IntakeRecord = {
    ...state.intake,
    [sectionId]: { ...(state.intake[sectionId] || {}), ...validated }
  };
  const status = intakeStatus(intake, state.menuConfirmedAt);
  const legacy = projectLegacyColumns(intake, {
    home_postcode: state.homePostcode,
    normal_days: state.normalDays,
    optional_thursday: state.optionalThursday,
    preferred_max_travel_minutes: state.preferredMaxTravelMinutes,
    exceptional_max_travel_minutes: state.exceptionalMaxTravelMinutes
  });
  return {
    ...state,
    intake,
    intakeStatus: status,
    missingInputs: recomputeMissingInputs(intake, state.menuConfirmedAt),
    intakeCompletedAt: intakeComplete(status) ? state.intakeCompletedAt || now : null,
    homePostcode: legacy.home_postcode,
    normalDays: legacy.normal_days,
    optionalThursday: legacy.optional_thursday,
    preferredMaxTravelMinutes: legacy.preferred_max_travel_minutes,
    exceptionalMaxTravelMinutes: legacy.exceptional_max_travel_minutes
  };
}

/** PUT /api/profile/intake/:sectionId — validated, partial-by-design save. */
export async function saveClientIntakeSection(
  sectionId: string,
  answers: unknown
): Promise<ClientIntakeView> {
  const now = new Date().toISOString();
  const validated = validateSectionAnswers(sectionId, answers, now);

  if (databaseConfigured()) {
    const row = await withClientProfileIntakeLock((current) => {
      const next = applySectionSave(stateFromRow(current), sectionId, validated, now);
      return {
        intake: next.intake,
        intake_status: next.intakeStatus,
        menu: next.menu,
        menu_confirmed_at: next.menuConfirmedAt,
        intake_completed_at: next.intakeCompletedAt,
        missing_inputs: next.missingInputs,
        home_postcode: next.homePostcode,
        normal_days: next.normalDays,
        optional_thursday: next.optionalThursday,
        preferred_max_travel_minutes: next.preferredMaxTravelMinutes,
        exceptional_max_travel_minutes: next.exceptionalMaxTravelMinutes
      };
    });
    if (!row) throw new Error("The PitchRadar client profile row is missing.");
    return viewFromState(stateFromRow(row), "postgres");
  }

  return viewFromState(
    await updateLocalState((state) => applySectionSave(state, sectionId, validated, now)),
    "local_json"
  );
}

function applyMenuConfirmation(
  state: IntakeStoreState,
  items: IntakeMenuItem[],
  now: string
): IntakeStoreState {
  const status = intakeStatus(state.intake, now);
  return {
    ...state,
    menu: items,
    menuConfirmedAt: now,
    intakeStatus: status,
    missingInputs: recomputeMissingInputs(state.intake, now),
    intakeCompletedAt: intakeComplete(status) ? state.intakeCompletedAt || now : null
  };
}

/**
 * POST /api/profile/menu/confirm — the client's own menu replaces PitchRadar's
 * draft. Every returned line has `confirmationRequired: false`, and
 * `menu_confirmed_at` is stamped: until this call happens, nothing in the
 * product may present the menu as confirmed.
 */
export async function confirmMenu(items: unknown): Promise<ClientIntakeView> {
  const normalized = normalizeMenuItems(items);
  if (!normalized.length) {
    throw new IntakeValidationError("A confirmed menu needs at least one line.");
  }
  const now = new Date().toISOString();

  if (databaseConfigured()) {
    const row = await withClientProfileIntakeLock((current) => {
      const next = applyMenuConfirmation(stateFromRow(current), normalized, now);
      return {
        intake: next.intake,
        intake_status: next.intakeStatus,
        menu: next.menu,
        menu_confirmed_at: next.menuConfirmedAt,
        intake_completed_at: next.intakeCompletedAt,
        missing_inputs: next.missingInputs,
        home_postcode: next.homePostcode,
        normal_days: next.normalDays,
        optional_thursday: next.optionalThursday,
        preferred_max_travel_minutes: next.preferredMaxTravelMinutes,
        exceptional_max_travel_minutes: next.exceptionalMaxTravelMinutes
      };
    });
    if (!row) throw new Error("The PitchRadar client profile row is missing.");
    return viewFromState(stateFromRow(row), "postgres");
  }

  return viewFromState(
    await updateLocalState((state) => applyMenuConfirmation(state, normalized, now)),
    "local_json"
  );
}

/**
 * What the rest of the product should show as still missing, and the menu as
 * it currently stands. Used by catalogue.ts so dashboards and the agent never
 * report a stale `missing_inputs` column.
 */
export async function currentProfileTruth() {
  const { state } = await currentState();
  return {
    missingInputs: recomputeMissingInputs(state.intake, state.menuConfirmedAt),
    menu: state.menu,
    menuConfirmedAt: state.menuConfirmedAt
  };
}
