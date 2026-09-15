/**
 * THE BRIEF, PRINTED.
 *
 * The weekly brief is already a print document — A4, a page box, print CSS that
 * opens every disclosure. This module hands that HTML to a Chromium that is
 * ALREADY on the machine and takes the PDF back.
 *
 * Two rules govern the whole file:
 *
 *   1. NOTHING IS EVER DOWNLOADED. A report generator that fetches a 150 MB
 *      browser the first time it runs is a report generator that fails in the
 *      one place it matters. If no Chromium is resolvable we say exactly which
 *      three places were searched and stop.
 *   2. THE PAGE COUNT IS READ OFF THE ARTIFACT. Not estimated from the HTML —
 *      counted in the PDF that was actually produced.
 *
 * The PDF is NOT byte-identical across runs even for the same HTML: Chromium
 * stamps /CreationDate, /ModDate and a /Creator user-agent into the document.
 * That is renderer metadata, not content; the HTML beside it is byte-identical,
 * and `pdfContentDigest` below measures how much of the PDF actually moves.
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ChromiumResolution {
  executablePath: string;
  /** Which of the three searched places this came from. */
  source: "playwright-cache" | "PUPPETEER_EXECUTABLE_PATH" | "google-chrome";
  label: string;
}

/** The three places, in the order they are searched. Nothing else is tried. */
export function chromiumSearchPath(): string[] {
  return [
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    "PUPPETEER_EXECUTABLE_PATH (environment)",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
}

/** The executables a playwright browser directory can hold, per platform. */
function playwrightCandidates(browserDir: string): string[] {
  return [
    path.join(browserDir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    path.join(browserDir, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    path.join(browserDir, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    path.join(browserDir, "chrome-headless-shell-mac/chrome-headless-shell"),
    path.join(browserDir, "chrome-linux/chrome"),
    path.join(browserDir, "chrome-headless-shell-linux/chrome-headless-shell"),
    path.join(browserDir, "chrome-win/chrome.exe")
  ];
}

/**
 * Resolves a browser WITHOUT installing one. The playwright cache is searched
 * first and its highest build wins, so a machine holding three revisions does
 * not print with the oldest one.
 */
export function resolveChromium(env: NodeJS.ProcessEnv = process.env): ChromiumResolution | undefined {
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((entry) => /^chromium(_headless_shell)?-\d+$/.test(entry))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      for (const candidate of playwrightCandidates(path.join(cache, build))) {
        if (existsSync(candidate)) {
          return {
            executablePath: candidate,
            source: "playwright-cache",
            label: `playwright cache · ${build}`
          };
        }
      }
    }
  }

  const fromEnv = (env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  if (fromEnv && existsSync(fromEnv)) {
    return {
      executablePath: fromEnv,
      source: "PUPPETEER_EXECUTABLE_PATH",
      label: "PUPPETEER_EXECUTABLE_PATH"
    };
  }

  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) {
    return { executablePath: chrome, source: "google-chrome", label: "Google Chrome (installed)" };
  }
  return undefined;
}

export class ChromiumNotFoundError extends Error {
  constructor() {
    super(
      "No local Chromium was found, and none will be downloaded. Searched, in order:\n" +
        chromiumSearchPath().map((place) => `  · ${place}`).join("\n") +
        "\nInstall one (npx playwright install chromium) or set PUPPETEER_EXECUTABLE_PATH, then run again."
    );
    this.name = "ChromiumNotFoundError";
  }
}

/** Pages, read out of the produced document's page tree. */
export function pdfPageCount(bytes: Buffer): number {
  const declared = bytes.toString("latin1").match(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/);
  if (declared) return Number(declared[1]);
  return (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/**
 * The digest of the PDF with its renderer metadata removed. Two runs of the
 * same brief agree on this even though the raw bytes differ — which is how the
 * determinism claim is stated honestly rather than asserted.
 */
export function pdfContentDigest(bytes: Buffer): string {
  const stripped = bytes
    .toString("latin1")
    .replace(/\/(CreationDate|ModDate)\s*\(([^)]*)\)/g, "/$1 ()")
    .replace(/\/Creator\s*\(([^)]*)\)/g, "/Creator ()")
    .replace(/\/Producer\s*\(([^)]*)\)/g, "/Producer ()")
    .replace(/\/ID\s*\[[^\]]*\]/g, "/ID []");
  return createHash("sha256").update(stripped, "latin1").digest("hex");
}

export interface BriefPdfResult {
  bytes: Buffer;
  pages: number;
  renderer: string;
  executablePath: string;
  /** Whether the renderer produced a document outline (PDF bookmarks). */
  outline: boolean;
  contentDigest: string;
}

/**
 * Renders brief HTML to PDF. The HTML is handed over as a data URL rather than
 * a temporary file: the brief carries no external asset, so nothing has to be
 * resolvable relative to a path, and no file is left behind on failure.
 */
export async function renderBriefPdf(html: string): Promise<BriefPdfResult> {
  const resolved = resolveChromium();
  if (!resolved) throw new ChromiumNotFoundError();

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: resolved.executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const bytes = Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        // The brief's own @page rule sets A4 and a 16 mm margin. Honour it
        // instead of layering a second margin on top of it.
        preferCSSPageSize: true,
        // Chromium generates both for free on this path: tagged structure for
        // readers, and an outline built from the headings.
        tagged: true,
        outline: true
      })
    );
    return {
      bytes,
      pages: pdfPageCount(bytes),
      renderer: `${resolved.label} (playwright-core)`,
      executablePath: resolved.executablePath,
      outline: /\/Outlines\s+\d+\s+\d+\s+R/.test(bytes.toString("latin1")),
      contentDigest: pdfContentDigest(bytes)
    };
  } finally {
    await browser.close();
  }
}
