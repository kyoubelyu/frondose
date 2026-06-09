import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { interactionKindSchema, type MemoryEvent } from "../../linkedin/memoryProjection.js";
import { normalizeProfileUrl } from "./url-normalize.js";

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
  // P-39: optional 0–10 lead score. When present, the remember tool upserts
  // person_scores; appendPersonInteraction ignores it (score is not an event field).
  score: z.number().int().min(0).max(10).optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

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

// ---- P-39: person score (lead rating) ----

/** Upsert a 0–10 lead score. profileUrl is normalized so it joins cleanly with
 *  person_memory_events.profile_url (which remember also stores normalized). */
export function setPersonScore(profileUrl: string, score: number, db: DB): void {
  db.prepare(`
    INSERT INTO person_scores (profile_url, score, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(profile_url) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
  `).run(normalizeProfileUrl(profileUrl), score, new Date().toISOString());
}

/** Read a person's score, or null if never rated. */
export function getPersonScore(profileUrl: string, db: DB): number | null {
  const row = db
    .prepare("SELECT score FROM person_scores WHERE profile_url = ?")
    .get(normalizeProfileUrl(profileUrl)) as { score: number } | undefined;
  return row?.score ?? null;
}

// ---- P-39: general (non-person) key/value memory ----

/** Upsert a general memory note. `value` is opaque text — plain or JSON, the
 *  caller's choice; no JSON enforcement (P-39 D-6). */
export function setMemoryNote(key: string, value: string, db: DB): void {
  db.prepare(`
    INSERT INTO general_memory (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

/** Read a general memory note, or null if absent. */
export function getMemoryNote(key: string, db: DB): { key: string; value: string; updatedAt: string } | null {
  const row = db.prepare("SELECT key, value, updated_at AS updatedAt FROM general_memory WHERE key = ?").get(key) as
    | { key: string; value: string; updatedAt: string }
    | undefined;
  return row ?? null;
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
