/**
 * Phase native-port-S2-SHADOW-DELETE — Step 2 (validator scaffold)
 *
 * Shadow deletion + orphan checks: assert the post-deletion state.
 *
 * T-Orphan.1–5 are RED on current HEAD (shadow file + imports still present).
 * T-KeepReadiness.1 is GREEN on current HEAD (composerReadiness.ts must NOT be
 *   collaterally deleted — its deletion is Slice 4, after tool wire-in).
 *
 * These tests become GREEN after Step 4 (Codex backend implementation):
 *   - deletes src/agent/workflow/runtime/deterministicPublishPost.ts
 *   - removes all deterministicPublishPost references from src/
 *   - removes FRONDOSE_PUBLISH_VIA_ACTION from workflow.ts
 *   - removes the publishApprovedFeedPost shadow injection field from context.ts
 *   - inlines the shadow type literals into publishPost.ts
 *
 * Gates covered: deletion / orphan / keep-readiness
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/native-port/shadow-delete-orphan.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Portable recursive grep: returns true if any .ts file (excluding .d.ts)
 * under `dir` contains the given needle string.
 */
function srcContains(dir: string, needle: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (srcContains(fullPath, needle)) return true;
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes(needle)) return true;
      }
    }
  } catch {
    // ignore unreadable dirs/files
  }
  return false;
}

// ---------------------------------------------------------------------------
// T-Orphan.1 — shadow source file must NOT exist
// ---------------------------------------------------------------------------

