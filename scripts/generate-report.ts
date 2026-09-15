/**
 * PitchRadar weekly report generator.
 *
 *   npm run report -- --now=2026-07-27T09:00:00+02:00 --out=reports
 *
 * Loads the catalogue (PostgreSQL when configured, otherwise the committed
 * fixture snapshot — which one is used is printed, never guessed), builds the
 * report for the ISO week containing `--now`, and writes TWO artifacts:
 *
 *   pitchradar-brief-<week>.html     the owner's decision brief
 *   pitchradar-register-<week>.xlsx  the operational workbook, evidence included
 *   manifest.json                    what this set is and where it came from
 *
 * and, with --pdf, a fourth: pitchradar-brief-<week>.pdf, the same brief printed
 * by a Chromium that is ALREADY on the machine. Nothing is ever downloaded.
 *
 * --app-base=<url> is the PRIVATE edition switch: it adds links back into the
 * running product. Without it no artifact carries an app link, which is what
 * makes the committed sample publishable.
 *
 * There is no third file: the evidence that used to sit in its own HTML page is
 * inside the workbook, on the "Evidence & Sources" sheet, where it can be
 * sorted and searched instead of scrolled.
 *
 * Nothing here reaches the network, and no clock other than `--now` is read, so
 * the same snapshot and the same `--now` produce byte-identical HTML.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureProductSnapshot, loadProductSnapshot } from "../server/catalogue";
import { databaseConfigured } from "../server/database";
import { buildWeeklyReport, renderBriefHtml, renderRegisterXlsx } from "../server/report";
import { ChromiumNotFoundError, renderBriefPdf } from "../server/report-pdf";

/** The commit the artifacts were generated from, or "unknown" — never a guess. */
function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function main() {
  const nowArg = argValue("now");
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a valid ISO timestamp: ${nowArg}`);
    process.exitCode = 1;
    return;
  }
  if (!nowArg) {
    console.log("No --now given; using the machine clock. Pass --now=<ISO> for a reproducible artifact.");
  }

  const outDir = path.resolve(process.cwd(), argValue("out") ?? "reports");

  // --fixtures forces the committed fixture catalogue even where a database is
  // configured. That is how the committed sample is produced, so the artifact
  // in the repository never depends on one machine's local database.
  const forceFixtures = process.argv.slice(2).includes("--fixtures");
  const usingDatabase = databaseConfigured() && !forceFixtures;
  console.log(
    usingDatabase
      ? "Catalogue: PostgreSQL (PITCHRADAR_DATABASE_URL is configured)."
      : forceFixtures
        ? `Catalogue: committed fixture snapshot (--fixtures given; ${
            databaseConfigured() ? "the configured database is ignored" : "no database is configured either"
          }).`
        : "Catalogue: committed fixture snapshot (no database configured)."
  );
  const snapshot = usingDatabase ? await loadProductSnapshot() : fixtureProductSnapshot();
  console.log(`Catalogue reported mode: ${snapshot.mode}.`);

  const report = buildWeeklyReport(snapshot, now);
  const targetDir = path.join(outDir, report.isoWeek);
  await mkdir(targetDir, { recursive: true });

  const briefPath = path.join(targetDir, `pitchradar-brief-${report.isoWeek}.html`);
  const registerPath = path.join(targetDir, `pitchradar-register-${report.isoWeek}.xlsx`);

  const appBase = argValue("app-base");
  await writeFile(briefPath, renderBriefHtml(report, { appBase }), "utf8");
  await writeFile(registerPath, await renderRegisterXlsx(report));

  // The manifest travels WITH the artifacts: the product's reports view reads
  // its origin from here rather than inferring it from a file's timestamp.
  const manifestPath = path.join(targetDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        isoWeek: report.isoWeek,
        generatedAt: report.generatedAt,
        now: now.toISOString(),
        mode: snapshot.mode,
        snapshotCounts: { events: snapshot.events.length, sources: snapshot.sources.length },
        gitSha: gitSha()
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  let pdfLine = "";
  if (process.argv.slice(2).includes("--pdf")) {
    const pdfPath = path.join(targetDir, `pitchradar-brief-${report.isoWeek}.pdf`);
    try {
      const printed = await renderBriefPdf(renderBriefHtml(report, { appBase }));
      await writeFile(pdfPath, printed.bytes);
      pdfLine =
        `PDF:      ${pdfPath}\n` +
        `          ${printed.pages} A4 page(s) · ${Math.round(printed.bytes.length / 1024)} KB · ` +
        `renderer ${printed.renderer} · outline ${printed.outline ? "present" : "absent"}`;
    } catch (error) {
      if (error instanceof ChromiumNotFoundError) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  console.log(`Week ${report.isoWeek} (${report.weekRangeLabel}) · generated ${report.generatedAtLabel}`);
  console.log(report.summarySentence);
  console.log(
    `Brief: ${report.actionQueue.length} task card(s) covering ${report.actionNow.length} event(s) · ` +
      `${report.topOpportunities.length} opportunity card(s) · ` +
      `${report.radarSeries.length} radar row(s) over ${report.radar.length} event(s) · ` +
      `${report.deadlineRadar.length} deadline(s) · ` +
      `${report.drafts.length} draft(s) indexed`
  );
  console.log(`Register: ${report.register.length} events, every non-irrelevant event in the snapshot.`);
  console.log(`BRIEF:    ${briefPath}`);
  console.log(`REGISTER: ${registerPath}`);
  console.log(`MANIFEST: ${manifestPath}`);
  if (pdfLine) console.log(pdfLine);
  if (appBase) console.log(`Private edition: app links point at ${appBase}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // The catalogue module opens a PostgreSQL pool whenever one is configured and
  // that pool keeps the event loop alive. The artifacts are already flushed to
  // disk by the time we get here, so ending the process is safe.
  .finally(() => process.exit(process.exitCode ?? 0));
