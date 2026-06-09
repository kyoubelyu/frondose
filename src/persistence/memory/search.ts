import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { buildMemoryProjection, type MemoryEvent, type MemoryProjection } from "../../linkedin/memoryProjection.js";
import { normalizeProfileUrl } from "./url-normalize.js";

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

// ---- P-39: FTS5 full-text search over person_memory_events ----

/** Per-hit shape returned by searchMemory (FTS5 full-text search). */
export interface MemorySearchHit {
  id: string;
  personName: string;
  profileUrl: string;
  interaction: string;
  summary: string;
  notes: string | null;
  snippet: string;
  score: number | null;
  bm25Rank: number;
  createdAt: string;
}

/** Convert raw text into a safe FTS5 MATCH expression: each whitespace token has
 *  its embedded double-quotes stripped and is then wrapped in double-quotes, so
 *  FTS5 operators (`:`, `*`, `(`, `"`) inside a token cannot inject. Tokens are
 *  space-joined → implicit AND. Purely-punctuation tokens (no word character)
 *  are dropped, since they yield no FTS5 term. Returns "" when no usable token
 *  remains (callers treat "" as "no results"). */
export function toFtsMatchQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0 && /\w/.test(t))
    .map((t) => `"${t}"`)
    .join(" ");
}

/** FTS5 keyword search across all person_memory_events, ranked by bm25 relevance
 *  (best first). person_scores is LEFT-joined as an informational `score` field —
 *  NOT a sort key (P-39 D-4: a keyword search ranks by relevance, not by score). */
export function searchMemory(query: string, limit: number, db: DB): MemorySearchHit[] {
  const match = toFtsMatchQuery(query);
  if (match === "") return [];
  return db
    .prepare(`
      SELECT e.id            AS id,
             e.person_name   AS personName,
             e.profile_url   AS profileUrl,
             e.interaction   AS interaction,
             e.summary       AS summary,
             e.notes         AS notes,
             snippet(memory_fts, 1, '[', ']', '…', 8) AS snippet,
             s.score         AS score,
             bm25(memory_fts) AS bm25Rank,
             e.created_at    AS createdAt
      FROM memory_fts
      JOIN person_memory_events e ON e.rowid = memory_fts.rowid
      LEFT JOIN person_scores s   ON s.profile_url = e.profile_url
      WHERE memory_fts MATCH ?
      ORDER BY bm25(memory_fts) ASC
      LIMIT ?
    `)
    .all(match, limit) as MemorySearchHit[];
}
