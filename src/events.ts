import type { EventOpportunity } from "./types";

const observedAt = "2026-07-27T09:00:00+02:00";

export const eventLeads: EventOpportunity[] = [
  {
    id: "muellroser-seezauber-2026",
    name: "Müllroser Seezauber",
    city: "Müllrose",
    state: "Brandenburg",
    startsAt: "2026-08-01T14:00:00+02:00",
    endsAt: "2026-08-01T19:00:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Official state listing confirms a family event with fairground activity and live music",
      "Regional opportunity within Brandenburg",
      "Saturday matches the normal operating window"
    ],
    riskSignals: ["Vendor availability has not been confirmed", "Very short notice"],
    missingFields: ["Organizer contact", "Food vendors wanted?", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Official Brandenburg event listing",
        url: "https://efre.brandenburg.de/efre/de/aktuelles/veranstaltungen/",
        publisher: "Land Brandenburg",
        official: true,
        observedAt,
        supports: ["event_name", "date", "hours", "city", "event_concept"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "brueckenfest-criewen-2026",
    name: "Brückenfest Criewen",
    city: "Schwedt/Oder",
    state: "Brandenburg",
    startsAt: "2026-08-01T00:00:00+02:00",
    endsAt: "2026-08-01T23:59:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Official city calendar confirms the local festival date",
      "Regional Brandenburg opportunity",
      "Saturday matches the operating window"
    ],
    riskSignals: ["No public food-vendor application has been found", "Opening hours remain unknown"],
    missingFields: ["Organizer contact", "Food vendors wanted?", "Opening hours", "Pitch fee"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "date", "city"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "industriekultur-vierraden-2026",
    name: "Tag der Industriekultur",
    city: "Vierraden",
    state: "Brandenburg",
    startsAt: "2026-08-08T00:00:00+02:00",
    endsAt: "2026-08-08T23:59:00+02:00",
    eventType: "market",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Official city calendar confirms the event",
      "Saturday and regional location fit the operating profile"
    ],
    riskSignals: ["Food-vendor demand and visitor scale are unknown"],
    missingFields: ["Organizer contact", "Food vendors wanted?", "Visitor evidence", "Hours", "Fee"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "date", "city"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "tabakbluetenfest-vierraden-2026",
    name: "31. Tabakblütenfest",
    city: "Vierraden",
    state: "Brandenburg",
    startsAt: "2026-08-15T00:00:00+02:00",
    endsAt: "2026-08-15T23:59:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Established local festival confirmed by the official city calendar",
      "Saturday and regional location fit the operating profile"
    ],
    riskSignals: ["Food-vendor application and attendance evidence are unknown"],
    missingFields: ["Organizer contact", "Application route", "Visitor evidence", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "date", "city", "recurring_event"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "weihnachtsrodeo-berlin-2026",
    name: "Weihnachtsrodeo 2026",
    city: "Berlin",
    state: "Berlin",
    startsAt: "2026-12-12T12:00:00+01:00",
    endsAt: "2026-12-13T20:00:00+01:00",
    eventType: "christmas",
    verification: "verified",
    applicationState: "open",
    applicationUrl: "https://www.example-weihnachtsrodeo.de/bewerbung",
    application: {
      route: "public_form",
      capacityState: "unknown",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-07-28T09:00:00+02:00",
      routeOwner: "Weihnachtsrodeo",
      note: "The public food application is live. Remaining category capacity and the deadline are not published."
    },
    organizer: "Weihnachtsrodeo",
    infrastructure: {},
    fitSignals: [
      "An official food-vendor application is available",
      "Street food is explicitly part of the event concept",
      "The weekend matches the normal operating window",
      "Berlin is within the preferred regional focus"
    ],
    riskSignals: ["Pitch fee and technical requirements have not been confirmed"],
    missingFields: ["Application deadline", "Pitch fee", "Power", "Water", "Pitch footprint"],
    sources: [
      {
        label: "Food-vendor application and event facts",
        url: "https://www.example-weihnachtsrodeo.de/bewerbung",
        publisher: "Weihnachtsrodeo",
        official: true,
        observedAt,
        supports: ["dates", "hours", "location", "food_application", "event_concept"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "stadtfest-rathenow-2026",
    name: "Stadtfest Rathenow",
    city: "Rathenow",
    state: "Brandenburg",
    startsAt: "2026-09-06T11:00:00+02:00",
    endsAt: "2026-09-06T18:00:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "An official state source confirms a city festival with multiple stalls",
      "Regional opportunity within Brandenburg",
      "Sunday matches the normal operating window"
    ],
    riskSignals: ["No public vendor application was found on the checked source"],
    missingFields: ["Organizer contact", "Application route", "Pitch fee", "Power", "Water"],
    sources: [
      {
        label: "Official Brandenburg event listing",
        url: "https://efre.brandenburg.de/efre/de/aktuelles/veranstaltungen/",
        publisher: "Land Brandenburg",
        official: true,
        observedAt,
        supports: ["event_name", "date", "hours", "city", "stands_present"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "stadtfest-eisenhuettenstadt-2026",
    name: "Stadtfest Eisenhüttenstadt",
    city: "Eisenhüttenstadt",
    state: "Brandenburg",
    startsAt: "2026-08-28T11:00:00+02:00",
    endsAt: "2026-08-30T20:00:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "An official state source confirms the date and central festival area",
      "Friday matches the normal operating window",
      "Located in Brandenburg"
    ],
    riskSignals: ["The exact event end date still needs verification", "No vendor application has been found"],
    missingFields: ["Organizer", "End date", "Application route", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Brandenburg will Dich tour schedule",
        url: "https://esf.brandenburg.de/esf/de/ansicht/~22-06-2026-brandaktuell-brandenburg-will-dich",
        publisher: "Land Brandenburg",
        official: true,
        observedAt,
        supports: ["event_name", "date", "city", "venue_area"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "sportfest-brandenburg-havel-2026",
    name: "Sportfest für alle",
    city: "Brandenburg an der Havel",
    state: "Brandenburg",
    startsAt: "2026-08-29T09:00:00+02:00",
    endsAt: "2026-08-29T15:00:00+02:00",
    eventType: "sports",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "An official source confirms a family and sports event",
      "Saturday matches the normal operating window",
      "Regional opportunity"
    ],
    riskSignals: ["Availability for external food vendors is not yet confirmed"],
    missingFields: ["Are food vendors wanted?", "Organizer contact", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Official tour schedule",
        url: "https://esf.brandenburg.de/esf/de/ansicht/~22-06-2026-brandaktuell-brandenburg-will-dich",
        publisher: "Land Brandenburg",
        official: true,
        observedAt,
        supports: ["event_name", "date", "hours", "city", "venue"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "schlachtefest-paaren-2026",
    name: "Brandenburger Schlachtefest",
    city: "Paaren im Glien",
    state: "Brandenburg",
    startsAt: "2026-09-26T10:00:00+02:00",
    endsAt: "2026-09-27T18:00:00+02:00",
    eventType: "market",
    verification: "verified",
    applicationState: "closed",
    applicationDeadline: "2026-07-22",
    applicationUrl: "https://www.example-proagro.de/art/erlebnismarkt/",
    application: {
      route: "public_form",
      capacityState: "full",
      deadline: "2026-07-22",
      expectedNextWindow: "2027 cycle · opening date unknown",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-11-02T09:00:00+01:00",
      routeOwner: "pro agro e.V.",
      note: "The 2026 deadline passed. Only a waitlist enquiry could be relevant; the normal application is closed."
    },
    organizer: "pro agro e.V.",
    infrastructure: {},
    fitSignals: ["Brandenburg specialities and street food are central to the event", "Two weekend trading days"],
    riskSignals: ["The application deadline has already passed"],
    missingFields: ["Is a waiting list possible?", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Official application notice and deadline",
        url: "https://www.example-proagro.de/art/erlebnismarkt/",
        publisher: "pro agro e.V.",
        official: true,
        observedAt,
        supports: ["dates", "event_concept", "application_deadline", "selection_process"]
      }
    ],
    pipeline: "rejected"
  },
  {
    id: "schwedter-oktoberfest-2026",
    name: "Schwedter Oktoberfest",
    city: "Schwedt/Oder",
    state: "Brandenburg",
    startsAt: "2026-09-25T00:00:00+02:00",
    endsAt: "2026-09-27T23:59:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Three-day recurring city event confirmed by the official calendar",
      "Friday through Sunday matches the preferred operating window",
      "Regional Brandenburg opportunity"
    ],
    riskSignals: ["Food-vendor availability and application route remain unverified"],
    missingFields: ["Organizer contact", "Application route", "Pitch fee", "Visitor evidence", "Infrastructure"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "dates", "city", "recurring_event"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "kranichtage-weekend-one-2026",
    name: "21. Kranichtage · Weekend 1",
    city: "Lower Oder Valley",
    state: "Brandenburg",
    startsAt: "2026-10-02T00:00:00+02:00",
    endsAt: "2026-10-04T23:59:00+02:00",
    eventType: "market",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "Three-day regional event window confirmed by the official city calendar",
      "Friday through Sunday matches the preferred operating window"
    ],
    riskSignals: ["Food-vendor demand and the precise venue are not confirmed"],
    missingFields: ["Organizer contact", "Food vendors wanted?", "Venue", "Fee", "Infrastructure"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "dates", "region"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "kranichtage-weekend-two-2026",
    name: "21. Kranichtage · Weekend 2",
    city: "Lower Oder Valley",
    state: "Brandenburg",
    startsAt: "2026-10-09T00:00:00+02:00",
    endsAt: "2026-10-11T23:59:00+02:00",
    eventType: "market",
    verification: "partial",
    applicationState: "unknown",
    infrastructure: {},
    fitSignals: [
      "A second three-day regional event window is confirmed",
      "Friday through Sunday matches the preferred operating window"
    ],
    riskSignals: ["Food-vendor demand and the precise venue are not confirmed"],
    missingFields: ["Organizer contact", "Food vendors wanted?", "Venue", "Fee", "Infrastructure"],
    sources: [
      {
        label: "Official Schwedt annual events calendar",
        url: "https://brandenburg.de/de/kultur-und-freizeit/veranstaltungen/jahreshoehepunkte/31787",
        publisher: "Stadt Schwedt/Oder",
        official: true,
        observedAt,
        supports: ["event_name", "dates", "region"]
      }
    ],
    pipeline: "discovered"
  },
  {
    id: "hockenheim-street-food-2026",
    name: "Street Food Festival Hockenheim",
    city: "Hockenheim",
    state: "Baden-Württemberg",
    startsAt: "2026-08-07T16:00:00+02:00",
    endsAt: "2026-08-09T20:00:00+02:00",
    eventType: "street_food",
    verification: "verified",
    applicationState: "unknown",
    organizer: "Muster Events GmbH",
    application: {
      route: "email",
      capacityState: "unknown",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-07-28T09:00:00+02:00",
      routeOwner: "Muster Events GmbH",
      note: "The organizer and event are verified, but there is no public proof that a speciality pitch remains."
    },
    infrastructure: {},
    fitSignals: [
      "Established street-food tour with curated food stalls",
      "Friday through Sunday matches the normal operating window"
    ],
    riskSignals: ["Very short notice", "Travel and vendor availability still need verification"],
    missingFields: ["Vendor place available?", "Application deadline", "Travel from exact postcode", "Fee", "Infrastructure"],
    sources: [
      {
        label: "Official 2026 festival tour",
        url: "https://www.example-muster-events.de/",
        publisher: "Muster Events GmbH",
        official: true,
        observedAt,
        supports: ["dates", "city", "event_type", "organizer", "curated_food_stands"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "norder-sommerfest-2026",
    name: "Norder Sommerfest",
    city: "Norden",
    state: "Lower Saxony",
    startsAt: "2026-08-28T12:00:00+02:00",
    endsAt: "2026-08-30T20:00:00+02:00",
    eventType: "city_festival",
    verification: "verified",
    applicationState: "open",
    applicationUrl: "https://www.norden.de/Stadtleben/Kultur-Freizeit/M%C3%A4rkte-Feste/Norder-Sommerfest/Norder-Sommerfest-2026-Bewerbungsphase-gestartet.php?FID=3170.51782.1&La=1&ModID=7&NavID=3170.108&object=tx%2C3170.5",
    organizer: "Stadt Norden",
    application: {
      route: "public_form",
      capacityState: "rolling",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-07-28T09:00:00+02:00",
      routeOwner: "Stadt Norden",
      note: "The city states that food and market stand applications are planned continuously with no fixed deadline."
    },
    infrastructure: {},
    fitSignals: [
      "Three-day Friday–Sunday city festival",
      "The official city page explicitly accepts food-stand applications",
      "Rolling planning means a late opportunity may still exist"
    ],
    riskSignals: ["Remaining speciality/category capacity is not published", "Travel requires the exact home postcode"],
    missingFields: ["Speciality pitch available?", "Pitch fee", "Power", "Water", "Expected attendance"],
    sources: [
      {
        label: "Official rolling food-stand application",
        url: "https://www.norden.de/Stadtleben/Kultur-Freizeit/M%C3%A4rkte-Feste/Norder-Sommerfest/Norder-Sommerfest-2026-Bewerbungsphase-gestartet.php?FID=3170.51782.1&La=1&ModID=7&NavID=3170.108&object=tx%2C3170.5",
        publisher: "Stadt Norden",
        official: true,
        observedAt,
        supports: ["dates", "organizer", "food_application", "rolling_application"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "canaletto-dresden-2026",
    name: "CANALETTO · Dresden City Festival",
    city: "Dresden",
    state: "Saxony",
    startsAt: "2026-08-14T16:00:00+02:00",
    endsAt: "2026-08-16T20:00:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    applicationUrl: "https://www.example-haendler-portal.de/portal/events/edit/",
    organizer: "Agentur Beispiel",
    application: {
      route: "public_form",
      capacityState: "unknown",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-07-28T09:00:00+02:00",
      routeOwner: "Agentur Beispiel Händlerportal",
      note: "The event is listed in the active trader portal; event-specific capacity is visible only after opening the portal record."
    },
    infrastructure: {},
    fitSignals: ["Three trading days", "A dedicated trader portal handles application, contract and acceptance"],
    riskSignals: ["Short notice", "Public view does not prove that food places remain"],
    missingFields: ["Food application still available?", "Pitch fee", "Category exclusivity", "Power and water"],
    sources: [
      {
        label: "Digital trader portal event listing",
        url: "https://www.example-haendler-portal.de/portal/events/edit/",
        publisher: "Agentur Beispiel",
        official: true,
        observedAt,
        supports: ["event_name", "dates", "city", "trader_portal"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "laternenfest-halle-2026",
    name: "Laternenfest Halle",
    city: "Halle (Saale)",
    state: "Saxony-Anhalt",
    startsAt: "2026-08-28T16:00:00+02:00",
    endsAt: "2026-08-30T20:00:00+02:00",
    eventType: "city_festival",
    verification: "verified",
    applicationState: "unknown",
    organizer: "Stadt Halle (Saale)",
    contactEmail: "laternenfest@example-halle.de",
    contactPhone: "+49 30 0000005",
    application: {
      route: "email",
      capacityState: "unknown",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-07-28T09:00:00+02:00",
      routeOwner: "Team Veranstaltungen · Stadt Halle",
      note: "The city publicly requested savoury, sweet and speciality gastronomy, but the checked notice gives no explicit closing date."
    },
    infrastructure: {},
    fitSignals: [
      "Three-day major city festival",
      "The city explicitly requested food and speciality gastronomy",
      "Named event-team contacts are public"
    ],
    riskSignals: ["Availability now requires direct verification", "The public call was published in February"],
    missingFields: ["Application still accepted?", "Speciality category available?", "Pitch fee", "Infrastructure"],
    sources: [
      {
        label: "Official gastronomy recruitment notice",
        url: "https://halle.de/verwaltung-stadtrat/presseportal/nachrichten/nachricht/stadt-sucht-haendler-fuer-laternenfest-2026",
        publisher: "Stadt Halle (Saale)",
        official: true,
        observedAt,
        supports: ["dates", "organizer", "gastronomy_wanted", "contact"]
      }
    ],
    pipeline: "verifying"
  },
  {
    id: "mainzer-rheinfruehling-2027",
    name: "Mainzer Rheinfrühling 2027",
    city: "Mainz",
    state: "Rhineland-Palatinate",
    startsAt: "2027-03-20T11:00:00+01:00",
    endsAt: "2027-04-04T22:00:00+02:00",
    eventType: "market",
    verification: "verified",
    applicationState: "open",
    applicationDeadline: "2026-08-31",
    applicationUrl: "https://mainz.de/vv/produkte/wirtschaft/mainzer-rheinfruehling-standplatz-buchen",
    organizer: "Landeshauptstadt Mainz · Messen und Märkte",
    contactEmail: "marktverwaltung@example-mainz.de",
    contactPhone: "+49 30 0000007",
    application: {
      route: "public_form",
      capacityState: "available",
      deadline: "2026-08-31",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-08-03T09:00:00+02:00",
      routeOwner: "Marktverwaltung Mainz",
      note: "The city accepts written applications for the following year's fair until 31 August."
    },
    infrastructure: {},
    fitSignals: ["Sixteen-day booking", "Official 2027 dates and annual deadline are already published"],
    riskSignals: ["Long-distance economics and full-run requirement must be checked", "Selection is not guaranteed"],
    missingFields: ["Travel from postcode", "Pitch fee", "Mandatory operating days", "Expected attendance"],
    sources: [
      {
        label: "Official stand application service",
        url: "https://mainz.de/vv/produkte/wirtschaft/mainzer-rheinfruehling-standplatz-buchen",
        publisher: "Landeshauptstadt Mainz",
        official: true,
        observedAt,
        supports: ["2027_dates", "deadline", "application_route", "contact"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "annafest-forchheim-2027",
    name: "Annafest Forchheim 2027",
    city: "Forchheim",
    state: "Bavaria",
    startsAt: "2027-07-23T12:00:00+02:00",
    endsAt: "2027-08-02T23:00:00+02:00",
    eventType: "city_festival",
    verification: "verified",
    applicationState: "open",
    applicationDeadline: "2026-09-30",
    applicationUrl: "https://www.forchheim.de/rathaus-service/service/service-a-z/annafest-bewerbungsmodalitaeten",
    organizer: "Stadt Forchheim · Veranstaltungsamt",
    contactEmail: "veranstaltungsamt@example-forchheim.de",
    contactPhone: "+49 30 0000008",
    application: {
      route: "public_form",
      capacityState: "available",
      deadline: "2026-09-30",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-08-17T09:00:00+02:00",
      routeOwner: "Stadt Forchheim · Veranstaltungsamt",
      note: "The official 2027 application is open and requires business, stand, utility, vehicle, insurance and product details."
    },
    infrastructure: {},
    fitSignals: ["Eleven-day event", "Exact 2027 deadline and municipal decision contacts are published"],
    riskSignals: ["Distance and long-run staffing economics need validation", "Application requires a complete technical pack"],
    missingFields: ["Travel from postcode", "Pitch fee", "Client technical pack", "Expected attendance"],
    sources: [
      {
        label: "Official 2027 application rules",
        url: "https://www.forchheim.de/rathaus-service/service/service-a-z/annafest-bewerbungsmodalitaeten",
        publisher: "Stadt Forchheim",
        official: true,
        observedAt,
        supports: ["2027_dates", "deadline", "requirements", "contact"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "tag-der-sachsen-plauen-2027",
    name: "Tag der Sachsen 2027",
    city: "Plauen",
    state: "Saxony",
    startsAt: "2027-06-18T12:00:00+02:00",
    endsAt: "2027-06-20T20:00:00+02:00",
    eventType: "city_festival",
    verification: "verified",
    applicationState: "open",
    applicationDeadline: "2026-12-31",
    applicationUrl: "https://www.example-haendler-portal.de/portal/events/edit/",
    organizer: "Agentur Beispiel Händlerportal",
    application: {
      route: "public_form",
      capacityState: "available",
      deadline: "2026-12-31",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-10-01T09:00:00+02:00",
      routeOwner: "Agentur Beispiel Händlerportal",
      note: "The portal shows the first application phase and its 31 December deadline."
    },
    infrastructure: {},
    fitSignals: ["Three-day Friday–Sunday event", "The first 2027 application phase is already open"],
    riskSignals: ["Portal account is required for event-specific requirements", "Acceptance and category capacity are unconfirmed"],
    missingFields: ["Food category availability", "Pitch fee", "Attendance", "Infrastructure"],
    sources: [
      {
        label: "Trader portal first application phase",
        url: "https://www.example-haendler-portal.de/portal/events/edit/",
        publisher: "Agentur Beispiel",
        official: true,
        observedAt,
        supports: ["2027_dates", "deadline", "application_portal"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "stadtfest-dessau-2027",
    name: "Stadtfest Dessau 2027",
    city: "Dessau-Roßlau",
    state: "Saxony-Anhalt",
    startsAt: "2027-07-02T17:00:00+02:00",
    endsAt: "2027-07-04T18:00:00+02:00",
    eventType: "city_festival",
    verification: "verified",
    applicationState: "open",
    applicationDeadline: "2027-03-31",
    applicationUrl: "https://www.example-dessfest.de/bewerbung/",
    organizer: "Stadtmarketinggesellschaft Dessau-Roßlau mbH",
    contactEmail: "bewerbung@example-stadtfest.de",
    contactPhone: "+49 30 0000004",
    application: {
      route: "public_form",
      capacityState: "available",
      deadline: "2027-03-31",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-11-02T09:00:00+01:00",
      routeOwner: "Stadtmarketinggesellschaft Dessau-Roßlau mbH",
      note: "The official 2027 gastronomy application and deadline are already public."
    },
    infrastructure: {},
    fitSignals: [
      "Three-day Friday–Sunday event near the home region",
      "Official Food-Meile and open 2027 gastronomy application",
      "Long preparation runway"
    ],
    riskSignals: ["Pitch economics and category exclusivity are not published"],
    missingFields: ["Pitch fee", "Speciality/category availability", "Power and water", "Expected visitors"],
    sources: [
      {
        label: "Official 2027 event page",
        url: "https://www.example-dessfest.de/",
        publisher: "Stadtmarketinggesellschaft Dessau-Roßlau mbH",
        official: true,
        observedAt,
        supports: ["2027_dates", "food_mile", "organizer", "contact"]
      },
      {
        label: "Official 2027 gastronomy application",
        url: "https://www.example-dessfest.de/bewerbung/",
        publisher: "Stadtmarketinggesellschaft Dessau-Roßlau mbH",
        official: true,
        observedAt,
        supports: ["application_open", "deadline", "application_route"]
      }
    ],
    pipeline: "owner_review"
  },
  {
    id: "rudolstadt-festival-2027",
    name: "Rudolstadt Festival 2027",
    city: "Rudolstadt",
    state: "Thuringia",
    startsAt: "2027-07-01T12:00:00+02:00",
    endsAt: "2027-07-04T23:00:00+02:00",
    eventType: "city_festival",
    verification: "partial",
    applicationState: "unknown",
    organizer: "Rudolstadt-Festival",
    contactEmail: "handel@example-festival.de",
    contactPhone: "+49 30 0000006",
    application: {
      route: "email",
      capacityState: "not_yet_open",
      expectedNextWindow: "Autumn 2026 · exact opening date unconfirmed",
      lastCheckedAt: observedAt,
      nextCheckAt: "2026-09-15T09:00:00+02:00",
      routeOwner: "Festival trade and catering team",
      note: "The 2027 dates and catering contact are official. A current 2027 application window was not found, so the agent must watch rather than claim applications are open."
    },
    infrastructure: {},
    fitSignals: [
      "Four-day festival with a dedicated catering contact",
      "The next-cycle watch begins months before the event year",
      "Thursday–Sunday aligns with the available operating window"
    ],
    riskSignals: ["The 2027 application opening date is not yet verified", "Distance and economics require the exact home postcode"],
    missingFields: ["Application opening date", "Deadline", "Speciality category availability", "Pitch fee", "Travel from postcode"],
    sources: [
      {
        label: "Official festival contact and 2027 dates",
        url: "https://www.example-rudolstadt-festival.de/kontakt.html",
        publisher: "Rudolstadt-Festival",
        official: true,
        observedAt,
        supports: ["2027_dates", "catering_contact", "application_route_owner"]
      }
    ],
    pipeline: "watching"
  }
];
