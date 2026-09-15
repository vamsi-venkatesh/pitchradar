import { clientBookings } from "../src/bookings";
import { eventLeads } from "../src/events";
import { clientProfile, missingProfileInputs } from "../src/profile";
import { rankOpportunities } from "../src/ranking";
import { sourceRegistry } from "../src/source-registry";
import {
  closeDatabase,
  databaseHealth,
  migrateDatabase,
  withDatabaseTransaction
} from "../server/database";

const TENANT_ID = "4ae3f520-3230-4f6d-9f6d-fdc6e105dcc5";

try {
  await migrateDatabase();
  const counts = await withDatabaseTransaction(async (client) => {
    for (const source of sourceRegistry) {
      await client.query(
        `insert into registered_sources (
          id, name, base_url, collector_url, source_kind, source_layer, priority, cadence,
          extraction_mode, official_for, trust_rule, business_value, enabled
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
        on conflict (id) do update set
          name=excluded.name, base_url=excluded.base_url, collector_url=excluded.collector_url,
          source_kind=excluded.source_kind,
          source_layer=excluded.source_layer, priority=excluded.priority, cadence=excluded.cadence,
          extraction_mode=excluded.extraction_mode, official_for=excluded.official_for,
          trust_rule=excluded.trust_rule, business_value=excluded.business_value`,
        [
          source.id,
          source.name,
          source.baseUrl,
          source.collectorUrl ?? null,
          source.kind,
          source.layer,
          source.priority,
          source.cadence,
          source.extractionMode,
          source.officialFor,
          source.trustRule,
          source.businessValue
        ]
      );
    }

    await client.query(
      `insert into client_profiles (
        tenant_id, profile_key, display_name, home_region, home_postcode,
        preferred_max_travel_minutes, exceptional_max_travel_minutes,
        normal_days, optional_thursday, menu, operating_inputs, missing_inputs, updated_at
      ) values ($1,'primary','speciality food-truck client',$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,now())
      -- The seed may never overwrite what the client themselves answered.
      -- Once the intake has any answer, or the menu has been confirmed, this
      -- row belongs to the client and the fixture only fills genuine blanks.
      on conflict (tenant_id, profile_key) do update set
        display_name=excluded.display_name,
        home_region=case when client_profiles.intake = '{}'::jsonb
          then excluded.home_region else client_profiles.home_region end,
        home_postcode=coalesce(client_profiles.home_postcode, excluded.home_postcode),
        preferred_max_travel_minutes=case when client_profiles.intake = '{}'::jsonb
          then excluded.preferred_max_travel_minutes else client_profiles.preferred_max_travel_minutes end,
        exceptional_max_travel_minutes=case when client_profiles.intake = '{}'::jsonb
          then excluded.exceptional_max_travel_minutes else client_profiles.exceptional_max_travel_minutes end,
        normal_days=case when client_profiles.intake = '{}'::jsonb
          then excluded.normal_days else client_profiles.normal_days end,
        optional_thursday=case when client_profiles.intake = '{}'::jsonb
          then excluded.optional_thursday else client_profiles.optional_thursday end,
        menu=case when client_profiles.menu_confirmed_at is null and client_profiles.intake = '{}'::jsonb
          then excluded.menu else client_profiles.menu end,
        operating_inputs=case when client_profiles.intake = '{}'::jsonb
          then excluded.operating_inputs else client_profiles.operating_inputs end,
        missing_inputs=case when client_profiles.intake = '{}'::jsonb
          then excluded.missing_inputs else client_profiles.missing_inputs end,
        updated_at=now()`,
      [
        TENANT_ID,
        clientProfile.homeRegion,
        clientProfile.homePostcode ?? null,
        clientProfile.preferredMaxTravelMinutes,
        clientProfile.exceptionalMaxTravelMinutes,
        clientProfile.normalDays,
        clientProfile.optionalThursday,
        JSON.stringify(clientProfile.menu),
        JSON.stringify(clientProfile.operatingInputs),
        missingProfileInputs
      ]
    );

    const organizerIds = new Map<string, string>();
    const organizerNames = new Set(
      [
        ...eventLeads.map((event) => event.organizer),
        ...clientBookings.flatMap((booking) => [booking.organizer, booking.operatingPartner])
      ].filter((value): value is string => Boolean(value))
    );
    for (const name of organizerNames) {
      const result = await client.query<{ id: string }>(
        `insert into organizers (canonical_name, organizer_type, verification, updated_at)
         values ($1,'festival_operator','partial',now())
         on conflict (canonical_name) do update set updated_at=now()
         returning id`,
        [name]
      );
      organizerIds.set(name, result.rows[0].id);
    }

    for (const event of rankOpportunities(eventLeads, clientProfile)) {
      const result = await client.query<{ id: string }>(
        `insert into events (
          tenant_id, external_id, canonical_name, city, federal_state, starts_at, ends_at,
          event_type, organizer_id, organizer_name, verification, application_status,
          application_deadline, application_url, expected_visitors, pitch_fee_eur,
          travel_minutes, travel_km, infrastructure, fit_signals, risk_signals, missing_fields,
          current_score, current_tier, score_breakdown, pipeline, last_verified_at, updated_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19::jsonb,$20,$21,$22,$23,$24,$25::jsonb,$26,$27,now()
        )
        on conflict (tenant_id, external_id) do update set
          canonical_name=excluded.canonical_name, city=excluded.city,
          federal_state=excluded.federal_state, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
          event_type=excluded.event_type, organizer_id=excluded.organizer_id,
          organizer_name=excluded.organizer_name, verification=excluded.verification,
          application_status=excluded.application_status,
          application_deadline=excluded.application_deadline, application_url=excluded.application_url,
          expected_visitors=excluded.expected_visitors, pitch_fee_eur=excluded.pitch_fee_eur,
          travel_minutes=excluded.travel_minutes, travel_km=excluded.travel_km,
          infrastructure=excluded.infrastructure, fit_signals=excluded.fit_signals,
          risk_signals=excluded.risk_signals, missing_fields=excluded.missing_fields,
          current_score=excluded.current_score, current_tier=excluded.current_tier,
          score_breakdown=excluded.score_breakdown, pipeline=excluded.pipeline,
          last_verified_at=excluded.last_verified_at, updated_at=now()
        returning id`,
        [
          TENANT_ID,
          event.id,
          event.name,
          event.city,
          event.state,
          event.startsAt,
          event.endsAt,
          event.eventType,
          event.organizer ? organizerIds.get(event.organizer) ?? null : null,
          event.organizer ?? null,
          event.verification,
          event.applicationState,
          event.applicationDeadline ?? event.application?.deadline ?? null,
          event.applicationUrl ?? null,
          event.expectedVisitors ?? null,
          event.pitchFeeEur ?? null,
          event.travelMinutes ?? null,
          event.travelKm ?? null,
          JSON.stringify(event.infrastructure),
          event.fitSignals,
          event.riskSignals,
          event.missingFields,
          event.score ?? null,
          event.tier ?? null,
          JSON.stringify(event.scoreBreakdown ?? {}),
          event.pipeline,
          event.sources[0]?.observedAt ?? null
        ]
      );
      const eventId = result.rows[0].id;
      await client.query("delete from event_evidence where event_id = $1", [eventId]);
      for (const evidence of event.sources) {
        await client.query(
          `insert into event_evidence (
            event_id, source_url, publisher, is_official, observed_at, supports_fields, evidence_excerpt
          ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            eventId,
            evidence.url,
            evidence.publisher,
            evidence.official,
            evidence.observedAt,
            evidence.supports,
            evidence.label
          ]
        );
      }
      if (event.application) {
        await client.query(
          `insert into application_windows (
            event_id, route_type, capacity, opens_at, deadline_at, expected_next_window,
            route_owner, application_url, status_note, last_checked_at, next_check_at, updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
          on conflict (event_id) do update set
            route_type=excluded.route_type, capacity=excluded.capacity,
            opens_at=excluded.opens_at, deadline_at=excluded.deadline_at,
            expected_next_window=excluded.expected_next_window, route_owner=excluded.route_owner,
            application_url=excluded.application_url, status_note=excluded.status_note,
            last_checked_at=excluded.last_checked_at, next_check_at=excluded.next_check_at,
            updated_at=now()`,
          [
            eventId,
            event.application.route,
            event.application.capacityState,
            event.application.opensAt ?? null,
            event.application.deadline ?? null,
            event.application.expectedNextWindow ?? null,
            event.application.routeOwner ?? null,
            event.applicationUrl ?? null,
            event.application.note,
            event.application.lastCheckedAt,
            event.application.nextCheckAt
          ]
        );
      } else {
        await client.query("delete from application_windows where event_id = $1", [eventId]);
      }
    }

    for (const booking of clientBookings) {
      const result = await client.query<{ id: string }>(
        `insert into client_bookings (
          tenant_id, external_id, event_name, city, federal_state, starts_at, ends_at, state,
          organizer_id, operating_partner_id, stand_or_zone, relationship_note,
          confirmed_facts, missing_outcome_inputs, owner_confirmed_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
        on conflict (tenant_id, external_id) do update set
          event_name=excluded.event_name, city=excluded.city, federal_state=excluded.federal_state,
          starts_at=excluded.starts_at, ends_at=excluded.ends_at, state=excluded.state,
          organizer_id=excluded.organizer_id, operating_partner_id=excluded.operating_partner_id,
          stand_or_zone=excluded.stand_or_zone, relationship_note=excluded.relationship_note,
          confirmed_facts=excluded.confirmed_facts,
          missing_outcome_inputs=excluded.missing_outcome_inputs, updated_at=now()
        returning id`,
        [
          TENANT_ID,
          booking.id,
          booking.eventName,
          booking.city,
          booking.state,
          booking.startsAt,
          booking.endsAt,
          booking.bookingState,
          organizerIds.get(booking.organizer) ?? null,
          booking.operatingPartner ? organizerIds.get(booking.operatingPartner) ?? null : null,
          booking.standOrZone ?? null,
          booking.relationshipNote,
          booking.confirmedFacts,
          booking.missingOutcomeInputs,
          booking.sources[0]?.observedAt ?? new Date().toISOString()
        ]
      );
      const bookingId = result.rows[0].id;
      await client.query("delete from booking_evidence where booking_id = $1", [bookingId]);
      for (const evidence of booking.sources) {
        await client.query(
          `insert into booking_evidence (
            booking_id, source_url, label, publisher, is_official, observed_at, supports_fields
          ) values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            bookingId,
            evidence.url,
            evidence.label,
            evidence.publisher,
            evidence.official,
            evidence.observedAt,
            evidence.supports
          ]
        );
      }
    }

    const result = await client.query<{
      events: number;
      sources: number;
      bookings: number;
      profiles: number;
    }>(`
      select
        (select count(*)::int from events where tenant_id = $1) as events,
        (select count(*)::int from registered_sources where enabled) as sources,
        (select count(*)::int from client_bookings where tenant_id = $1) as bookings,
        (select count(*)::int from client_profiles where tenant_id = $1) as profiles
    `, [TENANT_ID]);
    return result.rows[0];
  });
  console.log(JSON.stringify({ database: await databaseHealth(), seeded: counts }, null, 2));
} finally {
  await closeDatabase();
}
