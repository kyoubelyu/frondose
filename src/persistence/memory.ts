/**
 * P-72 slice 8 — re-export barrel.
 *
 * The original 397-LoC src/persistence/memory.ts has been split into
 * per-domain modules under src/persistence/memory/**. This shim re-exports
 * every symbol the pre-split file exported, so all 20 importers (9 production
 * + 11 test/live/fixture) keep working unchanged.
 *
 * Per-domain modules:
 *   - memory/schema.ts          — DB lifecycle + DDL + applyV1/V2/V3 + version
 *   - memory/url-normalize.ts   — normalizeProfileUrl (shared util)
 *   - memory/persons.ts         — person events repo + scores + notes + listing
 *   - memory/search.ts          — query schema + getPersonMemory + FTS5 search
 *
 * Behavior is byte-equivalent to the pre-split file — every function body
 * is unchanged; only its file location and import path changed.
 */
export * from "./memory/schema.js";
export * from "./memory/url-normalize.js";
export * from "./memory/persons.js";
export * from "./memory/search.js";

// [Slice 4 Codex CONCERN-MR — Option A] Explicit named type re-exports so
// `npm run check` (tsc over src/) typechecks every type-only symbol on this
// barrel surface, not just the ones imported by name through the barrel by some
// src/** consumer. Without this block, the 3 type-only symbols below would
// never be typechecked at the barrel boundary because:
//   (a) tsconfig.json:27 excludes "tests" from tsc;
//   (b) scripts/test-fast.mjs runs tests through `node --import tsx`, NOT tsc;
//   (c) no src/** consumer imports these 3 type names by name through the barrel.
// Under verbatimModuleSyntax + isolatedModules (tsconfig.json:17, 23),
// `export type { ... }` is the canonical typechecked form.
export type { RememberInput } from "./memory/persons.js";
export type { MemoryQuery, MemorySearchHit } from "./memory/search.js";
