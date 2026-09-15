import type { PoolClient } from "pg";
import type { ApplicationRoute, CapacityState } from "../src/types";
import { probeSource, type SourceProbeResult } from "./source-probe";
import { withDatabaseTransaction } from "./database";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

export type RouteScope = "event_specific" | "organizer_general" | "portal_general" | "unknown";

export interface OrganizerIntelligenceTarget {
  id: string;
  organizerNames: string[];
  routeOwner: string;
  route: ApplicationRoute;
  routeScope: RouteScope;
  applicationUrl: string;
  pages: Array<{ id: string; name: string; baseUrl: string }>;
  contact?: {
    name?: string;
    responsibility: string;
    email?: string;
    phone?: string;
    sourceUrl: string;
  };
  requirements: Array<{ label: string; evidenceToken: string }>;
}

export interface VerifiedOrganizerIntelligence {
  target: OrganizerIntelligenceTarget;
  checkedAt: string;
  routeReachable: boolean;
  sourceHash: string;
  verifiedRequirements: string[];
  contact?: OrganizerIntelligenceTarget["contact"];
  finding: string;
  warnings: string[];
}

export interface IntelligenceRunResult {
  checkedTargets: number;
  reachableRoutes: number;
  verifiedContacts: number;
  enrichedEvents: number;
  checkReceipts: number;
  warnings: string[];
}

export function reconcileMissingFields(
  fields: string[],
  intelligence: Pick<VerifiedOrganizerIntelligence, "contact" | "routeReachable">
) {
  return fields.filter((field) => {
    if (intelligence.contact && /^organizer contact$/i.test(field.trim())) return false;
    if (intelligence.routeReachable && /^application route$/i.test(field.trim())) return false;
    return true;
  });
}

export const organizerIntelligenceTargets: OrganizerIntelligenceTarget[] = [
  {
    id: "beispiel-events-applications",
    organizerNames: ["Beispiel Events GmbH", "Beispiel Foodtruck-Festivals"],
    routeOwner: "Beispiel Events GmbH",
    route: "public_form",
    routeScope: "organizer_general",
    applicationUrl: "https://www.example-foodtruck-festivals.de/trucker/",
    pages: [
      { id: "beispiel-events-application", name: "Beispiel Events food-truck application", baseUrl: "https://www.example-foodtruck-festivals.de/trucker/" },
      { id: "beispiel-events-contact", name: "Beispiel Events contact", baseUrl: "https://www.example-foodtruck-festivals.de/kontakt/" }
    ],
    contact: {
      responsibility: "Food-truck applications",
      email: "info@example-foodtruck-festivals.de",
      phone: "+49 30 0000000",
      sourceUrl: "https://www.example-foodtruck-festivals.de/kontakt/"
    },
    requirements: [
      { label: "Food-truck, trailer or stand concept", evidenceToken: "FoodTrucker / Trailer / Stand" },
      { label: "Speciality or core offer", evidenceToken: "Spezialität" },
      { label: "Preferred city or region", evidenceToken: "Stadt/Städte/Region" }
    ]
  },
  {
    id: "foodtruckmeile-applications",
    organizerNames: ["Beispiel Kulinarik GmbH"],
    routeOwner: "Beispiel Kulinarik GmbH",
    route: "public_form",
    routeScope: "organizer_general",
    applicationUrl: "https://example-foodtruckmeile.de/dirketbewerbung",
    pages: [
      { id: "foodtruckmeile-home", name: "Foodtruckmeile partner page", baseUrl: "https://example-foodtruckmeile.de/" }
    ],
    contact: {
      name: "Beate Muster",
      responsibility: "Food-truck partner support",
      email: "kontakt@example-kulinarik.de",
      phone: "+49 30 0000001",
      sourceUrl: "https://example-foodtruckmeile.de/"
    },
    requirements: [
      { label: "Direct application profile", evidenceToken: "Direktbewerbung" },
      { label: "Food-truck partner contact", evidenceToken: "Foodtruck-Partnerbetreuung" }
    ]
  },
  {
    id: "tour-agentur-applications",
    organizerNames: ["Beispiel Tour-Agentur"],
    routeOwner: "Beispiel Tour-Agentur",
    route: "public_form",
    routeScope: "organizer_general",
    applicationUrl: "https://www.example-tour-agentur.de/bewerbungsformular",
    pages: [
      { id: "tour-agentur-application", name: "Beispiel Tour-Agentur application", baseUrl: "https://www.example-tour-agentur.de/bewerbungsformular" },
      { id: "tour-agentur-contact", name: "Beispiel Tour-Agentur contact", baseUrl: "https://www.example-tour-agentur.de/kontaktieren-sie-uns" }
    ],
    contact: {
      responsibility: "Vendor applications",
      email: "info@example-tour-agentur.de",
      phone: "+49 30 0000002",
      sourceUrl: "https://www.example-tour-agentur.de/kontaktieren-sie-uns"
    },
    requirements: [
      { label: "Business and tax details", evidenceToken: "SteuerNummer oder Ust.ID" },
      { label: "Trade permit", evidenceToken: "Reisegewerbeschein" },
      { label: "Liability insurance", evidenceToken: "Betriebshaftpflichtversicherung" },
      { label: "Setup dimensions and type", evidenceToken: "Abmessungen/ Platzbedarf" },
      { label: "Power, water and gas requirements", evidenceToken: "Stromanschluss" },
      { label: "Complete product list", evidenceToken: "Produktangaben" },
      { label: "Maximum portions per hour", evidenceToken: "Max. Anzahl Portionen/Std." }
    ]
  },
  {
    id: "haendlerportal-applications",
    organizerNames: ["Agentur Beispiel Händlerportal"],
    routeOwner: "Agentur Beispiel Händlerportal",
    route: "operator_network",
    routeScope: "portal_general",
    applicationUrl: "https://www.example-haendler-portal.de/portal/home/",
    pages: [
      { id: "haendlerportal-home", name: "Agentur Beispiel trader portal", baseUrl: "https://www.example-haendler-portal.de/portal/home/" }
    ],
    requirements: [
      { label: "Digital trader profile and stand", evidenceToken: "Stand" },
      { label: "Event application through the portal", evidenceToken: "bewerben" },
      { label: "Digital contract after acceptance", evidenceToken: "Vertrag" }
    ]
  },
  {
    id: "muster-events-contact",
    organizerNames: ["Muster Events GmbH"],
    routeOwner: "Muster Events GmbH",
    route: "phone",
    routeScope: "organizer_general",
    applicationUrl: "https://www.example-muster-events.de/",
    pages: [
      { id: "muster-events-home", name: "Muster Street Food Festival", baseUrl: "https://www.example-muster-events.de/" }
    ],
    contact: {
      responsibility: "Festival enquiries",
      phone: "+49 30 0000003",
      sourceUrl: "https://www.example-muster-events.de/"
    },
    requirements: []
  }
];

