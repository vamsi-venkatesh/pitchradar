import { describe, expect, it } from "vitest";
import {
  extractAdapterEvents,
  extractFoodtruckmeileEvents,
  extractGermanListEvents,
  extractHaendlerPortalEvents,
  extractIcsEvents,
  extractJsonLdEvents,
  extractTourAgenturEvents,
  parseGermanDate,
  parseGermanDateRange
} from "./source-adapters";

const NOW = new Date("2026-08-01T09:00:00.000Z");

describe("source-specific event adapters", () => {
  it("parses German full and abbreviated date ranges", () => {
    expect(parseGermanDateRange("17.-19.07.2026")).toMatchObject({
      startsOn: "2026-07-17",
      endsOn: "2026-07-19"
    });
    expect(parseGermanDateRange("31.07.-02.08.2026")).toMatchObject({
      startsOn: "2026-07-31",
      endsOn: "2026-08-02"
    });
    expect(parseGermanDateRange("20.03.-22.03.`26")).toMatchObject({
      startsOn: "2026-03-20",
      endsOn: "2026-03-22"
    });
    expect(parseGermanDateRange("18.06.2027 - 20.06.2027")).toMatchObject({
      startsOn: "2027-06-18",
      endsOn: "2027-06-20"
    });
  });

  it("extracts a Foodtruckmeile tour row and direct partner route", () => {
    const html = `
      <h2>Termine 2026</h2>
      <h1>Darmstadt</h1><h1>Karolinenplatz</h1><h1>17.-19.07.2026</h1>
      <a>Entdecken</a><a>Route</a>
      <h2>Mitmachen</h2>
    `;
    expect(extractFoodtruckmeileEvents(html)).toMatchObject([{
      rawName: "Foodtruckmeile Darmstadt",
      rawLocation: "Darmstadt",
      rawStartsAt: "2026-07-17",
      rawEndsAt: "2026-07-19",
      rawPayload: {
        venue: "Karolinenplatz",
        applicationUrl: "https://example-foodtruckmeile.de/dirketbewerbung"
      }
    }]);
  });

  it("extracts Tour-Agentur accordion headings without trusting stale descriptions", () => {
    const content = `
      <div class="accordion-title"><h2>30.07.-02.08.\`26 Bergheim</h2></div>
      <div class="accordion-description">A stale body date should not override the tour heading.</div>
      <div class="accordion-title"><h2>ca. 9 weitere Städte/Termine folgen...</h2></div>
    `;
    const html = JSON.stringify({ content, page_title: "Tourplan 2026" });
    expect(extractTourAgenturEvents(html)).toMatchObject([{
      rawName: "Street Food Drink & Music Festival Bergheim",
      rawLocation: "Bergheim",
      rawStartsAt: "2026-07-30",
      rawEndsAt: "2026-08-02",
      rawPayload: {
        applicationUrl: "https://www.example-tour-agentur.de/bewerbungsformular"
      }
    }]);
  });

  it("extracts Händlerportal events and published application deadlines", () => {
    const html = `
      <h2>Unsere Veranstaltungen</h2>
      <span>Veranstaltung anzeigen</span>
      <h4>Tag der Sachsen 2027 - Plauen</h4>
      <li>18.06.2027 - 20.06.2027</li>
      <li>Plauen</li>
      <p>Frist für 1. Bewerbungsphase:</p>
      <p>31.12.2026</p>
      <span>Veranstaltung anzeigen</span>
    `;
    expect(extractHaendlerPortalEvents(html)).toMatchObject([{
      rawName: "Tag der Sachsen 2027 - Plauen",
      rawLocation: "Plauen",
      rawStartsAt: "2027-06-18",
      rawEndsAt: "2027-06-20",
      rawPayload: {
        applicationDeadline: "2026-12-31"
      }
    }]);
  });
});

