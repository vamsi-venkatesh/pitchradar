/**
 * THE CONTACT RESOLVER — a named human being, or an honest receipt saying there
 * is none.
 *
 * The brief's weakest line was "Application portal, unconfirmed": true, and
 * useless. A German commercial or municipal site is legally obliged to publish
 * an Impressum, so for most organizers a real route already sits on a public
 * page — it was simply never read. This stage reads it.
 *
 * FOUR RULES GOVERN EVERYTHING BELOW.
 *
 * 1. NOTHING IS INVENTED. Every stored field comes from text that was actually
 *    on a page we fetched, and every row carries the page it came from, when it
 *    was read, and the phrase that established it.
 * 2. A BARE NAME IS NOT A CONTACT. A page is full of capitalised names —
 *    sponsors, streets, photographers. A name becomes a contact only when it
 *    sits next to a contact ROLE ("Ansprechpartner", "Vertreten durch",
 *    "Marktleitung", …), and that role phrase is stored as the evidence.
 * 3. AN ADDRESS ON THE PAGE IS NOT THE ORGANIZER'S ADDRESS. Impressum pages
 *    carry agency, hosting and web-designer mailboxes. Only an address on the
 *    organizer's own domain (or the event's) is kept; everything else is
 *    dropped, however plausible it looks.
 * 4. THE NEGATIVE RESULT IS A RESULT. A page with nothing extractable stores
 *    "no public contact found on <url>" so the next run knows it was looked at.
 *
 * The stage is READ-ONLY on the public web — bounded GETs through the same
 * SSRF-guarded fetcher the collector uses — so it contributes no external
 * actions, exactly like collection.
 *
 * ONE KNOWN LIMIT, STATED RATHER THAN HIDDEN: fetchPublicPage returns the
 * page's TEXT (tags are stripped before it returns), so a `mailto:` href whose
 * visible label is "write to us" cannot be read. Addresses printed as text —
 * which is what an Impressum does — are read, including the common
 * "info(at)example.de" obfuscation.
 */

import { withDatabaseConnection, databaseConfigured } from "./database";
import { fetchPublicPage } from "./web";
import { buildWeeklyReport, type ReportEvent, type WeeklyReport } from "./report";
import { loadProductSnapshot } from "./catalogue";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

/** How many events one run may work on. Small on purpose: this stage fetches. */
export const DEFAULT_CONTACT_RESOLVER_CAP = 30;
/** Per event, a hard ceiling on fetches — the candidate list never exceeds it. */
export const MAX_FETCHES_PER_EVENT = 4;
/**
 * Per event. Two CONTACT-BEARING pages are enough; a page that yields nothing
 * does not use up the allowance, it only uses up a fetch.
 *
 * MEASURED, 2026-09-15: counting every page that merely loaded meant the
 * allowance was spent on the application page and the site root — the two
 * candidates least likely to publish a contact — and /impressum, the one page
 * German law obliges the organizer to publish, was never reached for 11 of 28
 * events. The per-event ceiling that actually bounds the web footprint is
 * MAX_FETCHES_PER_EVENT, and it is unchanged.
 */
export const MAX_PAGES_PER_EVENT = 2;
/** Per run, across every event. A hard ceiling on the stage's web footprint. */
export const DEFAULT_FETCH_BUDGET = 60;

export function parseContactResolverCap(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_CONTACT_RESOLVER_CAP;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `PITCHRADAR_CONTACT_RESOLVER_CAP must be a whole number of events; got "${trimmed}".`
    );
  }
  return Number(trimmed);
}

/* ------------------------------------------------------------ extraction */

/**
 * The role phrases that turn a name into a contact. Each is a published claim
 * of responsibility, not a mention.
 */
const ROLE_PATTERNS: Array<{ label: string; source: string }> = [
  { label: "Ansprechpartner", source: String.raw`Ansprechpartner(?:in)?(?:\s*\/-?in)?` },
  { label: "Vertreten durch", source: String.raw`Vertreten\s+durch` },
  { label: "Geschäftsführer", source: String.raw`Gesch(?:ä|ae)ftsf(?:ü|ue)hrer(?:in)?` },
  { label: "Veranstaltungsleitung", source: String.raw`Veranstaltungsleitung` },
  { label: "Marktleitung", source: String.raw`Marktleitung` },
  { label: "Organisation", source: String.raw`Organisation(?:sleitung|sb(?:ü|ue)ro)?` },
  { label: "Kontakt", source: String.raw`Kontaktperson|Kontakt` }
];

