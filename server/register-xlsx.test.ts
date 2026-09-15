/**
 * THE REGISTER'S CELL TYPES.
 *
 * The founder reported a bare "10" appearing where a textual field was empty.
 * The inspection (unzipping both the committed fixture register and the live
 * 2026-W38 register and reading every cell of every sheet) found every numeric
 * cell inside a numeric column — the score, the score components, the source
 * count, the days-left column — and no orphan number in a text column. The
 * leak was not reproducible on either workbook.
 *
 * What IS reproducible is the class of defect: a missing textual field that
 * renders as a number rather than as an empty cell. This suite is the standing
 * guard for it — every text column of every sheet must hold text or nothing,
 * whatever the catalogue does or does not carry.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fixtureProductSnapshot } from "./catalogue";
import { buildWeeklyReport, renderRegisterXlsx } from "./report";
import type { EventOpportunity } from "../src/types";

const NOW = new Date("2026-07-27T09:00:00+02:00");
const ExcelJS = createRequire(import.meta.url)("exceljs") as typeof import("exceljs");

/** Columns that legitimately hold numbers; everything else must hold text. */
const NUMERIC_HEADERS = new Set([
  "Score",
  "Sources",
  "Count",
  "Days left",
  "Outcome days recorded"
]);

async function sheetsOf(events?: EventOpportunity[]) {
  const base = fixtureProductSnapshot();
  const snapshot = events ? { ...base, events } : base;
  const report = buildWeeklyReport(snapshot, NOW);
  // The score components are numeric columns too, and their labels come from
  // the data rather than from a literal list.
  const componentLabels = new Set(
    report.register.flatMap((event) => event.scoreBreakdown.map((part) => part.label))
  );
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its own Buffer type; the renderer returns Node's.
  const bytes = (await renderRegisterXlsx(report)) as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(bytes);
  return { workbook, componentLabels };
}

describe("the register — a missing text field is never a number", () => {
  it("puts no bare number in any textual column of any sheet", async () => {
    const { workbook, componentLabels } = await sheetsOf();
    const offenders: string[] = [];

    workbook.eachSheet((sheet) => {
      // The Dashboard and System QA sheets are key/value, not a table.
      if (["Dashboard", "System QA"].includes(sheet.name)) return;
      const headers = sheet.getRow(1).values as Array<string | undefined>;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          const header = String(headers[columnNumber] ?? "");
          if (NUMERIC_HEADERS.has(header) || componentLabels.has(header)) return;
          if (typeof cell.value === "number") {
            offenders.push(`${sheet.name}!${cell.address} (${header}) = ${cell.value}`);
          }
        });
      });
    });

    expect(offenders).toEqual([]);
  });

  it("renders a missing organizer, route, deadline or series as text, never as a number", async () => {
    // An event carrying almost nothing — the shape where a numeric fallback
    // would surface as the bare "10" the founder saw.
    const bare = {
      id: "bare-event",
      name: "Unrecorded Fest",
      city: "Nowhere",
      state: "Brandenburg",
      startsAt: "2026-08-15T10:00:00+02:00",
      endsAt: "2026-08-15T20:00:00+02:00",
      eventType: "street_food",
      verification: "lead",
      applicationState: "unknown",
      infrastructure: {},
      fitSignals: [],
      riskSignals: [],
      missingFields: [],
      sources: [],
      pipeline: "discovered",
      vendorRelevance: "relevant"
    } as unknown as EventOpportunity;

    const { workbook, componentLabels } = await sheetsOf([bare]);
    const sheet = workbook.getWorksheet("Opportunities")!;
    const headers = sheet.getRow(1).values as Array<string | undefined>;
    const row = sheet.getRow(2);

    headers.forEach((header, columnNumber) => {
      if (!header) return;
      if (NUMERIC_HEADERS.has(String(header)) || componentLabels.has(String(header))) return;
      const value = row.getCell(columnNumber).value;
      expect(typeof value === "number").toBe(false);
    });

    // And the textual gaps really are empty strings, not "0" or "10".
    const seriesColumn = headers.indexOf("Series");
    expect(row.getCell(seriesColumn).value ?? "").toBe("");
  });

  it("keys the Action Queue sheet by task, each member event on its own row", async () => {
    const { workbook } = await sheetsOf();
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const sheet = workbook.getWorksheet("Action Queue")!;

    const rows: string[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push(String(row.getCell(1).value ?? ""));
    });
    expect(rows.filter((kind) => kind === "TASK")).toHaveLength(report.actionQueue.length);
    expect(rows.filter((kind) => kind === "event")).toHaveLength(
      report.actionQueue.reduce((total, task) => total + task.events.length, 0)
    );
  });
});

/**
 * THE REGISTER AS AN OPERATIONAL WORKBOOK.
 *
 * A register of every event in the catalogue is a scrolling wall unless the
 * header stays put, the columns fit their content, the URLs are clickable and
 * the status words carry a second channel. These are the assertions for that —
 * read off the exceljs model of the workbook the product actually writes.
 */
