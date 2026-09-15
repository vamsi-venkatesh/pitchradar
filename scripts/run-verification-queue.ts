import { closeDatabase } from "../server/database";
import { refreshAvailabilityQueue } from "../server/outreach";

try {
  console.log(JSON.stringify(await refreshAvailabilityQueue(), null, 2));
} finally {
  await closeDatabase();
}