/**
 * Two capitalised words, German diacritics and the usual particles allowed —
 * and the whole match must END at a word boundary.
 *
 * MEASURED, 2026-09-15: without the closing lookahead, "Kontakt: Musterfest
 * GmbH" was stored as the person "Musterfest Gmb", because the lower-case run
 * stopped at the capital H. A truncated company name presented as a person is
 * exactly the kind of invention this module exists to prevent.
 */
const NAME = String.raw`[A-ZÄÖÜ][a-zäöüß]{1,}(?:-[A-ZÄÖÜ][a-zäöüß]{1,})?(?:\s+(?:von|van|de|der|zu|zur))?\s+[A-ZÄÖÜ][a-zäöüß]{1,}(?:-[A-ZÄÖÜ][a-zäöüß]{1,})?(?![A-Za-zÄÖÜäöüß])`;
/**
 * What may stand between the role phrase and the name — and this is the rule
 * that MEASURABLY separates a contact from page furniture.
 *
 * The role phrase must be PUNCTUATED as a label: a colon (optionally after a
 * short qualifier — "Ansprechpartner für Beschicker:"), or a salutation or
 * title that addresses the person ("Ansprechpartner Herr Kranz"). Without one
 * of those, the capitalised words after the word are the next navigation item,
 * not a person.
 *
 * MEASURED, 2026-09-15, on the live corpus: the first version accepted any
 * adjacency and wrote "Kontakt Mehr More", "Kontakt Termine Fr",
 * "Kontaktformular Bürgermeldung", "Ansprechpartner Dienstleistung Sortiment"
 * and "Kontakt Alte PoststraÃe" as people. Every one of those is a nav label or a
 * form-field list following a bare heading. The colon rule removes all five and
 * keeps "Ansprechpartner: Martin Keller" and "Vertreten durch die
 * Geschäftsführer: Henrik Brandt".
 */
const ADJACENCY = new RegExp(
  String.raw`^[\s;,\-–—|]*(?:[^:.!?<>]{0,40})?(?::\s*|\s+(?=(?:Herr|Frau|Dr\.|Prof\.)))(?:ist\s+|sind\s+)?(?:Herr|Frau)?\s*(?:Dr\.?|Prof\.?|Dipl\.[-\wÄÖÜäöüß]*)?\s*(${NAME})`
);

/** Words a "name" match is never allowed to START with — page furniture. */
const NAME_STOPWORDS =
  /^(?:Der|Die|Das|Ein|Eine|Und|Oder|Mit|Für|Fuer|Sie|Wir|Uns|Bei|Auf|Vom|Zum|Zur|Alle|Unser|Unsere|Impressum|Kontakt|Telefon|Adresse|Postfach|Angaben|Quelle|Inhaltlich|Verantwortlich|Anschrift|Sitz|Register|Stadt|Gemeinde|Amt)\b/;

/**
 * Tokens that prove a two-word match is NOT a person: an opening-hours line, a
 * street, a company form. "Öffnungszeiten: Montag Freitag" is two capitalised
 * words in exactly the shape of a name, and a resolver that accepted it would
 * put a weekday on a decision page as the person to call.
 */
const NON_NAME_TOKENS = new Set(
  [
    "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag",
    "Sonnabend", "Sonntag", "Januar", "Februar", "März", "Maerz", "April",
    "Mai", "Juni", "Juli", "August", "September", "Oktober", "November",
    "Dezember", "Uhr", "Straße", "Strasse", "Platz", "Weg", "Allee", "Ring",
    "GmbH", "Verein", "Stadt", "Gemeinde", "Amt", "Telefon", "Telefax", "Fax",
    "Mail", "Postfach", "Deutschland", "Register", "Umsatzsteuer", "Impressum",
    "Datenschutz", "Kontakt", "Anfahrt", "Öffnungszeiten", "Veranstaltung"
  ].map((token) => token.toLowerCase())
);