function normalizePage(value: string) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#0*34;|&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("de-DE");
}

function compact(value: string) {
  return value.replace(/[^\p{L}\p{N}@+]+/gu, "").toLocaleLowerCase("de-DE");
}

function pageContains(page: string, value: string) {
  return compact(page).includes(compact(value));
}

export function verifyOrganizerTarget(
  target: OrganizerIntelligenceTarget,
  probes: SourceProbeResult[]
): VerifiedOrganizerIntelligence {
  const successful = probes.filter((probe) => probe.ok && probe.bodyText);
  const raw = successful.map((probe) => probe.bodyText).join(" ");
  const joined = normalizePage(raw);
  const routeProbe = successful.find((probe) =>
    probe.requestedUrl === target.applicationUrl ||
    probe.finalUrl === target.applicationUrl ||
    target.applicationUrl.startsWith(probe.requestedUrl)
  );
  const verifiedRequirements = target.requirements
    .filter((requirement) => pageContains(joined, requirement.evidenceToken))
    .map((requirement) => requirement.label);
  const contact = target.contact &&
    (!target.contact.email || pageContains(raw, target.contact.email)) &&
    (!target.contact.phone || pageContains(raw, target.contact.phone)) &&
    (!target.contact.name || pageContains(raw, target.contact.name))
      ? target.contact
      : undefined;
  const routeReachable = Boolean(routeProbe) &&
    (["phone", "email"].includes(target.route) ? Boolean(contact) : true);
  const warnings = [
    ...probes.filter((probe) => !probe.ok).map((probe) => `${probe.sourceName}: ${probe.error || probe.state}`),
    ...(target.contact && !contact ? [`${target.routeOwner}: published contact details could not all be verified.`] : []),
    ...(verifiedRequirements.length < target.requirements.length
      ? [`${target.routeOwner}: ${target.requirements.length - verifiedRequirements.length} expected application fields were not found.`]
      : [])
  ];
  const hashes = successful.map((probe) => probe.bodyHash).filter(Boolean).sort();
  const checkedAt = successful.map((probe) => probe.checkedAt).sort().at(-1) || new Date().toISOString();
  return {
    target,
    checkedAt,
    routeReachable,
    sourceHash: hashes.join(":") || "unreachable",
    verifiedRequirements,
    contact,
    finding: routeReachable
      ? "Official organizer route is reachable. Event-specific speciality capacity and any unpublished deadline still require direct confirmation."
      : "No event-specific public application route was verified. Use the published organizer contact and confirm availability directly.",
    warnings
  };
}

