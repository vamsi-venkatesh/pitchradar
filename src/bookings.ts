import type { ClientBooking } from "./types";

const observedAt = "2026-07-27T15:00:00+02:00";

export const clientBookings: ClientBooking[] = [
  {
    id: "client-seefest-demo-ufer-2026",
    eventName: "Seefest am Demo-Ufer",
    city: "Musterstadt",
    state: "Lower Saxony",
    startsAt: "2026-07-22T14:00:00+02:00",
    endsAt: "2026-08-09T23:59:00+02:00",
    bookingState: "live",
    organizer: "Demo Veranstaltungs GmbH",
    operatingPartner: "Nordlicht Food Festivals",
    relationshipNote:
      "Owner-confirmed client operation. The public event page names the food-zone operator; the client's exact contractual relationship still needs to be recorded.",
    standOrZone: "Streetfood am Ufer · Nordpromenade",
    confirmedFacts: [
      "The client is the speciality vendor currently trading at the event",
      "The event runs for 19 consecutive days",
      "The official food zone lists the speciality in its current offer",
      "This booking occupies the truck across three calendar weeks"
    ],
    missingOutcomeInputs: [
      "Booking route and first contact date",
      "Contracting party and pitch arrangement",
      "Daily portions and revenue",
      "Pitch, labour, travel and accommodation costs",
      "Stock loss, weather impact and owner rating",
      "Repeat invitation or 2027 application timing"
    ],
    sources: [
      {
        label: "Owner confirmation",
        url: "owner://client-confirmation/seefest-demo-ufer-2026",
        publisher: "Client owner",
        official: true,
        observedAt,
        supports: ["client_identity", "active_booking", "speciality_operation"]
      },
      {
        label: "Official event dates and programme",
        url: "https://www.example-musterstadt.de/veranstaltungskalender/seefest",
        publisher: "Stadt Musterstadt",
        official: true,
        observedAt,
        supports: ["event_name", "dates", "city"]
      },
      {
        label: "Official food-zone operator and offer",
        url: "https://www.example-seefest.de/gastronomie/streetfood-am-ufer/",
        publisher: "Seefest am Demo-Ufer",
        official: true,
        observedAt,
        supports: ["food_zone", "operator", "speciality_offer"]
      }
    ]
  }
];