/** A legal form standing right after the match: the words were a company. */
const LEGAL_FORM_TAIL =
  /^\s*(?:gGmbH|GmbH|mbH|AG|KGaA|KG|UG|GbR|OHG|SE|e\.?\s?V\.?|&\s*Co)\b/i;

function looksLikeAPerson(name: string): boolean {
  if (NAME_STOPWORDS.test(name)) return false;
  return name
    .split(/\s+/)
    .every((token) => !NON_NAME_TOKENS.has(token.replace(/[.,]/g, "").toLowerCase()));
}

export interface ExtractedPerson {
  name: string;
  role: string;
  /** The verbatim page text that established the role. Bounded, never rewritten. */
  snippet: string;
}

export interface ExtractedContacts {
  emails: string[];
  phones: string[];
  persons: ExtractedPerson[];
  /** Addresses that were found but dropped because they are on another domain. */
  rejectedEmails: string[];
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * RULE 3, in one function. An address belongs to the organizer when its domain
 * IS one of the hosts we already trust for this event, or is a parent or a
 * subdomain of one. A hoster's or agency's address never satisfies that.
 */
export function emailBelongsToOrganizer(email: string, allowedHosts: string[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return allowedHosts.some((raw) => {
    const host = raw.replace(/^www\./i, "").toLowerCase();
    if (!host) return false;
    return domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
  });
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+(?:@|\s*\(at\)\s*|\s*\[at\]\s*)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_PATTERN = /(?:\+\s?49|0049|\b0)[\s/\-().]*\d[\d\s/\-().]{5,22}\d/g;

function normalizeEmail(raw: string): string {
  return raw
    .replace(/\s*\(at\)\s*|\s*\[at\]\s*/i, "@")
    .replace(/\s+/g, "")
    .replace(/[.,;:]+$/, "")
    .toLowerCase();
}

/**
 * A run of digits is only a PHONE NUMBER when the page says so.
 *
 * MEASURED, 2026-09-15, on the live corpus: without this rule the resolver
 * stored "+496202720062027", "+49204102026" and "+494072027" — event listings
 * reading "20.4.2026 | 2027" swallowed by a digit pattern. A number qualifies
 * only when it carries its own country code, or a phone marker stands
 * immediately before it.
 */
const PHONE_MARKER =
  /(?:tel\.?|telefon(?:nummer)?|telephone|fon|phone|mobil|handy|ruf(?:nummer)?|☎|📞|✆)\s*:?\s*$/i;

export function isPhoneInContext(raw: string, precedingText: string): boolean {
  if (/^\s*(?:\+\s?49|0049)/.test(raw)) return true;
  return PHONE_MARKER.test(precedingText);
}

/** German numbers, stored one way: +49 followed by the national number. */
export function normalizeGermanPhone(raw: string): string | undefined {
  const digits = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  let national: string;
  if (digits.startsWith("+49")) national = digits.slice(3);
  else if (digits.startsWith("0049")) national = digits.slice(4);
  else if (digits.startsWith("0")) national = digits.slice(1);
  else return undefined;
  national = national.replace(/^0+/, "");
  if (!/^\d{6,13}$/.test(national)) return undefined;
  return `+49${national}`;
}

/**
 * RULE 2, in one function. Every role phrase on the page is located, and only
 * the text IMMEDIATELY following it is searched for a name. A name found
 * anywhere else is not returned, whatever else the page says about it.
 */
export function extractPersons(text: string): ExtractedPerson[] {
  const found: ExtractedPerson[] = [];
  const seen = new Set<string>();
  for (const role of ROLE_PATTERNS) {
    const pattern = new RegExp(role.source, "g");
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const after = text.slice(start + match[0].length, start + match[0].length + 90);
      const adjacent = after.match(ADJACENCY);
      if (!adjacent) continue;
      const name = collapse(adjacent[1]);
      if (!looksLikeAPerson(name)) continue;
      // A legal form after the match proves the words were a COMPANY, not a
      // person: "Vertreten durch: Beispiel Events GmbH".
      if (LEGAL_FORM_TAIL.test(after.slice(adjacent[0].length))) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        name,
        role: role.label,
        snippet: collapse(text.slice(start, start + match[0].length + 120)).slice(0, 240)
      });
    }
  }
  return found;
}

