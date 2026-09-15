import { closeDatabase } from "../server/database";
import { collectRegisteredSources } from "../server/collector";
import { normalizePendingOccurrences } from "../server/normalizer";

const all = process.argv.includes("--all");
const sourceArgument = process.argv.find((argument) => argument.startsWith("--sources="));
const sourceIds = sourceArgument
  ? sourceArgument.slice("--sources=".length).split(",").map((item) => item.trim()).filter(Boolean)
  : undefined;
const skipNormalization = process.argv.includes("--no-normalize");

try {
  const collector = await collectRegisteredSources({
    dueOnly: !all,
    sourceIds
  });
  const normalization = skipNormalization
    ? undefined
    : await normalizePendingOccurrences();
  console.log(JSON.stringify({ collector, normalization }, null, 2));
  if (collector.receipts.some((receipt) => receipt.runState === "failed")) process.exitCode = 1;
} finally {
  await closeDatabase();
}
