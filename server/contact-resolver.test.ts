/**
 * THE CONTACT RESOLVER'S SUITE.
 *
 * Every case here defends one of the four rules in the module header. The
 * negative cases matter more than the positive ones: the cheap way to raise the
 * named-contact count is to accept any capitalised pair of words and any email
 * on the page, and both would put a stranger's address on a decision page under
 * our name.
 *
 * Nothing here reaches the network — the fetcher is injected.
 */
import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot } from "./catalogue";
import { buildWeeklyReport } from "./report";
import {
  candidatePagesFor,
  DEFAULT_CONTACT_RESOLVER_CAP,
  emailBelongsToOrganizer,
  extractContacts,
  extractPersons,
  normalizeGermanPhone,
  parseContactResolverCap,
  runContactResolutionOn,
  selectResolutionTargets,
  type ContactQueryRunner,
  type ContactResolverTarget,
  type FetchedPage
} from "./contact-resolver";

const NOW = new Date("2026-07-27T09:00:00+02:00");

const IMPRESSUM = `
  Impressum Angaben gemäß § 5 TMG Stadtmarketing Musterstadt GmbH Friedrich-Ebert-Straße 12
  Vertreten durch: Andrea Weber Telefon: +49 30 000 1234 E-Mail: markt@example-potsdam.de
  Ansprechpartner für Beschicker: Herr Dr. Thomas Kranz
  Webdesign und Hosting: kontakt@example-agentur-berlin.de
`;

/* -------------------------------------------------------------- extraction */

describe("a name is a contact only next to a role", () => {
  it("takes the name that follows a published contact role, and stores the phrase", () => {
    const persons = extractPersons(IMPRESSUM);
    expect(persons.map((person) => person.name)).toEqual(["Thomas Kranz", "Andrea Weber"]);
    const ansprechpartner = persons.find((person) => person.role === "Ansprechpartner")!;
    expect(ansprechpartner.name).toBe("Thomas Kranz");
    expect(ansprechpartner.snippet).toContain("Ansprechpartner");
    expect(ansprechpartner.snippet).toContain("Thomas Kranz");
    expect(persons.find((person) => person.role === "Vertreten durch")!.name).toBe("Andrea Weber");
  });

  it("REJECTS a bare name, however prominent it is on the page", () => {
    // A sponsor, a photographer credit, a street named after someone. None of
    // these is a person who can accept an application.
    const persons = extractPersons(
      "Ein Fest für alle. Fotos: Maria Schneider. Gefördert durch Klaus Bergmann und Familie."
    );
    expect(persons).toEqual([]);
  });

  it("refuses a name that is merely the next sentence after the role word", () => {
    const persons = extractPersons(
      "Kontakt finden Sie unten auf der Seite. Der Marktplatz wird gesperrt."
    );
    expect(persons).toEqual([]);
  });
});

describe("only the organizer's own addresses are kept", () => {
  it("keeps the organizer domain and drops the web agency's mailbox", () => {
    const extracted = extractContacts(IMPRESSUM, { allowedHosts: ["www.example-potsdam.de"] });
    expect(extracted.emails).toEqual(["markt@example-potsdam.de"]);
    expect(extracted.rejectedEmails).toEqual(["kontakt@example-agentur-berlin.de"]);
  });

  it("accepts a subdomain of the organizer's host, and a parent of it", () => {
    expect(emailBelongsToOrganizer("markt@example-potsdam.de", ["veranstaltungen.example-potsdam.de"])).toBe(true);
    expect(emailBelongsToOrganizer("info@veranstaltungen.example-potsdam.de", ["example-potsdam.de"])).toBe(true);
    expect(emailBelongsToOrganizer("info@example-potsdam-events.de", ["example-potsdam.de"])).toBe(false);
  });

  it("stores one German phone shape, whatever the page printed", () => {
    expect(normalizeGermanPhone("+49 30 000 1234")).toBe("+49300001234");
    expect(normalizeGermanPhone("030 / 000-1234")).toBe("+49300001234");
    expect(normalizeGermanPhone("0049 (0)30 0001234")).toBe("+49300001234");
    // Not a phone number: a postal code, a house number, a year.
    expect(normalizeGermanPhone("014")).toBeUndefined();
  });
});

