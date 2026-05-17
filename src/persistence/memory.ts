import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  buildMemoryProjection,
  interactionKindSchema,
  type MemoryEvent,
  type MemoryProjection,
} from "../linkedin/memoryProjection.js";

export const DEFAULT_MEMORY_DB_PATH = (): string => join(homedir(), ".mai", "agent", "memory.sqlite");

/** Open the memory DB, run migrations, return the handle. Synchronous (better-sqlite3 is sync). */
export function openMemoryDatabase(path: string = DEFAULT_MEMORY_DB_PATH()): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMemoryMigrations(db);
  return db;
}

/** Close the DB handle. Idempotent. */
export function closeMemoryDatabase(db: DB): void {
  db.close();
}

/** Current memory schema version. Exported as a stable contract for diagnostics
 *  (e.g. tests asserting the latest applied version exists in `schema_version`). */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * P-25 Step-3b B-1 fix: each migration step is wrapped in its own
 * `db.transaction()` that covers BOTH the DDL and the version-row INSERT.
 * Without this, a crash between `applyVN(db)` and the version INSERT would
 * leave the DB in "VN-with-newer-columns / version=N-1" state; the next
 * startup would re-run `applyVN`, and SQLite's non-IF-NOT-EXISTS
 * `ALTER TABLE ADD COLUMN` would throw "duplicate column", permanently
 * breaking the operator's memory.sqlite.
 *
 * better-sqlite3's `db.transaction()` provides rollback-on-throw + supports
 * DDL inside transactions on SQLite >= 3.7.11 (bundled SQLite is 3.43.x).
 */
function runMemoryMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  if (current < 1) {
    db.transaction(() => {
      applyV1(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
  if (current < 2) {
    db.transaction(() => {
      applyV2(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
    })();
  }
}

function applyV1(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_memory_events (
      id TEXT PRIMARY KEY,
      profile_url TEXT NOT NULL,
      person_name TEXT NOT NULL,
      interaction TEXT NOT NULL,
      summary TEXT NOT NULL,
      notes TEXT,
      avoid TEXT,
      next_action TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_memory_profile_url ON person_memory_events (profile_url, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_person_memory_person_name ON person_memory_events (person_name, created_at DESC);
  `);
}

/** P-25: 4 nullable attribution columns. P-26 worker→server sync populates;
 *  worker's own writes leave these NULL (attribution is meaningless on the
 *  local DB). Existing rows get NULL; existing SELECT projections ignore
 *  the extra columns (backward-compat). */
function applyV2(db: DB): void {
  db.exec(`
    ALTER TABLE person_memory_events ADD COLUMN source_worker_id TEXT;
    ALTER TABLE person_memory_events ADD COLUMN source_hostname TEXT;
    ALTER TABLE person_memory_events ADD COLUMN source_persona TEXT;
    ALTER TABLE person_memory_events ADD COLUMN ts INTEGER;
  `);
}

export const rememberInputSchema = z.object({
  personName: z.string().trim().min(1),
  profileUrl: z.string().trim().url(),
  interaction: interactionKindSchema,
  summary: z.string().trim().min(1).max(220),
  notes: z.string().trim().min(1).max(220).optional(),
  avoid: z.string().trim().min(1).max(160).optional(),
  nextAction: z.string().trim().min(1).max(160).optional(),
  // P-25 attribution (optional; P-26 worker→server sync populates these).
  // Worker's local `remember` calls leave them undefined → SQL NULL.
  sourceWorkerId: z.string().trim().min(1).optional(),
  sourceHostname: z.string().trim().min(1).optional(),
  sourcePersona: z.string().trim().min(1).optional(),
  ts: z.number().int().nonnegative().optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

/** Trailing-slash normalization per mai-linkedin/src/memory/memoryRepository.ts. */
export function normalizeProfileUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}

/** Insert a person interaction event. Returns the inserted MemoryEvent.
 *  P-25: writes the 4 V2 attribution columns when supplied; NULL otherwise.
 *  Worker's own `remember` calls leave attribution undefined (NULL). P-26
 *  worker→server sync sets all four. */
export function appendPersonInteraction(input: RememberInput, db: DB): MemoryEvent {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const profileUrl = normalizeProfileUrl(input.profileUrl);
  db.prepare(`
    INSERT INTO person_memory_events
      (id, profile_url, person_name, interaction, summary, notes, avoid, next_action, created_at,
       source_worker_id, source_hostname, source_persona, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    profileUrl,
    input.personName,
    input.interaction,
    input.summary,
    input.notes ?? null,
    input.avoid ?? null,
    input.nextAction ?? null,
    createdAt,
    input.sourceWorkerId ?? null,
    input.sourceHostname ?? null,
    input.sourcePersona ?? null,
    input.ts ?? null,
  );
  return {
    id,
    personName: input.personName,
    profileUrl,
    interaction: input.interaction,
    summary: input.summary,
    notes: input.notes,
    avoid: input.avoid,
    nextAction: input.nextAction,
    createdAt,
  };
}

export const memoryQuerySchema = z
  .object({
    personName: z.string().trim().min(1).optional(),
    profileUrl: z.string().trim().url().optional(),
  })
  .refine((d) => d.personName || d.profileUrl, "Provide personName or profileUrl");
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;

/** Read events for a person; returns a MemoryProjection or undefined if no rows. */
export function getPersonMemory(query: MemoryQuery, db: DB): MemoryProjection | undefined {
  const where: string[] = [];
  const params: string[] = [];
  if (query.profileUrl) {
    where.push("profile_url = ?");
    params.push(normalizeProfileUrl(query.profileUrl));
  }
  if (query.personName) {
    where.push("person_name = ?");
    params.push(query.personName);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, profile_url AS profileUrl, person_name AS personName, interaction, summary, notes, avoid, next_action AS nextAction, created_at AS createdAt FROM person_memory_events ${whereClause} ORDER BY datetime(created_at) DESC`,
    )
    .all(...params) as Array<
    MemoryEvent & { nextAction?: string | null; notes?: string | null; avoid?: string | null }
  >;
  // Coerce SQL NULL → undefined so Zod schemas match.
  const events: MemoryEvent[] = rows.map((r) => ({
    ...r,
    notes: r.notes ?? undefined,
    avoid: r.avoid ?? undefined,
    nextAction: r.nextAction ?? undefined,
  }));
  return buildMemoryProjection(events);
}

/** P-29 STUB: paginated recent person_memory_events for the dashboard lead-memory browse.
 *  builder implements at Step 4b — ORDER BY created_at DESC (plain lexical, C-1).
 *  `created_at` is TEXT always written via .toISOString() (UTC Z) → lexical == time sort.
 *  Returns [] on empty DB. */
export function listRecentMemoryEvents(
  db: DB,
  limit: number,
  offset: number,
): Array<{
  id: string;
  profile_url: string;
  person_name: string;
  interaction: string;
  summary: string;
  next_action: string | null;
  created_at: string;
  source_worker_id: string | null;
  source_persona: string | null;
}> {
  return db
    .prepare(
      `SELECT id, profile_url, person_name, interaction, summary,
              next_action, created_at, source_worker_id, source_persona
       FROM person_memory_events
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ReturnType<typeof listRecentMemoryEvents>;
}
