import type { Database as DB } from "better-sqlite3";
import { openSalesDatabase } from "../../persistence/salesDb.js";

/** Per-process singleton DB handle, keyed by path. Delegates to salesDb.ts as the canonical cache. */
export function getSalesDb(path: string): DB {
  return openSalesDatabase(path);
}
