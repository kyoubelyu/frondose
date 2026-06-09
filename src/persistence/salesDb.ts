/**
 * P-72 slice 4 — re-export barrel.
 *
 * The original 750-LoC src/persistence/salesDb.ts has been split into
 * per-domain modules under src/persistence/sales/**. This shim re-exports
 * every symbol the pre-split file exported, so all 21 production importers
 * and 19 test importers (incl. the Phase 16 characterization tests at
 * tests/persistence/salesDb-writes-characterization.mock.test.ts) keep
 * working unchanged.
 *
 * Per-domain modules:
 *   - sales/schema.ts          — DB lifecycle + DDL + migrations + version
 *   - sales/url-normalize.ts   — normalizeProfileUrl (shared util)
 *   - sales/raw-candidates.ts  — raw_candidates repo + types
 *   - sales/leads.ts           — leads repo + types
 *   - sales/drafts.ts          — message_drafts repo + types
 *   - sales/timeline.ts        — lead_timeline repo + types
 *   - sales/accounts.ts        — accounts repo + types
 *   - sales/scores.ts          — lead_scores read-only repo + types
 *   - sales/auto-run.ts        — auto_runs + auto_run_ledger repo + types
 *
 * Behavior is byte-equivalent to the pre-split file — every function body
 * is unchanged; only its file location and import path changed.
 */

export type { AccountRow } from "./sales/accounts.js";
export * from "./sales/accounts.js";
export type {
  AutoActionResult,
  AutoActionType,
  AutoRunRow,
  AutoRunStatus,
} from "./sales/auto-run.js";
export * from "./sales/auto-run.js";
export type {
  DraftCreatedBy,
  DraftKind,
  DraftRow,
  DraftStatus,
} from "./sales/drafts.js";
export * from "./sales/drafts.js";
export type {
  LeadOwnerMode,
  LeadRow,
  LeadStage,
} from "./sales/leads.js";
export * from "./sales/leads.js";
// [2a-r2 — CONCERN-MR (Codex) Option A fix] Explicit named type re-exports so
// `npm run check` (tsc over src/) validates every type-only symbol on this barrel
// surface, not just the one (`LeadEventType`) that happens to be imported by a
// production consumer. Without this block, tsconfig.json:27-28 excludes tests/**
// from tsc and scripts/test-fast.mjs runs `node --import tsx`, so 17 of the 18
// type-only re-exports would never be typechecked at the barrel boundary.
// Under `verbatimModuleSyntax` (tsconfig.json:23) + `isolatedModules`
// (tsconfig.json:17), `export type { ... }` is the canonical typechecked form.
export type {
  RawCandidateRow,
  RawCandidateSource,
  RawCandidateStatus,
} from "./sales/raw-candidates.js";
export * from "./sales/raw-candidates.js";
export * from "./sales/schema.js";
export type { LeadScoreRow } from "./sales/scores.js";
export * from "./sales/scores.js";
export type {
  LeadEventType,
  TimelineRow,
} from "./sales/timeline.js";
export * from "./sales/timeline.js";
export * from "./sales/url-normalize.js";