describe("generic schema.org JSON-LD event extractor", () => {
  it("walks a nested @graph and keeps only named event nodes", () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Stadtmarketing" },
          {
            "@type": "ItemList",
            itemListElement: [{
              "@type": "ListItem",
              item: {
                "@type": "Festival",
                "@id": "https://example.test/fest/1",
                name: "Havelfest Rathenow",
                startDate: "2026-08-14",
                endDate: "2026-08-16",
                url: "https://example.test/fest/1",
                organizer: { "@type": "Organization", name: "Stadt Rathenow" },
                offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
                location: {
                  "@type": "Place",
                  name: "Marktplatz",
                  address: {
                    "@type": "PostalAddress",
                    streetAddress: "Berliner Str. 15",
                    addressLocality: "Rathenow",
                    postalCode: "14712",
                    addressRegion: "Brandenburg",
                    addressCountry: "DE"
                  }
                }
              }
            }]
          }
        ]
      })}</script>
    `;
    expect(extractJsonLdEvents(html, { now: NOW })).toMatchObject([{
      sourceRecordKey: "https://example.test/fest/1",
      rawName: "Havelfest Rathenow",
      rawLocation: "Marktplatz, Rathenow, 14712",
      rawStartsAt: "2026-08-14",
      rawEndsAt: "2026-08-16",
      rawPayload: {
        city: "Rathenow",
        postalCode: "14712",
        federalStateHint: "Brandenburg",
        country: "DE",
        routeOwner: "Stadt Rathenow",
        eventUrl: "https://example.test/fest/1",
        extraction: "json_ld"
      }
    }]);
  });

  it("accepts a top-level array, defaults a missing end date and keeps full ISO datetimes", () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify([
        {
          "@type": "FoodEvent",
          name: "Street Food Festival Strausberg",
          startDate: "2026-08-14T16:00:00+02:00",
          location: "Kulturpark, 15344 Strausberg"
        },
        {
          "@type": ["Event", "MusicEvent"],
          name: "Seezauber",
          startDate: "2026-09-05",
          endDate: "2026-09-06"
        }
      ])}</script>
    `;
    const events = extractJsonLdEvents(html, { now: NOW });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      rawName: "Street Food Festival Strausberg",
      rawStartsAt: "2026-08-14T16:00:00",
      rawEndsAt: "2026-08-14",
      rawPayload: { city: "Strausberg" }
    });
    expect(events[1]).toMatchObject({ rawStartsAt: "2026-09-05", rawEndsAt: "2026-09-06" });
  });

  it("skips a malformed block, an undated event, a cancelled one and anything already over", () => {
    const html = `
      <script type="application/ld+json">{ "@type": "Event", name: broken json </script>
      <script type="application/ld+json">${JSON.stringify([
        { "@type": "Event", name: "Kein Datum" },
        { "@type": "Event", name: "Abgesagt", startDate: "2026-09-01", eventStatus: "https://schema.org/EventCancelled" },
        { "@type": "Event", name: "Schon vorbei", startDate: "2026-06-01", endDate: "2026-06-03" },
        { "@type": "Event", name: "Läuft noch", startDate: "2026-09-12", endDate: "2026-09-13" }
      ])}</script>
    `;
    expect(extractJsonLdEvents(html, { now: NOW }).map((event) => event.rawName))
      .toEqual(["Läuft noch"]);
  });

  it("decodes entities and deduplicates identical event nodes", () => {
    const node = {
      "@type": "Event",
      name: "Street Food &amp; Music Festival D&amp;uuml;sseldorf",
      startDate: "2026-10-02",
      endDate: "2026-10-04"
    };
    const html = `<script type='application/ld+json'>${JSON.stringify([node, node])}</script>`;
    const events = extractJsonLdEvents(html, { now: NOW });
    expect(events).toHaveLength(1);
    expect(events[0].rawName).toBe("Street Food & Music Festival Düsseldorf");
  });
});