describe("the candidate pages", () => {
  it("tries the application page, the site root, then impressum and kontakt", () => {
    expect(
      candidatePagesFor({
        applicationUrl: "https://example-potsdam.de/markt/bewerbung",
        organizerWebsite: "https://example-potsdam.de"
      })
    ).toEqual([
      "https://example-potsdam.de/markt/bewerbung",
      "https://example-potsdam.de/",
      "https://example-potsdam.de/impressum",
      "https://example-potsdam.de/kontakt"
    ]);
  });

  it("never returns more than the per-event fetch ceiling, and ignores junk URLs", () => {
    expect(candidatePagesFor({ applicationUrl: "not a url" })).toEqual([]);
    expect(
      candidatePagesFor({ organizerWebsite: "https://example-halle.de/kultur" }).length
    ).toBeLessThanOrEqual(4);
  });
});

describe("the resolver's cap", () => {
  it("defaults to 30 events and refuses a non-numeric setting", () => {
    expect(parseContactResolverCap(undefined)).toBe(DEFAULT_CONTACT_RESOLVER_CAP);
    expect(parseContactResolverCap("12")).toBe(12);
    expect(() => parseContactResolverCap("lots")).toThrow(/whole number/i);
  });

  it("spends the cap on action-now first, and never exceeds it", () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const targets = selectResolutionTargets(report, 3);
    expect(targets).toHaveLength(3);
    expect(new Set(targets.map((target) => target.eventId)).size).toBe(3);
    // An event that already names a person is ordered last, so a small cap is
    // spent closing gaps rather than re-reading known routes.
    const known = targets.findIndex((target) => target.hasNamedPerson);
    if (known >= 0) {
      expect(targets.slice(known).every((target) => target.hasNamedPerson)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------ persistence */

interface FakeContact {
  id: string;
  organizerId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  sourceUrl: string;
}

function fakeClient(pages: Record<string, string>, options: { perEvent?: boolean } = {}) {
  const contacts: FakeContact[] = [];
  const checks: Array<{ url: string; outcome: string; finding: string }> = [];
  const fetched: string[] = [];
  const client: ContactQueryRunner & {
    contacts: FakeContact[];
    checks: typeof checks;
    fetched: string[];
  } = {
    contacts,
    checks,
    fetched,
    async query<T>(text: string, values: unknown[] = []) {
      if (text.includes("from events e")) {
        return {
          rows: [
            {
              id: `db-${values[1]}`,
              external_id: values[1],
              canonical_name: "Test Event",
              organizer_id: options.perEvent ? `org-${values[1]}` : "org-1",
              organizer_name: "Stadt Potsdam",
              organizer_website: options.perEvent
                ? `https://${values[1]}.example-potsdam.de`
                : "https://example-potsdam.de",
              application_url: options.perEvent
                ? null
                : "https://example-potsdam.de/markt/bewerbung"
            }
          ] as unknown as T[],
          rowCount: 1
        };
      }
      if (text.includes("select id from organizer_contacts")) {
        const hit = contacts.find(
          (contact) =>
            contact.organizerId === values[0] &&
            (contact.email ?? "") === ((values[1] as string | null) ?? "") &&
            (contact.phone ?? "") === ((values[2] as string | null) ?? "")
        );
        return { rows: (hit ? [{ id: hit.id }] : []) as unknown as T[], rowCount: hit ? 1 : 0 };
      }
      if (text.includes("insert into organizer_contacts")) {
        contacts.push({
          id: `contact-${contacts.length + 1}`,
          organizerId: values[0] as string,
          name: (values[1] as string) ?? null,
          email: (values[3] as string) ?? null,
          phone: (values[4] as string) ?? null,
          sourceUrl: values[5] as string
        });
        return { rows: [] as unknown as T[], rowCount: 1 };
      }
      if (text.includes("update organizer_contacts")) {
        const row = contacts.find((contact) => contact.id === values[0]);
        if (row) {
          row.name = (values[1] as string) ?? row.name;
          row.sourceUrl = values[3] as string;
        }
        return { rows: [] as unknown as T[], rowCount: 1 };
      }
      if (text.includes("insert into organizer_contact_checks")) {
        checks.push({
          url: values[2] as string,
          outcome: values[4] as string,
          finding: values[5] as string
        });
        return { rows: [] as unknown as T[], rowCount: 1 };
      }
      return { rows: [] as unknown as T[], rowCount: 0 };
    }
  };
  const fetchPage = async (url: string): Promise<FetchedPage> => {
    fetched.push(url);
    const body = pages[url];
    if (body === undefined) throw new Error(`Public page returned HTTP 404.`);
    return { text: body, finalUrl: url };
  };
  return { client, fetchPage };
}

function target(eventId: string): ContactResolverTarget {
  return {
    eventId,
    eventName: `Event ${eventId}`,
    reason: "action_now",
    applicationUrl: "https://example-potsdam.de/markt/bewerbung",
    hasNamedPerson: false
  };
}

describe("the resolution run", () => {
  const pages = {
    "https://example-potsdam.de/markt/bewerbung": "Bewerbungen bitte online einreichen.",
    "https://example-potsdam.de/": "Willkommen in Potsdam.",
    "https://example-potsdam.de/impressum": IMPRESSUM
  };

  it("receipts a page that publishes nothing, instead of staying silent about it", async () => {
    const { client, fetchPage } = fakeClient({
      "https://example-potsdam.de/markt/bewerbung": "Bewerbungen bitte online einreichen.",
      "https://example-potsdam.de/": "Willkommen in Potsdam."
    });
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1")],
      fetchPage,
      now: () => NOW
    });

    expect(receipt.eventsTargeted).toBe(1);
    expect(receipt.noContactPages).toBe(2);
    expect(receipt.contactsFound).toEqual({ named: 0, emails: 0, phones: 0 });
    expect(client.contacts).toHaveLength(0);
    expect(client.checks.filter((check) => check.outcome === "no_contact")[0].finding).toBe(
      "No public contact found on https://example-potsdam.de/markt/bewerbung"
    );
  });

  it("walks on to the impressum when the earlier pages publish nothing", async () => {
    // The application page and the site root are the two candidates LEAST
    // likely to publish a contact. A page that yields nothing costs a fetch,
    // never the per-event allowance, so the impressum is still reached.
    const { client, fetchPage } = fakeClient(pages);
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1")],
      fetchPage,
      now: () => NOW
    });

    expect(client.fetched).toEqual([
      "https://example-potsdam.de/markt/bewerbung",
      "https://example-potsdam.de/",
      "https://example-potsdam.de/impressum",
      "https://example-potsdam.de/kontakt"
    ]);
    expect(receipt.noContactPages).toBe(2);
    expect(client.contacts).toHaveLength(1);
    expect(client.contacts[0].name).toBe("Thomas Kranz");
  });

  it("reads the impressum when the earlier candidates do not resolve", async () => {
    const { client, fetchPage } = fakeClient({
      "https://example-potsdam.de/impressum": IMPRESSUM
    });
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1")],
      fetchPage,
      now: () => NOW
    });

    expect(receipt.contactsFound).toEqual({ named: 1, emails: 1, phones: 1 });
    expect(client.contacts).toHaveLength(1);
    expect(client.contacts[0]).toMatchObject({
      name: "Thomas Kranz",
      email: "markt@example-potsdam.de",
      phone: "+49300001234",
      sourceUrl: "https://example-potsdam.de/impressum"
    });
    // Every dead candidate is receipted as a failure, not silently dropped —
    // and the walk stops at the fourth candidate, never a fifth.
    expect(receipt.failures.map((failure) => failure.url)).toEqual([
      "https://example-potsdam.de/markt/bewerbung",
      "https://example-potsdam.de/",
      "https://example-potsdam.de/kontakt"
    ]);
    expect(receipt.failures[0].error).toMatch(/404/);
    expect(client.checks.filter((check) => check.outcome === "fetch_failed")).toHaveLength(3);
  });

  it("is idempotent: a second run refreshes the row instead of adding one", async () => {
    const options = { targets: [target("event-1")], now: () => NOW };
    const { client, fetchPage } = fakeClient({ "https://example-potsdam.de/impressum": IMPRESSUM });
    await runContactResolutionOn(client, { ...options, fetchPage });
    expect(client.contacts).toHaveLength(1);
    await runContactResolutionOn(client, { ...options, fetchPage });
    expect(client.contacts).toHaveLength(1);
    expect(client.contacts[0].name).toBe("Thomas Kranz");
  });

  it("stops at the per-run fetch budget, however many events are targeted", async () => {
    const { client, fetchPage } = fakeClient({}, { perEvent: true });
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1"), target("event-2"), target("event-3")],
      fetchPage,
      fetchBudget: 3,
      now: () => NOW
    });
    expect(receipt.pagesFetched).toBe(3);
    expect(client.fetched).toHaveLength(3);
  });

  it("reads a shared organizer page ONCE, however many of its events are targeted", async () => {
    // German operators run dozens of events off one site. Re-fetching the same
    // impressum per event would spend the whole budget on four pages.
    const { client, fetchPage } = fakeClient(pages);
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1"), target("event-2"), target("event-3")],
      fetchPage,
      now: () => NOW
    });
    expect(receipt.eventsTargeted).toBe(3);
    // Four candidate pages, read once — not four per event.
    expect(receipt.pagesFetched).toBe(4);
    expect(client.fetched).toHaveLength(4);
    expect(new Set(client.fetched).size).toBe(4);
  });

  it("never reads more than two resolving pages for one event", async () => {
    const { client, fetchPage } = fakeClient({
      "https://example-potsdam.de/markt/bewerbung": IMPRESSUM,
      "https://example-potsdam.de/": IMPRESSUM,
      "https://example-potsdam.de/impressum": IMPRESSUM,
      "https://example-potsdam.de/kontakt": IMPRESSUM
    });
    const receipt = await runContactResolutionOn(client, {
      targets: [target("event-1")],
      fetchPage,
      now: () => NOW
    });
    expect(receipt.pagesFetched).toBe(2);
    expect(client.fetched).toEqual([
      "https://example-potsdam.de/markt/bewerbung",
      "https://example-potsdam.de/"
    ]);
  });
});

