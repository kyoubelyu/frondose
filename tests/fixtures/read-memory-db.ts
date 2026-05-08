/**
 * One-shot helper: reads all person_memory_events from a SQLite DB and prints JSON.
 * Usage: tsx tests/fixtures/read-memory-db.ts
 * Env: MAI_MEMORY_DB_PATH=<path>
 */
import { openMemoryDatabase } from "../../src/persistence/memory.js";

const dbPath = process.env.MAI_MEMORY_DB_PATH;
if (!dbPath) {
  process.stderr.write("ERROR: MAI_MEMORY_DB_PATH not set\n");
  process.exit(1);
}

const db = openMemoryDatabase(dbPath);
const rows = db
  .prepare("SELECT person_name, summary, interaction, created_at FROM person_memory_events ORDER BY created_at")
  .all();
console.log(JSON.stringify(rows, null, 2));
db.close();