export function extractContacts(
  text: string,
  options: { allowedHosts: string[] }
): ExtractedContacts {
  const emails: string[] = [];
  const rejectedEmails: string[] = [];
  for (const raw of text.match(EMAIL_PATTERN) ?? []) {
    const email = normalizeEmail(raw);
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) continue;
    if (emails.includes(email) || rejectedEmails.includes(email)) continue;
    if (emailBelongsToOrganizer(email, options.allowedHosts)) emails.push(email);
    else rejectedEmails.push(email);
  }
  const phones: string[] = [];
  for (const match of text.matchAll(PHONE_PATTERN)) {
    const raw = match[0];
    const before = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (!isPhoneInContext(raw, before)) continue;
    const phone = normalizeGermanPhone(raw);
    if (phone && !phones.includes(phone)) phones.push(phone);
  }
  return { emails, phones, persons: extractPersons(text), rejectedEmails };
}

/* -------------------------------------------------------- page selection */

/**
 * The candidate pages, in the order a person would try them: the application
 * page the event already points at, then the organizer's front page, then the
 * two URLs German sites are effectively obliged to serve.
 */
export function candidatePagesFor(target: {
  applicationUrl?: string;
  organizerWebsite?: string;
}): string[] {
  const pages: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return;
      const normalized = url.toString();
      if (!pages.includes(normalized)) pages.push(normalized);
    } catch {
      /* a malformed stored URL is not a candidate; it is a data problem. */
    }
  };
  push(target.applicationUrl);
  const site = target.organizerWebsite ?? target.applicationUrl;
  if (site) {
    try {
      const root = new URL(site);
      push(`${root.origin}/`);
      push(`${root.origin}/impressum`);
      push(`${root.origin}/kontakt`);
    } catch {
      /* same as above. */
    }
  }
  return pages.slice(0, MAX_FETCHES_PER_EVENT);
}

/* --------------------------------------------------------------- targets */

export interface ContactResolverTarget {
  /** The catalogue's external id — what the report prints. */
  eventId: string;
  eventName: string;
  /** Why this event is in the bounded set. */
  reason: "action_now" | "top_opportunity" | "shortlist" | "deadline_radar" | "radar";
  applicationUrl?: string;
  organizerName?: string;
  /** True when a person is ALREADY recorded — resolved last, never skipped. */
  hasNamedPerson: boolean;
}

/**
 * The bounded set: what the owner is actually being asked to act on this week.
 * Action-now first (a deadline does not wait), then the top opportunities, then
 * the rest of the shortlist. Events that already name a person are ordered
 * last, so the cap is spent closing gaps rather than re-reading known routes.
 *
 * On a real corpus those three groups are SMALL — six events in 2026-W38 —
 * while the cap is thirty. An unspent cap buys nothing, so the deadline radar
 * and then the opportunity radar follow, in that order: they are the events the
 * owner reaches next, and a route found now is a route that is already there
 * when one of them becomes an action. Priority is strict, so a wider tail can
 * never displace an action-now event.
 */
export function selectResolutionTargets(report: WeeklyReport, cap: number): ContactResolverTarget[] {
  const groups: Array<{ reason: ContactResolverTarget["reason"]; events: ReportEvent[] }> = [
    { reason: "action_now", events: report.actionNow },
    { reason: "top_opportunity", events: report.topOpportunities },
    {
      reason: "shortlist",
      events: report.register.filter(
        (event) =>
          !event.rejected &&
          (event.recommendation === "STRONG FIT" || event.recommendation === "GOOD FIT")
      )
    },
    {
      reason: "deadline_radar",
      events: report.deadlineRadar
        .map((item) => report.register.find((event) => event.id === item.eventId))
        .filter(Boolean) as ReportEvent[]
    },
    { reason: "radar", events: report.radar }
  ];
  const seen = new Set<string>();
  const targets: ContactResolverTarget[] = [];
  for (const group of groups) {
    for (const event of group.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      targets.push({
        eventId: event.id,
        eventName: event.name,
        reason: group.reason,
        applicationUrl: event.contactRoute.url,
        organizerName: event.organizer,
        hasNamedPerson: Boolean(event.contactRoute.person)
      });
    }
  }
  return targets
    .map((target, index) => ({ target, index }))
    .sort(
      (a, b) =>
        Number(a.target.hasNamedPerson) - Number(b.target.hasNamedPerson) || a.index - b.index
    )
    .map((entry) => entry.target)
    .slice(0, cap);
}