describe("generic ICS calendar extractor", () => {
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:event-8585@example-street-food-market.de",
    "SUMMARY:Bad D\\, Street Food Festi",
    " val 2026",
    "DTSTART;VALUE=DATE:20260814",
    "DTEND;VALUE=DATE:20260817",
    "LOCATION:Saline\\, 67098 Bad Dürkheim",
    "URL:https://example.test/event/bad-duerkheim",
    "DESCRIPTION:Internationale Food Trucks",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:event-9001@example-street-food-market.de",
    "SUMMARY:Landauer Street Food Festival",
    "DTSTART;TZID=Europe/Berlin:20261023T160000",
    "DTEND;TZID=Europe/Berlin:20261025T200000",
    "LOCATION:Alter Messplatz Landau",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:event-7000@example-street-food-market.de",
    "SUMMARY:Fruehlingsfest 2026",
    "DTSTART;VALUE=DATE:20260403",
    "DTEND;VALUE=DATE:20260406",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  it("unfolds folded lines and converts an exclusive all-day DTEND to the last trading day", () => {
    const events = extractIcsEvents(calendar, { now: NOW });
    expect(events[0]).toMatchObject({
      sourceRecordKey: "event-8585@example-street-food-market.de",
      rawName: "Bad D, Street Food Festival 2026",
      rawStartsAt: "2026-08-14",
      rawEndsAt: "2026-08-16",
      rawLocation: "Saline, 67098 Bad Dürkheim",
      rawPayload: {
        city: "Bad Dürkheim",
        extraction: "ics",
        eventUrl: "https://example.test/event/bad-duerkheim"
      }
    });
  });

  it("keeps a DATE-TIME event's clock time and states no city when the page gives none", () => {
    const events = extractIcsEvents(calendar, { now: NOW });
    expect(events[1]).toMatchObject({
      rawName: "Landauer Street Food Festival",
      rawStartsAt: "2026-10-23T16:00:00",
      rawEndsAt: "2026-10-25T20:00:00",
      rawLocation: "Alter Messplatz Landau"
    });
    expect(events[1].rawPayload.city).toBeUndefined();
  });

  it("skips events that already ended and ignores a body that is not a calendar", () => {
    expect(extractIcsEvents(calendar, { now: NOW }).map((event) => event.rawName))
      .not.toContain("Fruehlingsfest 2026");
    expect(extractIcsEvents("<html><body>no calendar here</body></html>", { now: NOW })).toEqual([]);
  });

  it("renders a UTC stamp as the Europe/Berlin wall time the venue keeps", () => {
    const utc = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:utc-1",
      "SUMMARY:Abendmarkt",
      "DTSTART:20260814T160000Z",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
    expect(extractIcsEvents(utc, { now: NOW })[0].rawStartsAt).toBe("2026-08-14T18:00:00");
  });
});

