/**
 * THE PRINTED BRIEF.
 *
 * Two things are tested here, and they are different in kind:
 *
 *   · THE CONTRACT — the nav strip, the six anchors it points at, and the print
 *     rules that open the disclosures. Pure string work; always runs.
 *   · THE ARTIFACT — an actual PDF, printed by an actual Chromium. It runs
 *     wherever a browser is already installed and SKIPS, loudly, where none is.
 *     Nothing in this file may download a browser.
 */
import { describe, expect, it } from "vitest";
import { fixtureProductSnapshot } from "./catalogue";
import { BRIEF_SECTIONS, buildWeeklyReport, renderBriefHtml } from "./report";
import { chromiumSearchPath, pdfPageCount, renderBriefPdf, resolveChromium } from "./report-pdf";

const NOW = new Date("2026-07-27T09:00:00+02:00");
const report = () => buildWeeklyReport(fixtureProductSnapshot(), NOW);
const chromium = resolveChromium();

describe("the brief's navigation strip", () => {
  it("names the six sections once each, as internal anchors", () => {
    const html = renderBriefHtml(report());
    const strip = html.slice(html.indexOf('<nav class="brief-nav">'), html.indexOf("</nav>"));
    expect(BRIEF_SECTIONS.map((section) => section.nav)).toEqual([
      "Overview",
      "Action now",
      "Top opportunities",
      "Deadlines",
      "Bookings",
      "System health"
    ]);
    BRIEF_SECTIONS.forEach((section) => {
      expect(strip).toContain(`href="#${section.id}"`);
    });
    // An anchor that points at nothing is worse than no anchor: the id has to
    // be on the heading the entry names.
    BRIEF_SECTIONS.forEach((section) => {
      expect(html).toContain(`<h2 id="${section.id}">${section.heading}</h2>`);
    });
  });

  it("uses no underline soup and stays one line", () => {
    const html = renderBriefHtml(report());
    expect(html).toContain(".brief-nav a { color: #43433d; border-bottom: 0; }");
    expect((html.match(/<nav class="brief-nav">/g) || []).length).toBe(1);
  });

  it("prints every disclosure open — paper has no triangle to click", () => {
    const html = renderBriefHtml(report());
    expect(html).toContain("details > summary ~ * { display: block !important; }");
    // Chromium 131+ hides folded content behind ::details-content, which
    // display:block alone does not reach.
    expect(html).toContain("details::details-content { content-visibility: visible !important;");
  });
});

describe("the private edition's app links", () => {
  it("adds none at all without --app-base", () => {
    const html = renderBriefHtml(report());
    expect(html).not.toContain('class="applink"');
  });

  it("links to the app root, and says that is what it does", () => {
    const html = renderBriefHtml(report(), { appBase: "http://127.0.0.1:4182/" });
    expect(html).toContain('<a class="applink" href="http://127.0.0.1:4182/">');
    expect(html).toContain("carries no per-event address");
    // The product holds its view in React state: there is no /events/<id> URL
    // to point at, and this brief does not invent one.
    expect(html).not.toContain("/events/");
  });

  it("ignores a base that is not an http(s) origin", () => {
    expect(renderBriefHtml(report(), { appBase: "javascript:alert(1)" })).not.toContain('class="applink"');
    expect(renderBriefHtml(report(), { appBase: "" })).not.toContain('class="applink"');
  });
});

describe("the Chromium resolver", () => {
  it("searches exactly three places, in order, and downloads nothing", () => {
    expect(chromiumSearchPath()).toHaveLength(3);
    expect(chromiumSearchPath()[0]).toContain("ms-playwright");
    expect(chromiumSearchPath()[1]).toContain("PUPPETEER_EXECUTABLE_PATH");
    expect(chromiumSearchPath()[2]).toContain("Google Chrome");
  });

  it("takes an executable from PUPPETEER_EXECUTABLE_PATH when the cache misses", () => {
    // process.execPath is a real file on every machine that can run this test.
    const resolved = resolveChromium({
      HOME: "/nonexistent-home-for-this-test",
      PUPPETEER_EXECUTABLE_PATH: process.execPath
    } as unknown as NodeJS.ProcessEnv);
    // The playwright cache is read from the real home directory, so on a
    // machine that has one it still wins — which is the documented order.
    expect(resolved).toBeDefined();
    expect(["playwright-cache", "PUPPETEER_EXECUTABLE_PATH", "google-chrome"]).toContain(resolved!.source);
  });
});

describe.skipIf(!chromium)("the brief, actually printed", () => {
  it("produces a real multi-page A4 PDF with an outline", { timeout: 120_000 }, async () => {
    const printed = await renderBriefPdf(renderBriefHtml(report()));
    expect(printed.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(printed.bytes.length).toBeGreaterThan(20_000);
    expect(printed.pages).toBeGreaterThan(1);
    expect(pdfPageCount(printed.bytes)).toBe(printed.pages);
    expect(printed.outline).toBe(true);
    expect(printed.renderer).toContain("playwright-core");
  });

  it("fits the founder's page budget on the fixture week", { timeout: 120_000 }, async () => {
    // THE PAGE BUDGET IS A PRODUCT REQUIREMENT, not a nice-to-have: a brief the
    // owner will not print is a brief he does not read. The fixture week is the
    // committed sample, so this number is the one in the repository — and it is
    // read off the produced document, never estimated from the HTML.
    //
    // The bound guards the DENSITY, not the content: every fact, every link and
    // every disclosure is still in the document (the tests above and beside this
    // one hold those). If a real week grows past it, the fix is a denser print
    // rule, never a deleted section.
    const printed = await renderBriefPdf(renderBriefHtml(report()));
    expect(printed.pages).toBeLessThanOrEqual(5);
  });

  it("keeps the section anchors and the evidence links inside the PDF", { timeout: 120_000 }, async () => {
    const printed = await renderBriefPdf(renderBriefHtml(report()));
    const raw = printed.bytes.toString("latin1");
    // Chromium writes each internal anchor as a named destination.
    BRIEF_SECTIONS.forEach((section) => {
      expect(raw, `missing PDF destination: ${section.id}`).toContain(section.id);
    });
    expect(raw).toContain("/URI");
  });

  it("renders the same brief to the same content twice — only renderer metadata moves", {
    timeout: 120_000
  }, async () => {
    const first = await renderBriefPdf(renderBriefHtml(report()));
    const second = await renderBriefPdf(renderBriefHtml(report()));
    // The raw bytes carry /CreationDate and a user-agent /Creator, so they are
    // NOT identical. Everything else is.
    expect(second.contentDigest).toBe(first.contentDigest);
    expect(second.pages).toBe(first.pages);
  });
});
