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

const CURRENT_SCHEMA_VERSION = 1;

function runMemoryMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  if (current < 1) applyV1(db);
  if (current < CURRENT_SCHEMA_VERSION) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
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

export const rememberInputSchema = z.object({
  personName: z.string().trim().min(1),
  profileUrl: z.string().trim().url(),
  interaction: interactionKindSchema,
  summary: z.string().trim().min(1).max(220),
  notes: z.string().trim().min(1).max(220).optional(),
  avoid: z.string().trim().min(1).max(160).optional(),
  nextAction: z.string().trim().min(1).max(160).optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

/** Trailing-slash normalization per mai-linkedin/src/memory/memoryRepository.ts. */
export function normalizeProfileUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}

/** Insert a person interaction event. Returns the inserted MemoryEvent. */
export function appendPersonInteraction(input: RememberInput, db: DB): MemoryEvent {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const profileUrl = normalizeProfileUrl(input.profileUrl);
  db.prepare(`
    INSERT INTO person_memory_events
      (id, profile_url, person_name, interaction, summary, notes, avoid, next_action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
