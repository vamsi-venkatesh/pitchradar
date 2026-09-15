// Which commit is the code that just got measured?
//
// Resolution runs from most explicit to least, and the "unknown" fallback is kept deliberately: a
// run that cannot name its commit must SAY so rather than borrow a plausible-looking one. A wrong
// sha is worse than an absent sha — it silently attributes a measurement to code nobody measured.
//
// On a deployed server the tree is rsync'd with NO .git, so `git rev-parse` fails there by design
// and step 3 is the real path: a file stamped at deploy time next to the code it describes.
// (The deploy scripts themselves are deployment-specific and are not part of this repository.)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** The file the deploy script writes into the deployed tree. Not in git — it describes a deploy. */
export const SHA_FILE = ".deployed-sha";

export function resolveGitSha(root: string): string {
  // 1. An explicit override always wins — CI, a manual re-run, a backfill.
  const env = (process.env.PITCHRADAR_GIT_SHA || "").trim();
  if (env) return env;

  // 2. A real repository: a developer machine.
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch {
    // Not a repo (the deployed tree). Expected on the box — fall through.
  }

  // 3. The deployed tree. VALIDATED, because a truncated or half-written file must not become a
  //    sha that looks real.
  try {
    const raw = readFileSync(resolve(root, SHA_FILE), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(raw)) return raw;
  } catch {
    // No file — a tree deployed before this existed.
  }

  return "unknown";
}
