import { closeDatabase, databaseHealth, migrateDatabase } from "../server/database";

try {
  await migrateDatabase();
  console.log(JSON.stringify(await databaseHealth(), null, 2));
} finally {
  await closeDatabase();
}
