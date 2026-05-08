import { z } from "zod";

/** 7-element interaction kind enum per mai-linkedin/src/memory/memoryTypes.ts:1-52. */
export const interactionKindSchema = z.enum(["like", "comment", "repost", "message", "connect", "post", "at"]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

/** Per-event memory record. `direction` is NOT persisted (Phase 64; mai-linkedin source comment). */
export const memoryEventSchema = z.object({
  id: z.string().uuid(),
  personName: z.string().trim().min(1),
  profileUrl: z.string().trim().url(),
  interaction: interactionKindSchema,
  summary: z.string().trim().min(1).max(220),
  notes: z.string().trim().min(1).max(220).optional(),
  avoid: z.string().trim().min(1).max(160).optional(),
  nextAction: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().min(1),
});
export type MemoryEvent = z.infer<typeof memoryEventSchema>;

/** Aggregate projection: latest event + history list + dedup'd avoid + nextActions. */
export const memoryProjectionSchema = z.object({
  personName: z.string().trim().min(1),
  profileUrl: z.string().trim().url(),
  latestInteraction: memoryEventSchema,
  history: z.array(memoryEventSchema).min(1),
  avoid: z.array(z.string()),
  nextActions: z.array(z.string()),
});
export type MemoryProjection = z.infer<typeof memoryProjectionSchema>;

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((v) => v?.trim()).filter(Boolean) as string[]));
}

/** Build a projection from a list of events sorted DESC by createdAt. */
export function buildMemoryProjection(rows: MemoryEvent[]): MemoryProjection | undefined {
  if (rows.length === 0) return undefined;
  // biome-ignore lint/style/noNonNullAssertion: length-checked above.
  const first = rows[0]!; // sorted DESC; first = latest
  return {
    personName: first.personName,
    profileUrl: first.profileUrl,
    latestInteraction: first,
    history: rows,
    avoid: unique(rows.map((r) => r.avoid)),
    nextActions: unique(rows.map((r) => r.nextAction)),
  };
}

/** Display-friendly formatter: 1-line summary + counts. Used by getMemory tool result. */
export function formatMemoryProjection(p: MemoryProjection): string {
  return (
    `${p.personName} (${p.profileUrl}): ${p.latestInteraction.summary} ` +
    `[${p.history.length} events; avoid=${p.avoid.length}; nextActions=${p.nextActions.length}]`
  );
}
