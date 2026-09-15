/**
 * THE REPORTS LIBRARY — what it lists, and what it refuses to serve.
 *
 * The listing is built by SCANNING a directory, so the suite builds a real one
 * on disk rather than mocking the file system: a traversal guard that only
 * holds against a fake `readFile` is not a guard.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedFiles, listReportSets, readReportFile, reportsDirectory } from "./reports-library";

let root = "";

const MANIFEST = {
  isoWeek: "2026-W38",
  generatedAt: "2026-09-15T19:00:00.000Z",
  now: "2026-09-15T19:00:00.000Z",
  mode: "fixtures",
  snapshotCounts: { events: 21, sources: 45 },
  gitSha: "2cf34a01e514"
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pitchradar-reports-"));
  // A complete week: brief, register, PDF and manifest.
  await mkdir(path.join(root, "2026-W38"), { recursive: true });
  await writeFile(path.join(root, "2026-W38/pitchradar-brief-2026-W38.html"), "<!doctype html><p>brief");
  await writeFile(path.join(root, "2026-W38/pitchradar-register-2026-W38.xlsx"), Buffer.alloc(2048, 7));
  await writeFile(path.join(root, "2026-W38/pitchradar-brief-2026-W38.pdf"), Buffer.from("%PDF-1.4 test"));
  await writeFile(path.join(root, "2026-W38/manifest.json"), JSON.stringify(MANIFEST));
  // An older week written before --pdf existed, and with no manifest.
  await mkdir(path.join(root, "2026-W31"), { recursive: true });
  await writeFile(path.join(root, "2026-W31/pitchradar-brief-2026-W31.html"), "<!doctype html><p>older");
  // Not a report set: the committed sample tree and an operator's own folder.
  await mkdir(path.join(root, "sample/2026-W01"), { recursive: true });
  await writeFile(path.join(root, "sample/2026-W01/pitchradar-brief-2026-W01.html"), "x");
  // A secret that lives beside the reports directory, for the traversal tests.
  await writeFile(path.join(root, "secret.txt"), "not a report");
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("the reports library — listing", () => {
  it("lists one set per ISO-week directory, newest week first", async () => {
    const sets = await listReportSets(root);
    expect(sets.map((set) => set.isoWeek)).toEqual(["2026-W38", "2026-W31"]);
  });

  it("reports the files that exist, with their size and mtime, and no others", async () => {
    const [latest, older] = await listReportSets(root);
    expect(latest.files.map((file) => file.kind).sort()).toEqual(["brief", "manifest", "pdf", "register"]);
    const register = latest.files.find((file) => file.kind === "register")!;
    expect(register.bytes).toBe(2048);
    expect(new Date(register.modifiedAt).getTime()).toBeGreaterThan(0);

    // The older set is NOT padded with files it does not have: the view shows a
    // gap, and a gap it can render is better than a button that 404s.
    expect(older.files.map((file) => file.kind)).toEqual(["brief"]);
  });

  it("carries the generation manifest, and null where a set predates it", async () => {
    const [latest, older] = await listReportSets(root);
    expect(latest.manifest).toEqual(MANIFEST);
    expect(older.manifest).toBeNull();
  });

  it("ignores a manifest that is not a manifest rather than trusting its shape", async () => {
    await writeFile(path.join(root, "2026-W38/manifest.json"), JSON.stringify({ isoWeek: 38 }));
    const [latest] = await listReportSets(root);
    expect(latest.manifest).toBeNull();
    // The file is still listed as present; only its CONTENT was rejected.
    expect(latest.files.some((file) => file.kind === "manifest")).toBe(true);
  });

  it("lists nothing at all when the reports directory does not exist", async () => {
    expect(await listReportSets(path.join(root, "nowhere"))).toEqual([]);
  });

  it("resolves the reports directory from the environment, defaulting to reports/", () => {
    expect(reportsDirectory({} as NodeJS.ProcessEnv)).toBe(path.resolve(process.cwd(), "reports"));
    expect(reportsDirectory({ PITCHRADAR_REPORTS_DIR: "/srv/artifacts" } as unknown as NodeJS.ProcessEnv))
      .toBe("/srv/artifacts");
  });
});

describe("the reports library — what it will not serve", () => {
  it("serves an allowed file with its content type", async () => {
    const brief = await readReportFile("2026-W38", "pitchradar-brief-2026-W38.html", root);
    expect(brief?.contentType).toBe("text/html; charset=utf-8");
    expect(brief?.bytes.toString()).toContain("brief");

    const pdf = await readReportFile("2026-W38", "pitchradar-brief-2026-W38.pdf", root);
    expect(pdf?.contentType).toBe("application/pdf");

    const register = await readReportFile("2026-W38", "pitchradar-register-2026-W38.xlsx", root);
    expect(register?.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("refuses every traversal, absolute path and unknown name", async () => {
    const refused = [
      ["2026-W38", "../secret.txt"],
      ["2026-W38", "../../etc/passwd"],
      ["2026-W38", "/etc/passwd"],
      ["2026-W38", "..%2Fsecret.txt"],
      ["2026-W38", "subdir/pitchradar-brief-2026-W38.html"],
      ["2026-W38", "pitchradar-brief-2026-W31.html"], // another week's file name
      ["2026-W38", "secret.txt"],
      ["2026-W38", ".."],
      ["..", "manifest.json"],
      ["../sample", "manifest.json"],
      ["/2026-W38", "manifest.json"],
      ["sample", "manifest.json"],
      ["2026-W38/../sample", "manifest.json"]
    ] as const;
    for (const [week, file] of refused) {
      expect(await readReportFile(week, file, root), `${week}/${file} must not be served`).toBeUndefined();
    }
  });

  it("names only files whose name is derived from the week itself", () => {
    expect(Object.keys(allowedFiles("2026-W38"))).toEqual([
      "pitchradar-brief-2026-W38.html",
      "pitchradar-register-2026-W38.xlsx",
      "pitchradar-brief-2026-W38.pdf",
      "manifest.json"
    ]);
  });

  it("returns undefined for a week that was never generated", async () => {
    expect(await readReportFile("2026-W52", "manifest.json", root)).toBeUndefined();
  });
});