describe("German heading and date list extractor", () => {
  it("reads the German date forms that appear on public event pages", () => {
    expect(parseGermanDate("Datum 03.02.2026 bis 15.04.2026")).toMatchObject({
      startsOn: "2026-02-03",
      endsOn: "2026-04-15"
    });
    expect(parseGermanDate("14.–16. August 2026")).toMatchObject({
      startsOn: "2026-08-14",
      endsOn: "2026-08-16"
    });
    expect(parseGermanDate("14. bis 16. August 2026")).toMatchObject({
      startsOn: "2026-08-14",
      endsOn: "2026-08-16"
    });
    expect(parseGermanDate("12. & 13. Dezember 2026")).toMatchObject({
      startsOn: "2026-12-12",
      endsOn: "2026-12-13"
    });
    expect(parseGermanDate("31. Juli bis 2. August 2026")).toMatchObject({
      startsOn: "2026-07-31",
      endsOn: "2026-08-02"
    });
    expect(parseGermanDate("Vom 31.07 bis zum 02.08.2026")).toMatchObject({
      startsOn: "2026-07-31",
      endsOn: "2026-08-02"
    });
    expect(parseGermanDate("01-08-2026 bis 03-08-2026")).toMatchObject({
      startsOn: "2026-08-01",
      endsOn: "2026-08-03"
    });
    expect(parseGermanDate("27. September 2026")).toMatchObject({
      startsOn: "2026-09-27",
      endsOn: "2026-09-27"
    });
    expect(parseGermanDate("03.-05.07.26 - Entlang der Bucht")).toMatchObject({
      startsOn: "2026-07-03",
      endsOn: "2026-07-05"
    });
    // A day-only row only resolves against a month heading the page printed.
    expect(parseGermanDate("03.09., Galerie am Kietz")).toBeUndefined();
    expect(parseGermanDate("03.09., Galerie am Kietz", { year: 2026 })).toMatchObject({
      startsOn: "2026-09-03",
      endsOn: "2026-09-03"
    });
    expect(parseGermanDate("Eintritt frei, Beginn 20 Uhr")).toBeUndefined();
  });

  it("pairs a date row with the nearest preceding heading and the city the page prints", () => {
    const html = `
      <h2>Wanderausstellung in Cottbus</h2>
      <p>Datum 07.09.2026 bis 01.10.2026</p>
      <p>Information BlechenCARR&Eacute;, 1. OG, Karl-Liebknecht-Stra&szlig;e 136, 03046 Cottbus</p>
      <h2>Altstadtfest</h2>
      <p>Datum 11.09.2026</p>
      <p>Uhrzeit 10:00 bis 17:00 Uhr Information Ein buntes Angebot</p>
      <h2>M&uuml;llroser Seezauber</h2>
      <p>Datum 12.09.2026</p>
      <p>Uhrzeit 14:00 bis 19:00 Uhr Information Ein buntes Programm</p>
    `;
    const events = extractGermanListEvents(html, {
      now: NOW,
      keyPrefix: "brandenburg-events",
      sourceUrl: "https://efre.brandenburg.de/"
    });
    // The later rows print no city anywhere near them, so they are dropped
    // rather than given the one address that appears elsewhere on the page.
    expect(events).toMatchObject([{
      rawName: "Wanderausstellung in Cottbus",
      rawLocation: "Cottbus",
      rawStartsAt: "2026-09-07",
      rawEndsAt: "2026-10-01",
      rawPayload: { cityEvidence: "postal_address", extraction: "german_list" }
    }]);
  });

  it("uses a scope city only when the page's own title states it", () => {
    const html = `
      <title>Volksfest 2026 | Volksfeste in Berlin</title>
      <h3>63. Berliner Volksfestsommer</h3><p>09.09.2026 - 02.10.2026</p>
      <h3>43. Weihnachtsmarkt City</h3><p>23.11.2026 - 03.01.2027</p>
    `;
    const scoped = extractGermanListEvents(html, {
      now: NOW,
      keyPrefix: "marktverband-berlin",
      cityScope: "Berlin",
      defaultEventType: "city_festival"
    });
    expect(scoped).toMatchObject([
      { rawName: "63. Berliner Volksfestsommer", rawLocation: "Berlin", rawPayload: { eventType: "city_festival", cityEvidence: "page_title_scope" } },
      { rawName: "43. Weihnachtsmarkt City", rawLocation: "Berlin", rawPayload: { eventType: "christmas" } }
    ]);
    expect(extractGermanListEvents(html, {
      now: NOW,
      keyPrefix: "marktverband-berlin",
      cityScope: "Hamburg"
    })).toEqual([]);
  });

  it("ignores lines without a date, label headings and rows that only state an end date", () => {
    const html = `
      <h3>Bewerbung</h3><p>Zulassungsantr&auml;ge sind bis 30.09.2026 einzureichen</p>
      <li>Alle Termine</li>
      <li>bis 15.10.2026, Rathausgalerie: Sonderausstellung</li>
      <li>Eintritt frei</li>
    `;
    expect(extractGermanListEvents(html, { now: NOW, keyPrefix: "test" })).toEqual([]);
  });

  it("carries a month heading down to the day-only rows underneath it", () => {
    const html = `
      <title>Jahreshöhepunkte | Stadt Schwedt/Oder</title>
      <p>September 2026</p>
      <li>13.09., Tag des offenen Denkmals</li>
      <li>19.09., 18. Gefecht um Landin, Schlosspark Hohenlandin, www.garde-landin.de</li>
    `;
    expect(extractGermanListEvents(html, {
      now: NOW,
      keyPrefix: "schwedt-annual-events",
      cityScope: "Schwedt/Oder"
    })).toMatchObject([
      { rawName: "Tag des offenen Denkmals", rawStartsAt: "2026-09-13", rawLocation: "Schwedt/Oder" },
      { rawName: "18. Gefecht um Landin, Schlosspark Hohenlandin", rawStartsAt: "2026-09-19" }
    ]);
  });

  it("takes the name in front of the date when the page labels it there", () => {
    const html = `
      <li>Lychen - Fl&ouml;&szlig;erfest: Vom 04.09 bis zum 06.09.2026, 17279 Lychen</li>
    `;
    expect(extractGermanListEvents(html, { now: NOW, keyPrefix: "test" })).toMatchObject([{
      rawName: "Lychen - Flößerfest",
      rawLocation: "Lychen",
      rawStartsAt: "2026-09-04",
      rawEndsAt: "2026-09-06"
    }]);
  });
});

describe("adapter routing", () => {
  it("routes a registered source to its strategy and unknown sources to nothing", () => {
    const html = `
      <title>Volksfest 2026 | Volksfeste in Berlin</title>
      <h3>Berliner Herbstrummel</h3><p>25.09.2026 - 25.10.2026</p>
    `;
    expect(extractAdapterEvents("marktverband-berlin", html, { now: NOW }))
      .toMatchObject([{ rawName: "Berliner Herbstrummel", rawLocation: "Berlin" }]);
    expect(extractAdapterEvents("not-registered", html, { now: NOW })).toEqual([]);
  });
});