describe("Shadow deletion: src/agent/workflow/runtime/deterministicPublishPost.ts must not exist (T-Orphan.1)", () => {
  it(
    "T-Orphan.1: when src/agent/workflow/runtime/deterministicPublishPost.ts is checked for existence, " +
      "then it does NOT exist (shadow runtime deleted by Step 4)",
    () => {
      // Given: the repo after Step 4 has deleted the 699-LoC shadow runtime source file.
      // When: fs.existsSync is called on the shadow file path.
      // Then: returns false — the file is gone.
      // NOTE: RED on current HEAD (file exists); GREEN after Step 4 deletes it.
      const shadowPath = resolve(ROOT, "src/agent/workflow/runtime/deterministicPublishPost.ts");
      assert.ok(
        !existsSync(shadowPath),
        "T-Orphan.1: src/agent/workflow/runtime/deterministicPublishPost.ts must NOT exist (shadow deleted)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Orphan.2 — workflow.ts has no deterministicPublishPost reference
// ---------------------------------------------------------------------------

describe("Shadow deletion: workflow.ts must not import deterministicPublishPost or contain FRONDOSE_PUBLISH_VIA_ACTION (T-Orphan.2)", () => {
  it(
    "T-Orphan.2: when src/app/backend/routes/workflow.ts is read, " +
      "then it does NOT contain 'deterministicPublishPost' " +
      "AND does NOT contain 'FRONDOSE_PUBLISH_VIA_ACTION'",
    () => {
      // Given: Step 4 removed the shadow import + the flag selector from workflow.ts.
      // When: the file source text is scanned.
      // Then: no match for 'deterministicPublishPost'; no 'FRONDOSE_PUBLISH_VIA_ACTION'.
      // NOTE: RED on current HEAD (workflow.ts imports from the shadow module + has the flag).
      const workflowSrc = readFileSync(resolve(ROOT, "src/app/backend/routes/workflow.ts"), "utf-8");
      assert.ok(
        !workflowSrc.includes("deterministicPublishPost"),
        "T-Orphan.2: workflow.ts must NOT reference deterministicPublishPost (shadow import retired)",
      );
      assert.ok(
        !workflowSrc.includes("FRONDOSE_PUBLISH_VIA_ACTION"),
        "T-Orphan.2: workflow.ts must NOT contain FRONDOSE_PUBLISH_VIA_ACTION (flag fully retired)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Orphan.3 — context.ts has no deterministicPublishPost reference + no shadow field
// ---------------------------------------------------------------------------

describe("Shadow deletion: context.ts must not reference deterministicPublishPost and ServeDeps must not have shadow injection field (T-Orphan.3)", () => {
  it(
    "T-Orphan.3: when src/app/backend/context.ts is read, " +
      "then it does NOT contain 'deterministicPublishPost' " +
      "AND the ServeDeps type does NOT include a 'publishApprovedFeedPost' field " +
      "(word-boundary regex excludes the …ViaAction variant)",
    () => {
      // Given: Step 4 removed the shadow injection field from ServeDeps in context.ts.
      // When: the file source text is scanned.
      // Then: no 'deterministicPublishPost'; no 'publishApprovedFeedPost\b' field (ViaAction survives).
      // NOTE: RED on current HEAD (context.ts has the shadow injection field referencing deterministicPublishPost).
      const contextSrc = readFileSync(resolve(ROOT, "src/app/backend/context.ts"), "utf-8");
      assert.ok(
        !contextSrc.includes("deterministicPublishPost"),
        "T-Orphan.3: context.ts must NOT reference deterministicPublishPost",
      );
      assert.ok(
        !/\bpublishApprovedFeedPost\b(?!ViaAction)/.test(contextSrc),
        "T-Orphan.3: context.ts ServeDeps must NOT have publishApprovedFeedPost field (shadow injection field retired; only ViaAction survives)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Orphan.4 — publishPost.ts has no deterministicPublishPost reference
// ---------------------------------------------------------------------------

describe("Shadow deletion: src/linkedin/action/publishPost.ts must not import deterministicPublishPost (T-Orphan.4)", () => {
  it(
    "T-Orphan.4: when src/linkedin/action/publishPost.ts is read, " +
      "then it does NOT contain 'deterministicPublishPost' " +
      "AND does NOT contain 'ShadowPublishFailReason' " +
      "(shadow import + type alias inlined into the union)",
    () => {
      // Given: Step 4 inlined the shadow PublishFailReason literals into PublishPostActionFailReason.
      // When: the file source text is scanned.
      // Then: no 'deterministicPublishPost'; no 'ShadowPublishFailReason'.
      // NOTE: RED on current HEAD (publishPost.ts imports ShadowPublishFailReason from shadow).
      const publishSrc = readFileSync(resolve(ROOT, "src/linkedin/action/publishPost.ts"), "utf-8");
      assert.ok(
        !publishSrc.includes("deterministicPublishPost"),
        "T-Orphan.4: publishPost.ts must NOT reference deterministicPublishPost (shadow import retired)",
      );
      assert.ok(
        !publishSrc.includes("ShadowPublishFailReason"),
        "T-Orphan.4: publishPost.ts must NOT contain ShadowPublishFailReason (type alias inlined into union)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-Orphan.5 — global src/ scan: no deterministicPublishPost anywhere
// ---------------------------------------------------------------------------

describe("Shadow deletion: no deterministicPublishPost reference anywhere in src/ (T-Orphan.5)", () => {
  it(
    "T-Orphan.5: when src/ is recursively scanned for 'deterministicPublishPost', " +
      "then zero matches are found (every importer has been refactored by Step 4, " +
      "and the shadow file itself has been deleted)",
    () => {
      // Given: all 4 src/ files that referenced the shadow have been refactored (Steps 4.A–4.C)
      //        and the shadow file deleted (Step 4.D).
      // When: src/ is recursively searched for 'deterministicPublishPost'.
      // Then: 0 matches.
      // NOTE: RED on current HEAD (4 src/ files + the shadow file itself contain the string).
      const srcDir = resolve(ROOT, "src");
      const found = srcContains(srcDir, "deterministicPublishPost");
      assert.ok(
        !found,
        "T-Orphan.5: no .ts file under src/ must reference 'deterministicPublishPost' (shadow fully retired)",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-KeepReadiness.1 — composerReadiness.ts STILL EXISTS + type.ts imports from it
// ---------------------------------------------------------------------------

describe("Regression pin: composerReadiness.ts must NOT be collaterally deleted (T-KeepReadiness.1)", () => {
  it(
    "T-KeepReadiness.1: when src/linkedin/composerReadiness.ts is checked for existence " +
      "and src/tools/browser/type.ts is read, " +
      "then composerReadiness.ts EXISTS and type.ts imports from '../../linkedin/composerReadiness.js'",
    () => {
      // Given: composerReadiness.ts is consumed by tools/browser/type.ts (its deletion is Slice 4).
      // When: existence check + type.ts source scan.
      // Then: file exists; type.ts has the import.
      // NOTE: GREEN on HEAD; must stay GREEN after Step 4 — this phase does NOT delete composerReadiness.ts.
      const composerReadinessPath = resolve(ROOT, "src/linkedin/composerReadiness.ts");
      assert.ok(
        existsSync(composerReadinessPath),
        "T-KeepReadiness.1: src/linkedin/composerReadiness.ts must STILL EXIST (deletion is Slice 4, not this phase)",
      );
      const typeSrc = readFileSync(resolve(ROOT, "src/tools/browser/type.ts"), "utf-8");
      assert.ok(
        /from\s+["']\.\.\/\.\.\/linkedin\/composerReadiness\.js["']/.test(typeSrc),
        "T-KeepReadiness.1: src/tools/browser/type.ts must still import from composerReadiness.js (Slice-4 boundary pin)",
      );
    },
  );
});
