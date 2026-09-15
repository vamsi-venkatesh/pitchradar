/**
 * PitchRadar — export the sanitized demo opportunities.
 *
 *   npx tsx scripts/export-sample-opportunities.ts [--out=examples/sample-opportunities.json]
 *
 * Writes the top-ranked events of the COMMITTED FIXTURE CATALOGUE through the
 * REAL pipeline: the real vendor-relevance classifier (applied by the fixture
 * catalogue itself), the real `scoreOpportunity`, the real tier bands. Nothing
 * here re-implements the product for the sake of a pretty file — the records in
 * the output are the records the product ranks, in the product's own schema.
 *
 * `--now` is pinned by default so the file is reproducible: the scores depend
 * on a clock (days to deadline, whether a window is shut), and an export that
 * changes every day is not an example, it is noise.
 *
 * The fixture catalogue is INVENTED demo data — invented organizers, invented
 * events, invented contacts on example-* domains. The output says so in a
 * top-level field rather than leaving a reader to assume it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureProductSnapshot } from "../server/catalogue";
import { rankOpportunities } from "../src/ranking";

const PINNED_NOW = "2026-07-27T09:00:00+02:00";
const COUNT = 12;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const now = new Date(argValue("now") ?? PINNED_NOW);
  const outPath = path.resolve(
    process.cwd(),
    argValue("out") ?? "examples/sample-opportunities.json"
  );

  const snapshot = fixtureProductSnapshot();
  const ranked = rankOpportunities(snapshot.events, snapshot.profile, now)
    .filter((event) => event.tier !== "REJECTED")
    .slice(0, COUNT);

  const document = {
    demoData: true,
    notice:
      "Demo data. Every organizer, event, contact and domain below is invented for " +
      "this public repository. These records are the committed fixture catalogue " +
      "scored by the product's own ranking, not a hand-written illustration of it.",
    schema: "EventOpportunity[] (src/types.ts), as produced by rankOpportunities (src/ranking.ts)",
    generatedFrom: { catalogueMode: snapshot.mode, now: now.toISOString(), count: ranked.length },
    opportunities: ranked
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`${ranked.length} opportunities → ${outPath}`);
  console.log(
    ranked
      .map((event) => `  ${String(event.score).padStart(3)} ${event.tier}  ${event.name}`)
      .join("\n")
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