/* ------------------------------------------------------------- the stage */

export interface ContactResolutionFailure {
  eventId: string;
  url: string;
  error: string;
}

export interface ContactResolutionReceipt {
  startedAt: string;
  completedAt: string;
  eventsTargeted: number;
  pagesFetched: number;
  contactsFound: { named: number; emails: number; phones: number };
  noContactPages: number;
  failures: ContactResolutionFailure[];
  skipped?: "database_not_configured";
}

export interface ContactQueryRunner {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface FetchedPage {
  text: string;
  finalUrl: string;
}

export interface ContactResolutionOptions {
  targets: ContactResolverTarget[];
  fetchPage?: (url: string) => Promise<FetchedPage>;
  fetchBudget?: number;
  now?: () => Date;
}

interface EventRouteRow {
  id: string;
  external_id: string;
  canonical_name: string;
  organizer_id: string | null;
  organizer_name: string | null;
  organizer_website: string | null;
  application_url: string | null;
}

async function defaultFetchPage(url: string): Promise<FetchedPage> {
  const page = await fetchPublicPage(url);
  return { text: page.text, finalUrl: page.finalUrl };
}

/**
 * The organizer row a contact can hang off. An event that names an organizer
 * but has no row gets one — created from the name the event already carries,
 * never from anything read off the web — and the event is linked to it.
 */
async function ensureOrganizer(
  client: ContactQueryRunner,
  row: EventRouteRow
): Promise<{ id: string; website: string | null } | undefined> {
  if (row.organizer_id) return { id: row.organizer_id, website: row.organizer_website };
  const name = row.organizer_name?.trim();
  if (!name) return undefined;
  const existing = await client.query<{ id: string; website_url: string | null }>(
    "select id, website_url from organizers where canonical_name = $1 limit 1",
    [name]
  );
  if (existing.rows[0]) {
    await client.query("update events set organizer_id = $2, updated_at = now() where id = $1", [
      row.id,
      existing.rows[0].id
    ]);
    return { id: existing.rows[0].id, website: existing.rows[0].website_url };
  }
  const created = await client.query<{ id: string }>(
    `insert into organizers (canonical_name, organizer_type, notes)
     values ($1, 'private', $2)
     on conflict (canonical_name) do update set updated_at = now()
     returning id`,
    [name, `Created by contact resolution from event "${row.canonical_name}".`]
  );
  const organizerId = created.rows[0]?.id;
  if (!organizerId) return undefined;
  await client.query("update events set organizer_id = $2, updated_at = now() where id = $1", [
    row.id,
    organizerId
  ]);
  return { id: organizerId, website: null };
}

/**
 * Idempotent on (organizer, email, phone) — the table's own unique key. A
 * re-check of a page that still publishes the same address refreshes the
 * evidence and the timestamp; it never accumulates a second row.
 */
async function upsertResolvedContact(
  client: ContactQueryRunner,
  organizerId: string,
  contact: {
    name?: string;
    role?: string;
    email?: string;
    phone?: string;
    sourceUrl: string;
    observedAt: string;
    snippet?: string;
  }
) {
  const existing = await client.query<{ id: string }>(
    `select id from organizer_contacts
     where organizer_id = $1
       and coalesce(email, '') = coalesce($2, '')
       and coalesce(phone, '') = coalesce($3, '')
     limit 1`,
    [organizerId, contact.email ?? null, contact.phone ?? null]
  );
  if (existing.rows[0]) {
    await client.query(
      // A LATER PAGE MAY NOT ERASE EARLIER EVIDENCE. The same organizer's
       // address turns up on several pages; if only one of them names the
       // person, the row keeps that page as its source and that phrase as its
       // evidence. Only an observation that itself names a person may move them.
      `update organizer_contacts
       set contact_name = coalesce($2, contact_name),
         responsibility = coalesce($3, responsibility),
         evidence_role = coalesce($3, evidence_role),
         evidence_snippet = coalesce($6, evidence_snippet),
         source_url = case when $2 is not null or contact_name is null then $4 else source_url end,
         last_verified_at = $5, resolved_by = 'contact_resolver'
       where id = $1`,
      [
        existing.rows[0].id,
        contact.name ?? null,
        contact.role ?? null,
        contact.sourceUrl,
        contact.observedAt,
        contact.snippet ?? null
      ]
    );
    return;
  }
  await client.query(
    `insert into organizer_contacts (
      organizer_id, contact_name, responsibility, email, phone, source_url,
      last_verified_at, evidence_snippet, evidence_role, resolved_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $3, 'contact_resolver')`,
    [
      organizerId,
      contact.name ?? null,
      contact.role ?? "Published organizer contact",
      contact.email ?? null,
      contact.phone ?? null,
      contact.sourceUrl,
      contact.observedAt,
      contact.snippet ?? null
    ]
  );
}

async function recordCheck(
  client: ContactQueryRunner,
  check: {
    organizerId: string;
    eventId: string;
    sourceUrl: string;
    checkedAt: string;
    outcome: "contact_found" | "no_contact" | "fetch_failed";
    finding: string;
    snippet?: string;
  }
) {
  await client.query(
    `insert into organizer_contact_checks (
      organizer_id, event_id, source_url, checked_at, outcome, finding, evidence_snippet
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organizer_id, source_url) do update set
       event_id = excluded.event_id,
       checked_at = excluded.checked_at,
       outcome = excluded.outcome,
       finding = excluded.finding,
       evidence_snippet = excluded.evidence_snippet`,
    [
      check.organizerId,
      check.eventId,
      check.sourceUrl,
      check.checkedAt,
      check.outcome,
      check.finding,
      check.snippet ?? null
    ]
  );
}

export async function runContactResolutionOn(
  client: ContactQueryRunner,
  options: ContactResolutionOptions
): Promise<ContactResolutionReceipt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const fetchPage = options.fetchPage ?? defaultFetchPage;
  const budget = options.fetchBudget ?? DEFAULT_FETCH_BUDGET;
  const failures: ContactResolutionFailure[] = [];
  let pagesFetched = 0;
  let noContactPages = 0;
  let named = 0;
  let emailsStored = 0;
  let phonesStored = 0;
  let eventsTargeted = 0;
  const contactRows = new Set<string>();
  /**
   * German festival operators run dozens of events off ONE site: eleven of the
   * 2026-W38 targets share four organizers. Fetching the same impressum once
   * per event would spend the whole budget on four pages, so a page read in
   * this run is reused — and a reuse is not a fetch, so it costs no budget.
   */
  const pageCache = new Map<string, FetchedPage | { error: string }>();

