import { closeDatabase, databaseConfigured, migrateDatabase } from "../server/database";
import { runOrganizerIntelligence } from "../server/intelligence";

if (!databaseConfigured()) {
  throw new Error("PITCHRADAR_DATABASE_URL is required for organizer intelligence.");
}

try {
  await migrateDatabase();
  const result = await runOrganizerIntelligence();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDatabase();
}
