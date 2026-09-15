import { rankOpportunities } from "../src/ranking";
import type {
  AvailabilityVerificationRequest,
  EventOpportunity,
  VerificationQueueChannel,
  VerificationQueueRole,
  VerificationQueueStatus
} from "../src/types";
import { groupByCalendarWeek } from "../src/week-planning";
import type { ProductSnapshot } from "../src/product-data";
import { databaseConfigured, databaseQuery, withDatabaseTransaction } from "./database";
import { loadProductSnapshot } from "./catalogue";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

export interface VerificationDraftPlan {
  event: EventOpportunity;
  weekKey: string;
  weeklyRole: VerificationQueueRole;
  channel: VerificationQueueChannel;
  status: Extract<VerificationQueueStatus, "owner_review" | "blocked_contact_missing">;
  routeVerified: boolean;
  subject: string;
  draftDe: string;
  draftEn: string;
  verificationQuestions: string[];
}

const questions = [
  "Is a food-truck pitch still available for these exact event dates?",
  "Is the speciality or a directly competing category already represented or exclusive?",
  "What pitch fee, commission, deposit and cancellation terms apply?",
  "Which electricity, water, gas, waste and stand-size details are required?",
  "Which documents are required and what is the final application deadline?"
];

function displayDate(value: string, locale: "de-DE" | "en-GB") {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin"
  }).format(new Date(value));
}

function roleFor(value: string): VerificationQueueRole {
  if (value === "Primary") return "primary";
  if (value === "Backup") return "backup";
  return "verify_first";
}

function channelFor(event: EventOpportunity): VerificationQueueChannel {
  if (event.contactEmail) return "email";
  if (event.application?.routeReachable && event.applicationUrl) return "portal";
  if (event.contactPhone) return "phone";
  return "research";
}

function verifiedRoute(event: EventOpportunity, channel: VerificationQueueChannel) {
  if (channel === "email") return Boolean(event.contactEmail && event.application?.routeReachable);
  if (channel === "phone") return Boolean(event.contactPhone && event.application?.routeReachable);
  if (channel === "portal") return Boolean(event.applicationUrl && event.application?.routeReachable);
  return false;
}

export function createVerificationDraft(
  event: EventOpportunity,
  weekKey: string,
  weeklyRole: VerificationQueueRole
): VerificationDraftPlan {
  const channel = channelFor(event);
  const routeVerified = verifiedRoute(event, channel);
  const startsDe = displayDate(event.startsAt, "de-DE");
  const endsDe = displayDate(event.endsAt, "de-DE");
  const startsEn = displayDate(event.startsAt, "en-GB");
  const endsEn = displayDate(event.endsAt, "en-GB");
  const greetingDe = event.application?.routeOwner || event.organizer
    ? `Guten Tag ${event.application?.routeOwner || event.organizer},`
    : "Guten Tag,";
  const greetingEn = event.application?.routeOwner || event.organizer
    ? `Hello ${event.application?.routeOwner || event.organizer},`
    : "Hello,";

  return {
    event,
    weekKey,
    weeklyRole,
    channel,
    status: routeVerified ? "owner_review" : "blocked_contact_missing",
    routeVerified,
    subject: `Standplatzanfrage Spezialitäten-Foodtruck – ${event.name}, ${startsDe}–${endsDe}`,
    draftDe: `${greetingDe}

wir betreiben einen Spezialitäten-Foodtruck aus Brandenburg und interessieren uns für einen Standplatz beim ${event.name} in ${event.city} vom ${startsDe} bis ${endsDe}.

Könnten Sie uns bitte kurz bestätigen:
• ob noch ein Foodtruck-Standplatz verfügbar ist,
• ob unsere Spezialität oder eine direkt vergleichbare Kategorie bereits vergeben oder exklusiv ist,
• welche Standgebühr, Provision oder Kaution gilt,
• welche Anforderungen zu Strom, Wasser, Gas, Abfall und Standgröße bestehen,
• welche Unterlagen benötigt werden und bis wann die Bewerbung möglich ist?

Gern senden wir nach Ihrer Rückmeldung Fotos, Speisekarte und die erforderlichen Unterlagen.

Vielen Dank und freundliche Grüße`,
    draftEn: `${greetingEn}

We operate a speciality food truck based in Brandenburg and are interested in a pitch at ${event.name} in ${event.city} from ${startsEn} to ${endsEn}.

Could you please confirm:
• whether a food-truck pitch is still available,
• whether the speciality or a directly competing category is already allocated or exclusive,
• the pitch fee, commission or deposit,
• the electricity, water, gas, waste and stand-size requirements,
• the required documents and final application deadline?

We can send photos, our menu and the required documents after your reply.

Kind regards`,
    verificationQuestions: questions
  };
}