  for (const target of options.targets) {
    if (pagesFetched >= budget) break;
    const found = await client.query<EventRouteRow>(
      `select e.id, e.external_id, e.canonical_name, e.organizer_id, e.organizer_name,
         o.website_url as organizer_website,
         coalesce(aw.application_url, e.application_url) as application_url
       from events e
       left join organizers o on o.id = e.organizer_id
       left join application_windows aw on aw.event_id = e.id
       where e.tenant_id = $1 and e.external_id = $2
       limit 1`,
      [TENANT_ID, target.eventId]
    );
    const row = found.rows[0];
    if (!row) continue;
    const organizer = await ensureOrganizer(client, row);
    if (!organizer) continue;
    const pages = candidatePagesFor({
      applicationUrl: row.application_url ?? target.applicationUrl,
      organizerWebsite: organizer.website ?? row.organizer_website ?? undefined
    });
    if (!pages.length) continue;
    eventsTargeted += 1;

    const allowedHosts = [
      organizer.website,
      row.organizer_website,
      row.application_url,
      target.applicationUrl
    ]
      .map((value) => (value ? hostOf(value) : undefined))
      .filter(Boolean) as string[];

    let resolvedPages = 0;
    for (const page of pages) {
      if (resolvedPages >= MAX_PAGES_PER_EVENT) break;
      const cached = pageCache.get(page);
      if (cached && "error" in cached) continue;
      if (!cached && pagesFetched >= budget) break;
      let fetched: FetchedPage;
      try {
        if (cached && !("error" in cached)) {
          fetched = cached;
        } else {
          pagesFetched += 1;
          fetched = await fetchPage(page);
          pageCache.set(page, fetched);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pageCache.set(page, { error: message });
        failures.push({ eventId: target.eventId, url: page, error: message });
        await recordCheck(client, {
          organizerId: organizer.id,
          eventId: row.id,
          sourceUrl: page,
          checkedAt: now().toISOString(),
          outcome: "fetch_failed",
          finding: `Page could not be read: ${message}`
        });
        continue;
      }
      const observedAt = now().toISOString();
      const hosts = [...allowedHosts, hostOf(fetched.finalUrl)].filter(Boolean) as string[];
      const extracted = extractContacts(fetched.text, { allowedHosts: hosts });
      const person = extracted.persons[0];
      const email = extracted.emails[0];
      const phone = extracted.phones[0];
      if (!person && !email && !phone) {
        noContactPages += 1;
        await recordCheck(client, {
          organizerId: organizer.id,
          eventId: row.id,
          sourceUrl: fetched.finalUrl,
          checkedAt: observedAt,
          outcome: "no_contact",
          finding: `No public contact found on ${fetched.finalUrl}`
        });
        continue;
      }
      resolvedPages += 1;
      await upsertResolvedContact(client, organizer.id, {
        name: person?.name,
        role: person?.role,
        email,
        phone,
        sourceUrl: fetched.finalUrl,
        observedAt,
        snippet: person?.snippet
      });
      // COUNT ROWS, NOT WRITES. Eleven events can share one organizer page, and
      // the upsert collapses them onto one row — a receipt that counted the
      // writes would report eight named contacts where the database holds two.
      const rowKey = `${organizer.id}|${email ?? ""}|${phone ?? ""}`;
      if (!contactRows.has(rowKey)) {
        contactRows.add(rowKey);
        if (person) named += 1;
        if (email) emailsStored += 1;
        if (phone) phonesStored += 1;
      }
      await recordCheck(client, {
        organizerId: organizer.id,
        eventId: row.id,
        sourceUrl: fetched.finalUrl,
        checkedAt: observedAt,
        outcome: "contact_found",
        finding: [person ? `${person.role}: ${person.name}` : undefined, email, phone]
          .filter(Boolean)
          .join(" · "),
        snippet: person?.snippet
      });
    }
  }

  return {
    startedAt,
    completedAt: now().toISOString(),
    eventsTargeted,
    pagesFetched,
    contactsFound: { named, emails: emailsStored, phones: phonesStored },
    noContactPages,
    failures
  };
}

/**
 * The cycle entry point. The bounded set is derived from the CURRENT report —
 * the same selection the owner is reading — so the stage always spends its
 * fetches on the events actually on this week's page.
 */
export async function runContactResolution(now = new Date()): Promise<ContactResolutionReceipt> {
  if (!databaseConfigured()) {
    return {
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      eventsTargeted: 0,
      pagesFetched: 0,
      contactsFound: { named: 0, emails: 0, phones: 0 },
      noContactPages: 0,
      failures: [],
      skipped: "database_not_configured"
    };
  }
  const snapshot = await loadProductSnapshot();
  const report = buildWeeklyReport(snapshot, now);
  const targets = selectResolutionTargets(
    report,
    parseContactResolverCap(process.env.PITCHRADAR_CONTACT_RESOLVER_CAP)
  );
  return withDatabaseConnection((client) => runContactResolutionOn(client, { targets }));
}
