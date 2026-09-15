/**
 * THE GENERATOR'S OUTPUT SET.
 *
 * Runs the real CLI — not a re-implementation of it — into a temporary
 * directory and reads back what landed on disk. The manifest is the contract
 * the product's reports view depends on, so it is checked field by field.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChromium } from "../server/report-pdf";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const NOW = "2026-07-27T09:00:00+02:00";
const chromium = resolveChromium();

let out = "";

async function generate(extra: string[] = []) {
  return run("npx", ["tsx", "scripts/generate-report.ts", `--now=${NOW}`, "--fixtures", `--out=${out}`, ...extra], {
    cwd: ROOT,
    // The generator reaches no network; a slow cold tsx start is the only cost.
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024
  });
}

beforeEach(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), "pitchradar-generate-"));
});

afterEach(async () => {
  if (out) await rm(out, { recursive: true, force: true });
  out = "";
});

describe("npm run report", () => {
  it("writes the brief, the register and a manifest describing the run", { timeout: 200_000 }, async () => {
    const { stdout } = await generate();
    expect(stdout).toContain("MANIFEST:");

    const week = path.join(out, "2026-W31");
    expect((await readdir(week)).sort()).toEqual([
      "manifest.json",
      "pitchradar-brief-2026-W31.html",
      "pitchradar-register-2026-W31.xlsx"
    ]);

    const manifest = JSON.parse(await readFile(path.join(week, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      isoWeek: "2026-W31",
      now: new Date(NOW).toISOString(),
      mode: "fixtures",
      snapshotCounts: { events: expect.any(Number), sources: expect.any(Number) }
    });
    expect(manifest.snapshotCounts.events).toBeGreaterThan(0);
    expect(manifest.snapshotCounts.sources).toBeGreaterThan(0);
    // The commit is read, never invented: on a checkout without git it says so.
    expect(manifest.gitSha).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
    expect(typeof manifest.generatedAt).toBe("string");
  });

  it("adds no app link unless --app-base is given", { timeout: 200_000 }, async () => {
    await generate();
    const plain = await readFile(path.join(out, "2026-W31/pitchradar-brief-2026-W31.html"), "utf8");
    expect(plain).not.toContain('class="applink"');

    await generate(["--app-base=http://127.0.0.1:4182"]);
    const priv = await readFile(path.join(out, "2026-W31/pitchradar-brief-2026-W31.html"), "utf8");
    expect(priv).toContain('<a class="applink" href="http://127.0.0.1:4182/">');
  });

  it.skipIf(!chromium)("prints the brief to a real PDF with --pdf", { timeout: 200_000 }, async () => {
    const { stdout } = await generate(["--pdf"]);
    expect(stdout).toContain("A4 page(s)");

    const pdf = path.join(out, "2026-W31/pitchradar-brief-2026-W31.pdf");
    const stats = await stat(pdf);
    expect(stats.size).toBeGreaterThan(20_000);
    const head = (await readFile(pdf)).subarray(0, 5).toString();
    expect(head).toBe("%PDF-");
  });
});
