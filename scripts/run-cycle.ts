import { closeDatabase } from "../server/database";
import { runOperatingCycle } from "../server/cycle";

const trigger = process.argv.includes("--scheduled") ? "schedule" : "manual";

try {
  const result = await runOperatingCycle(trigger);
  console.log(JSON.stringify(result, null, 2));
  if (result.state === "failed") process.exitCode = 1;
  else if (result.state === "partial") process.exitCode = 2;
} finally {
  await closeDatabase();
}
