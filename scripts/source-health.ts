import { sourceRegistry } from "../src/source-registry";
import { probeSources } from "../server/source-probe";

const strict = process.argv.includes("--strict");
const results = await probeSources(sourceRegistry, { concurrency: 4 });
const publicResults = results.map(({ bodyText: _bodyText, ...result }) => result);
const counts = publicResults.reduce<Record<string, number>>((summary, result) => {
  summary[result.state] = (summary[result.state] || 0) + 1;
  return summary;
}, {});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  registered: sourceRegistry.length,
  checked: publicResults.length,
  counts,
  results: publicResults
}, null, 2));

const hardFailures = publicResults.filter((result) =>
  ["broken", "degraded", "unavailable"].includes(result.state)
);
const strictFailures = strict
  ? publicResults.filter((result) => result.state !== "healthy")
  : hardFailures;
if (strictFailures.length) process.exitCode = 1;
