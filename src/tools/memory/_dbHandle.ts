import type { Database as DB } from "better-sqlite3";
import { openMemoryDatabase } from "../../persistence/memory.js";

const cache = new Map<string, DB>();

/** Per-process singleton DB handle, keyed by path. Opens lazily; survives until process exit. */
export function getMemoryDb(path: string): DB {
  let db = cache.get(path);
  if (!db) {
    db = openMemoryDatabase(path);
    cache.set(path, db);
  }
  return db;
}