async function upsertContact(
  client: PoolClient,
  organizerId: string,
  intelligence: VerifiedOrganizerIntelligence
) {
  const contact = intelligence.contact;
  if (!contact) return 0;
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
      `update organizer_contacts
       set contact_name = $2, responsibility = $3, source_url = $4, last_verified_at = $5
       where id = $1`,
      [existing.rows[0].id, contact.name ?? null, contact.responsibility, contact.sourceUrl, intelligence.checkedAt]
    );
  } else {
    await client.query(
      `insert into organizer_contacts (
        organizer_id, contact_name, responsibility, email, phone, source_url, last_verified_at
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        organizerId,
        contact.name ?? null,
        contact.responsibility,
        contact.email ?? null,
        contact.phone ?? null,
        contact.sourceUrl,
        intelligence.checkedAt
      ]
    );
  }
  return 1;
}

async function enrichEvents(
  client: PoolClient,
  organizerId: string,
  intelligence: VerifiedOrganizerIntelligence
) {
  const events = await client.query<{
    id: string;
    canonical_name: string;
    starts_at: Date;
    capacity: CapacityState | null;
    deadline_at: Date | null;
    missing_fields: string[];
  }>(
    `select e.id, e.canonical_name, e.starts_at, e.missing_fields, aw.capacity, aw.deadline_at
     from events e
     left join application_windows aw on aw.event_id = e.id
     where e.tenant_id = $1 and e.organizer_id = $2 and e.ends_at >= now()
     order by e.starts_at`,
    [TENANT_ID, organizerId]
  );
  let receipts = 0;
  for (const event of events.rows) {
    const capacity = event.capacity || "unknown";
    const deadline = event.deadline_at;
    const daysUntil = Math.max(1, Math.ceil((event.starts_at.getTime() - Date.now()) / 86_400_000));
    const recheckHours = daysUntil <= 30 ? 48 : 168;
    await client.query(
      `insert into application_windows (
        event_id, route_type, capacity, deadline_at, route_owner, application_url,
        status_note, last_checked_at, next_check_at, route_scope, route_reachable,
        requirements, source_url, updated_at
       ) values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $8::timestamptz + ($9 || ' hours')::interval,
        $10, $11, $12, $13, now()
       )
       on conflict (event_id) do update set
         route_type = case
           when application_windows.route_type = 'unknown' then excluded.route_type
           else application_windows.route_type
         end,
         capacity = application_windows.capacity,
         deadline_at = coalesce(application_windows.deadline_at, excluded.deadline_at),
         route_owner = excluded.route_owner,
         application_url = coalesce(application_windows.application_url, excluded.application_url),
         status_note = case
           when application_windows.capacity = 'unknown' then excluded.status_note
           else application_windows.status_note
         end,
         last_checked_at = excluded.last_checked_at,
         next_check_at = excluded.next_check_at,
         route_scope = excluded.route_scope,
         route_reachable = excluded.route_reachable,
         requirements = excluded.requirements,
         source_url = excluded.source_url,
         updated_at = now()`,
      [
        event.id,
        intelligence.target.route,
        capacity,
        deadline,
        intelligence.target.routeOwner,
        intelligence.target.applicationUrl,
        intelligence.finding,
        intelligence.checkedAt,
        recheckHours,
        intelligence.target.routeScope,
        intelligence.routeReachable,
        intelligence.verifiedRequirements,
        intelligence.target.applicationUrl
      ]
    );
    await client.query(
      `update events set missing_fields = $2, updated_at = now() where id = $1`,
      [event.id, reconcileMissingFields(event.missing_fields || [], intelligence)]
    );
    const receipt = await client.query(
      `insert into application_window_checks (
        event_id, checked_at, source_url, source_hash, route_type, route_scope,
        route_reachable, capacity, deadline_at, requirements, finding
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (event_id, source_url, source_hash) do nothing
       returning id`,
      [
        event.id,
        intelligence.checkedAt,
        intelligence.target.applicationUrl,
        intelligence.sourceHash,
        intelligence.target.route,
        intelligence.target.routeScope,
        intelligence.routeReachable,
        capacity,
        deadline,
        intelligence.verifiedRequirements,
        intelligence.finding
      ]
    );
    receipts += receipt.rowCount || 0;
  }
  return { events: events.rowCount || 0, receipts };
}

export async function runOrganizerIntelligence(
  targets = organizerIntelligenceTargets,
  probe = probeSource
): Promise<IntelligenceRunResult> {
  const verified: VerifiedOrganizerIntelligence[] = [];
  for (const target of targets) {
    const probes = await Promise.all(target.pages.map((page) => probe(page)));
    verified.push(verifyOrganizerTarget(target, probes));
  }

  return withDatabaseTransaction(async (client) => {
    let verifiedContacts = 0;
    let enrichedEvents = 0;
    let checkReceipts = 0;
    const warnings = verified.flatMap((item) => item.warnings);
    for (const intelligence of verified) {
      const organizers = await client.query<{ id: string; canonical_name: string }>(
        `select id, canonical_name from organizers where canonical_name = any($1::text[])`,
        [intelligence.target.organizerNames]
      );
      if (!organizers.rowCount) {
        warnings.push(`${intelligence.target.routeOwner}: no matching organizer exists in the catalogue.`);
        continue;
      }
      for (const organizer of organizers.rows) {
        verifiedContacts += await upsertContact(client, organizer.id, intelligence);
        const enriched = await enrichEvents(client, organizer.id, intelligence);
        enrichedEvents += enriched.events;
        checkReceipts += enriched.receipts;
      }
    }
    return {
      checkedTargets: verified.length,
      reachableRoutes: verified.filter((item) => item.routeReachable).length,
      verifiedContacts,
      enrichedEvents,
      checkReceipts,
      warnings
    };
  });
}