export function buildAvailabilityPlan(
  snapshot: ProductSnapshot,
  now = new Date(),
  freeWeekCount = 2
) {
  const ranked = rankOpportunities(snapshot.events, snapshot.profile, now);
  const weeks = groupByCalendarWeek(ranked, snapshot.bookings)
    .filter((week) => week.endsAt >= now && week.bookings.length === 0)
    .filter((week) => week.events.some((item) => !["Blocked", "Closed"].includes(item.role)))
    .slice(0, freeWeekCount);

  return weeks.flatMap((week) =>
    week.events
      .filter((item) => !["Blocked", "Closed"].includes(item.role))
      .map((item) => createVerificationDraft(item.event, week.key, roleFor(item.role)))
  );
}

export async function refreshAvailabilityQueue() {
  if (!databaseConfigured()) {
    throw new Error("The availability queue requires the PitchRadar PostgreSQL catalogue.");
  }
  const snapshot = await loadProductSnapshot();
  const plan = buildAvailabilityPlan(snapshot);
  let created = 0;
  let refreshed = 0;

  await withDatabaseTransaction(async (client) => {
    for (const item of plan) {
      const eventResult = await client.query<{ id: string }>(
        "select id from events where tenant_id = $1 and external_id = $2",
        [TENANT_ID, item.event.id]
      );
      const eventId = eventResult.rows[0]?.id;
      if (!eventId) continue;
      const result = await client.query<{ id: string; inserted: boolean }>(
        `insert into availability_verification_requests (
          tenant_id, event_id, week_key, weekly_role, channel, status,
          recipient_name, recipient_email, recipient_phone, application_url,
          route_verified, subject, draft_de, draft_en, verification_questions
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15
        )
        on conflict (tenant_id, event_id, week_key) do update set
          weekly_role = excluded.weekly_role,
          channel = excluded.channel,
          status = case
            when availability_verification_requests.status in ('owner_review', 'blocked_contact_missing')
              then excluded.status
            else availability_verification_requests.status
          end,
          recipient_name = excluded.recipient_name,
          recipient_email = excluded.recipient_email,
          recipient_phone = excluded.recipient_phone,
          application_url = excluded.application_url,
          route_verified = excluded.route_verified,
          subject = excluded.subject,
          draft_de = excluded.draft_de,
          draft_en = excluded.draft_en,
          verification_questions = excluded.verification_questions,
          updated_at = now()
        returning id, (xmax = 0) as inserted`,
        [
          TENANT_ID,
          eventId,
          item.weekKey,
          item.weeklyRole,
          item.channel,
          item.status,
          item.event.application?.routeOwner || item.event.organizer || null,
          item.event.contactEmail || null,
          item.event.contactPhone || null,
          item.event.applicationUrl || null,
          item.routeVerified,
          item.subject,
          item.draftDe,
          item.draftEn,
          item.verificationQuestions
        ]
      );
      const request = result.rows[0];
      if (!request) continue;
      if (request.inserted) created += 1;
      else refreshed += 1;
      await client.query(
        `insert into availability_verification_receipts (request_id, action, actor, detail)
         values ($1, $2, 'pitchradar_verifier', $3::jsonb)`,
        [
          request.id,
          request.inserted ? "draft_created" : "draft_refreshed",
          JSON.stringify({
            eventExternalId: item.event.id,
            weekKey: item.weekKey,
            channel: item.channel,
            routeVerified: item.routeVerified,
            externalAction: false
          })
        ]
      );
    }
  });

  return { planned: plan.length, created, refreshed, externalActions: 0 };
}

export async function decideAvailabilityRequest(
  requestId: string,
  decision: "approve" | "cancel"
) {
  if (!databaseConfigured()) return null;
  return withDatabaseTransaction(async (client) => {
    const targetStatus = decision === "approve" ? "approved_waiting_connector" : "cancelled";
    const result = await client.query<{ id: string; status: VerificationQueueStatus }>(
      `update availability_verification_requests
       set status = $2,
         approved_at = case when $2 = 'approved_waiting_connector' then now() else approved_at end,
         approved_by = case when $2 = 'approved_waiting_connector' then 'owner' else approved_by end,
         updated_at = now()
       where id = $1
         and tenant_id = $3
         and status in ('owner_review', 'blocked_contact_missing')
         and ($2 <> 'approved_waiting_connector' or status = 'owner_review')
       returning id, status`,
      [requestId, targetStatus, TENANT_ID]
    );
    const request = result.rows[0];
    if (!request) return null;
    await client.query(
      `insert into availability_verification_receipts (request_id, action, actor, detail)
       values ($1, $2, 'owner', $3::jsonb)`,
      [
        request.id,
        decision === "approve" ? "owner_approved" : "owner_cancelled",
        JSON.stringify({ status: request.status, externalAction: false })
      ]
    );
    return request;
  });
}

export async function queueStatusCounts() {
  if (!databaseConfigured()) return {};
  const result = await databaseQuery<{ status: VerificationQueueStatus; count: number }>(
    `select status, count(*)::int as count
     from availability_verification_requests
     where tenant_id = $1
     group by status`,
    [TENANT_ID]
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, row.count]));
}

export type { AvailabilityVerificationRequest };
