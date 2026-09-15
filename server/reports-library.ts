/**
 * THE REPORTS LIBRARY.
 *
 * The weekly generator writes its artifacts to disk; this module is the only
 * thing that reads them back. It answers two questions and nothing else: which
 * report sets exist, and give me one named file out of one of them.
 *
 * WHAT IT REFUSES. A week is an ISO week string and a file name is one of four
 * names DERIVED from that week. Neither is ever concatenated from user input
 * and then trusted: `..`, an absolute path, a symlink name, a file the
 * generator does not write — none of them can match, because the allowlist is
 * built from the week, not from the request.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const ISO_WEEK_PATTERN = /^\d{4}-W\d{2}$/;

export type ReportFileKind = "brief" | "register" | "pdf" | "manifest";

export interface ReportManifest {
  isoWeek: string;
  generatedAt: string;
  now: string;
  mode: string;
  snapshotCounts: { events: number; sources: number };
  gitSha: string;
}

export interface ReportFileEntry {
  kind: ReportFileKind;
  name: string;
  bytes: number;
  modifiedAt: string;
}

export interface ReportSet {
  isoWeek: string;
  files: ReportFileEntry[];
  /** Null when the set predates the manifest, or the manifest is unreadable. */
  manifest: ReportManifest | null;
}

/** Where the generator writes. One directory, overridable for an operator. */
export function reportsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(process.cwd(), env.PITCHRADAR_REPORTS_DIR || "reports");
}

/** The four names a week directory may serve, and nothing else. */
export function allowedFiles(isoWeek: string): Record<string, { kind: ReportFileKind; contentType: string }> {
  return {
    [`pitchradar-brief-${isoWeek}.html`]: { kind: "brief", contentType: "text/html; charset=utf-8" },
    [`pitchradar-register-${isoWeek}.xlsx`]: {
      kind: "register",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    [`pitchradar-brief-${isoWeek}.pdf`]: { kind: "pdf", contentType: "application/pdf" },
    "manifest.json": { kind: "manifest", contentType: "application/json; charset=utf-8" }
  };
}

export function manifestName() {
  return "manifest.json";
}

function isManifest(value: unknown): value is ReportManifest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const counts = record.snapshotCounts as Record<string, unknown> | undefined;
  return (
    typeof record.isoWeek === "string" &&
    typeof record.generatedAt === "string" &&
    typeof record.now === "string" &&
    typeof record.mode === "string" &&
    typeof record.gitSha === "string" &&
    Boolean(counts) &&
    typeof counts!.events === "number" &&
    typeof counts!.sources === "number"
  );
}

/**
 * Every generated set, newest week first. A directory that is not an ISO week
 * is not a report set — the committed `sample/` tree and any operator's own
 * folder are simply not listed rather than half-listed.
 */
export async function listReportSets(
  directory = reportsDirectory()
): Promise<ReportSet[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ISO_WEEK_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const sets: ReportSet[] = [];
  for (const isoWeek of entries.sort((a, b) => b.localeCompare(a))) {
    const allowed = allowedFiles(isoWeek);
    const files: ReportFileEntry[] = [];
    for (const [name, meta] of Object.entries(allowed)) {
      try {
        const stats = await stat(path.join(directory, isoWeek, name));
        if (!stats.isFile()) continue;
        files.push({
          kind: meta.kind,
          name,
          bytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        });
      } catch {
        // A file the generator did not write this run. The caller renders the
        // gap; it never renders a button that leads nowhere.
      }
    }
    let manifest: ReportManifest | null = null;
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, isoWeek, manifestName()), "utf8"));
      manifest = isManifest(parsed) ? parsed : null;
    } catch {
      manifest = null;
    }
    sets.push({ isoWeek, files, manifest });
  }
  return sets;
}

export interface ReportFileRead {
  bytes: Buffer;
  contentType: string;
  name: string;
}

/**
 * One file out of one week. Returns undefined for anything that is not an ISO
 * week directory holding one of that week's four allowed names.
 */
export async function readReportFile(
  isoWeek: string,
  file: string,
  directory = reportsDirectory()
): Promise<ReportFileRead | undefined> {
  if (!ISO_WEEK_PATTERN.test(isoWeek)) return undefined;
  const allowed = allowedFiles(isoWeek);
  const meta = allowed[file];
  if (!meta) return undefined;
  // Belt and braces: the allowlist already forbids a separator, but the
  // resolved path is checked against the week directory all the same.
  const weekDirectory = path.join(directory, isoWeek);
  const target = path.resolve(weekDirectory, file);
  if (target !== path.join(weekDirectory, file)) return undefined;
  try {
    const stats = await stat(target);
    if (!stats.isFile()) return undefined;
    return { bytes: await readFile(target), contentType: meta.contentType, name: file };
  } catch {
    return undefined;
  }
}