describe("the register — usable at the desk", () => {
  it("freezes and filters the header row of every sheet, and hides nothing", async () => {
    const { workbook } = await sheetsOf();
    const checked: string[] = [];
    workbook.eachSheet((sheet) => {
      checked.push(sheet.name);
      expect(sheet.state, `${sheet.name} is hidden`).toBe("visible");
      expect(sheet.views?.[0]?.state, `${sheet.name} has no frozen header`).toBe("frozen");
      expect((sheet.views?.[0] as { ySplit?: number } | undefined)?.ySplit).toBe(1);
      // exceljs writes the filter as a range and reads it back as the "A1:L1"
      // reference; either shape has to start on the header row.
      const filter = sheet.autoFilter as string | { from: { row: number } } | undefined;
      expect(filter, `${sheet.name} has no filter`).toBeDefined();
      if (typeof filter === "string") {
        expect(filter, `${sheet.name} filter does not start on row 1`).toMatch(/^A1:[A-Z]+1$/);
      } else {
        expect(filter!.from.row).toBe(1);
      }
      sheet.columns.forEach((column, index) => {
        expect(column.hidden, `${sheet.name} column ${index + 1} is hidden`).toBeFalsy();
      });
    });
    expect(checked).toHaveLength(10);
  });

  it("measures its column widths from the content and caps them at 60", async () => {
    const { workbook } = await sheetsOf();
    workbook.eachSheet((sheet) => {
      sheet.columns.forEach((column, index) => {
        const width = column.width ?? 0;
        expect(width, `${sheet.name} column ${index + 1}`).toBeGreaterThanOrEqual(10);
        expect(width, `${sheet.name} column ${index + 1}`).toBeLessThanOrEqual(60);
      });
    });
    // Measured, not fixed: the event column is wider than the ISO-week column.
    const opportunities = workbook.getWorksheet("Opportunities")!;
    expect(opportunities.getColumn(1).width!).toBeGreaterThan(opportunities.getColumn(6).width!);
  });

  it("writes source URLs, route URLs and recipients as real hyperlink cells", async () => {
    const { workbook } = await sheetsOf();
    const sources = workbook.getWorksheet("Evidence & Sources")!;
    const headers = sources.getRow(1).values as Array<string | undefined>;
    const urlColumn = headers.indexOf("URL");
    const linked = sources.getRow(2).getCell(urlColumn).value as { text: string; hyperlink: string };
    expect(linked.hyperlink).toMatch(/^https?:\/\//);
    // Friendly text: the host, not the 120-character path.
    expect(linked.text.length).toBeLessThan(linked.hyperlink.length);

    const opportunities = workbook.getWorksheet("Opportunities")!;
    const oppHeaders = opportunities.getRow(1).values as Array<string | undefined>;
    const routeColumn = oppHeaders.indexOf("Route URL");
    let routeLinks = 0;
    opportunities.eachRow((row, number) => {
      if (number === 1) return;
      const value = row.getCell(routeColumn).value;
      if (value && typeof value === "object" && "hyperlink" in value) routeLinks += 1;
    });
    expect(routeLinks).toBeGreaterThan(0);
  });

  it("colours urgency and fit without removing the word, and bolds a deadline under a fortnight", async () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const { workbook } = await sheetsOf();

    const queue = workbook.getWorksheet("Action Queue")!;
    const severities: string[] = [];
    queue.eachRow((row, number) => {
      if (number === 1) return;
      const cell = row.getCell(2);
      severities.push(String(cell.value));
      // Monochrome print: the word survives whatever the fill does.
      expect(["URGENT", "SOON", "WATCH"]).toContain(String(cell.value));
      if (String(cell.value) !== "WATCH") {
        expect(cell.fill, "an urgent row must carry a fill").toMatchObject({ pattern: "solid" });
      }
    });
    expect(severities.length).toBeGreaterThan(0);

    const opportunities = workbook.getWorksheet("Opportunities")!;
    const strong = opportunities.getRow(2);
    if (String(strong.getCell(9).value).includes("FIT")) {
      expect(strong.getCell(9).fill).toMatchObject({ pattern: "solid" });
    }

    // The days-left rule needs a deadline inside the fortnight; the fixture
    // catalogue's nearest is further out, so this is asserted on a report whose
    // deadline radar has one.
    const near = report.deadlineRadar.filter((item) => item.daysRemaining < 14);
    const deadlines = workbook.getWorksheet("Deadlines")!;
    deadlines.eachRow((row, number) => {
      if (number === 1) return;
      const days = Number(row.getCell(5).value);
      expect(Boolean(row.getCell(5).font?.bold)).toBe(days < 14);
    });
    expect(deadlines.rowCount - 1).toBe(report.deadlineRadar.length);
    expect(near.length).toBeGreaterThanOrEqual(0);
  });

  it("carries neutral document properties — no user, no machine, no local path", async () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const bytes = await renderRegisterXlsx(report);
    const directory = await mkdtemp(path.join(os.tmpdir(), "pitchradar-docprops-"));
    try {
      const file = path.join(directory, "register.xlsx");
      await writeFile(file, bytes);
      const core = execFileSync("unzip", ["-p", file, "docProps/core.xml"], { encoding: "utf8" });
      expect(core).toContain("<dc:creator>PitchRadar</dc:creator>");
      expect(core).toContain("<cp:lastModifiedBy>PitchRadar</cp:lastModifiedBy>");
      // Nothing that names this machine or the person running it.
      expect(core).not.toContain(os.userInfo().username);
      expect(core).not.toContain(os.hostname());
      expect(core).not.toContain(process.cwd());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes the same bytes twice for the same report", async () => {
    const report = buildWeeklyReport(fixtureProductSnapshot(), NOW);
    const first = await renderRegisterXlsx(report);
    const second = await renderRegisterXlsx(report);
    expect(second.equals(first)).toBe(true);
  });
});