describe("what an opening-hours line is not", () => {
  it("refuses a weekday pair standing where a name would stand", () => {
    expect(
      extractPersons("Kontakt und Anfahrt Öffnungszeiten: Montag Freitag 9 bis 16 Uhr")
    ).toEqual([]);
  });

  it("refuses a company line standing where a name would stand", () => {
    expect(extractPersons("Vertreten durch: Stadt Potsdam GmbH")).toEqual([]);
  });
});

/* ============================ the two defects the live corpus actually had */

describe("regressions measured on the live corpus, 2026-09-15", () => {
  it("refuses a bare heading followed by the next navigation item", () => {
    // Every one of these was WRITTEN AS A PERSON by the first version.
    [
      "Kontakt Mehr More child Foodtruck-Direkbewerbung",
      "Kontakt Termine Fr. 18 Food Truck Festival Neutraubling 2026",
      "Kontakt Kontaktformular Bürgermeldung Sicheres Kontaktformular",
      "Ansprechpartner Dienstleistung Sortiment Firmenadresse Rechnungsadresse",
      "Kontakt Alte PoststraÃe 16, 10115 Berlin"
    ].forEach((line) => expect(extractPersons(line)).toEqual([]));
  });

  it("still takes the name when the page punctuates the role as a label", () => {
    expect(extractPersons("Ansprechpartner: Martin Keller Foodtruck-Partnerbetreuung")[0]).toMatchObject({
      name: "Martin Keller",
      role: "Ansprechpartner"
    });
    expect(
      extractPersons("Vertreten durch die Geschäftsführer: Henrik Brandt David Neumann")[0]
    ).toMatchObject({ name: "Henrik Brandt" });
    expect(extractPersons("Ansprechpartner Frau Andrea Weber")[0]).toMatchObject({
      name: "Andrea Weber"
    });
  });

  it("refuses a company name whose capital letter truncated it into a person", () => {
    // "Kontakt: Musterfest GmbH" was stored as the person "Musterfest Gmb".
    expect(extractPersons("Kontakt: Musterfest GmbH Osnabrück")).toEqual([]);
    expect(extractPersons("Vertreten durch: Beispiel Events GmbH")).toEqual([]);
  });

  it("refuses a date run that merely looks like a phone number", () => {
    // "+496202720062027" and "+49204102026" were both stored by the first
    // version, out of event listings reading "20.4.2026 | 2027".
    const dates = "Termine 20.4.2026 | 2027 und 06.2027 2006 2027";
    expect(extractContacts(dates, { allowedHosts: [] }).phones).toEqual([]);
  });

  it("keeps a number that carries its country code or its own marker", () => {
    expect(extractContacts("Telefon: +49 (0) 30 - 00000770", { allowedHosts: [] }).phones).toEqual([
      "+493000000770"
    ]);
    expect(extractContacts("📞 01520 0000003", { allowedHosts: [] }).phones).toEqual([
      "+4915200000003"
    ]);
    expect(extractContacts("Tel. 030 000 1234", { allowedHosts: [] }).phones).toEqual([
      "+49300001234"
    ]);
  });
});
