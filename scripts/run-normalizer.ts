import { closeDatabase } from "../server/database";
import { normalizePendingOccurrences } from "../server/normalizer";

const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument ? Number(limitArgument.slice("--limit=".length)) : undefined;

try {
  console.log(JSON.stringify(await normalizePendingOccurrences({ limit }), null, 2));
} finally {
  await closeDatabase();
}
