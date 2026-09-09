/**
 * P-Y2.2a Step 5 — T-Shell.1/.1b/.2/.3/.4/.5/.6 + T-Extract.1/.2 + T-Scope.1 — FILLED.
 *
 * Source-structural tests on the assembled `OVERLAY_BOOTSTRAP_JS` (via the `inject.ts` facade) + the
 * extraction facade + file-size + write-range guards.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ RENDER-ONLY-PENDING-2.2b (plan §2/§5). The workflow action buttons (Approve/Decline/Hand-off/Pause/
 * Take-over) RENDER but are intentionally INERT in 2.2a (click→serve transport is P-Y2.2b) — a KNOWN,
 * INTENDED intermediate state, NOT a dead-button defect. This contract ASSERTS they render with the
 * canonical labels (T-Shell.1/.1b), ASSERTS the WIRED interactions only (mode tabs → __frondoseSetMode; T-Shell.5),
 * ASSERTS the transport is NOT yet present (no post workflow-/mode/abort literals; T-Shell.5). It does NOT
 * assert the inert buttons act and does NOT flag them dead. 2.2b adds the click→endpoint tests.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Gate coverage: G-PY2.2a.4 (Shell.1/.1b/.2/.3/.5), .6 (Shell.4), .8 (Shell.6), .3 (Extract.1/.2), .9 (Scope.1).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/overlay/bootstrap-pY2.2a.mock.test.ts
 */

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as inject from "../../src/overlay/inject.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOOTSTRAP = (inject as { OVERLAY_BOOTSTRAP_JS?: string }).OVERLAY_BOOTSTRAP_JS ?? "";

const SKELETON_IDS = [
  "workflow-card",
  "workflow-title",
  "workflow-sub",
  "workflow-progress-fill",
  "workflow-progress-text",
  "workflow-steps",
  "workflow-notice",
  "workflow-approve-btn",
  "workflow-decline-btn",
  "workflow-handoff-btn",
  "workflow-pause-btn",
  "workflow-showall-btn",
  "auto-stage",
  "mode-manual-tab",
  "mode-auto-tab",
  "status",
  "command-input",
  "send-btn",
];
// Canonical index.html L315-320 button copy (CONCERN-MR fix — the skeleton sets these, render.ts never does).
const BUTTON_LABELS = ["Approve", "Decline", "Pause", "Run on Auto", "Show all steps"];

describe("OVERLAY_BOOTSTRAP_JS — single IIFE carrying the frondose skeleton ids (G-PY2.2a.4)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.  Then: one "(function install()" head + every skeleton id.
  it("T-Shell.1: OVERLAY_BOOTSTRAP_JS is one '(function install()' IIFE and contains every shared-builder skeleton id", () => {
    assert.ok(BOOTSTRAP.length > 0, "bootstrap string must be non-empty");
    assert.equal((BOOTSTRAP.match(/\(function install\(\)/g) ?? []).length, 1, "exactly one install IIFE head");
    const missing = SKELETON_IDS.filter((id) => !BOOTSTRAP.includes(id));
    assert.deepEqual(
      missing,
      [],
      `every shared-builder skeleton id must be present; missing ${JSON.stringify(missing)}`,
    );
  });
});

describe("OVERLAY_BOOTSTRAP_JS — workflow action buttons render with non-empty labels (CONCERN-MR; G-PY2.2a.4)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS (the skeleton sets the labels; render.ts only toggles visibility/state).
  // When: the workflow-button label assignments are inspected.
  // Then: a non-empty .textContent = '<canonical>' assignment exists for each of the 5 buttons.
  //       (RENDER-ONLY-PENDING-2.2b: these RENDER; we do NOT assert they act.)
  it("T-Shell.1b: the skeleton sets non-empty .textContent on all 5 workflow buttons with the canonical overlay copy (Approve/Decline/Pause/'Run on Auto'/'Show all steps') — guards the empty-shell regression", () => {
    for (const label of BUTTON_LABELS) {
      assert.ok(
        BOOTSTRAP.includes(`textContent = '${label}'`),
        `skeleton must set a non-empty textContent = '${label}' (empty-shell regression guard — the P-Y2.1 blank-button failure)`,
      );
    }
    // and the 5 button ids exist (so the labels attach to real elements)
    for (const id of [
      "workflow-approve-btn",
      "workflow-decline-btn",
      "workflow-pause-btn",
      "workflow-handoff-btn",
      "workflow-showall-btn",
    ]) {
      assert.ok(BOOTSTRAP.includes(id), `button id ${id} must exist in the skeleton`);
    }
  });
});

describe("OVERLAY_BOOTSTRAP_JS — shadowDoc shim + shared-builder calls (G-PY2.2a.4)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.
  // Then: shadowDoc + getElementById bound to shadow + __frondoseShared.buildIwfCard/buildAutoStage/buildSwitcher/buildLeafMark.
  it("T-Shell.2: OVERLAY_BOOTSTRAP_JS contains the shadowDoc shim (getElementById via shadow) and the __frondoseShared builder calls", () => {
    assert.ok(BOOTSTRAP.includes("shadowDoc"), "shadowDoc shim present");
    assert.ok(BOOTSTRAP.includes("shadow.getElementById"), "getElementById bound to the shadow root");
    for (const call of [
      "__frondoseShared.buildIwfCard",
      "__frondoseShared.buildAutoStage",
      "__frondoseShared.buildSwitcher",
      "__frondoseShared.buildLeafMark",
    ]) {
      assert.ok(BOOTSTRAP.includes(call), `must call ${call}`);
    }
  });
});

describe("OVERLAY_BOOTSTRAP_JS — embeds: CSS string literal + executable bundle (G-PY2.2a.1/.2/.4)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.
  // Then: an embedded CSS string carrying ":host" + "var __frondoseShared" (bundle embedded raw + executable).
  it("T-Shell.3: OVERLAY_BOOTSTRAP_JS embeds the frondose CSS (a string carrying ':host') AND the executable bundle ('var __frondoseShared')", () => {
    assert.ok(BOOTSTRAP.includes(":host"), "embedded frondose CSS must carry :host");
    assert.ok(
      /__frondoseCss\s*=\s*"[\s\S]*?:host/.test(BOOTSTRAP) || BOOTSTRAP.includes(":host"),
      "CSS embedded as a string literal",
    );
    assert.ok(BOOTSTRAP.includes("var __frondoseShared"), "the shared bundle must be embedded raw + executable");
  });
});

describe("OVERLAY_BOOTSTRAP_JS — no innerHTML sink anywhere (TT-safe; G-PY2.2a.6)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.  Then: 0 innerHTML / insertAdjacentHTML / outerHTML.
  it("T-Shell.4: OVERLAY_BOOTSTRAP_JS contains 0 occurrences of innerHTML / insertAdjacentHTML / outerHTML (Trusted-Types safe)", () => {
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML"]) {
      assert.ok(!BOOTSTRAP.includes(sink), `TT-safety: no ${sink} sink may appear (createElement/textContent-only)`);
    }
  });
});

describe("OVERLAY_BOOTSTRAP_JS — overlay-callable render fns + mode wiring (P-Y2.2b FLIP; G-PY2.2a.4)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.
  // Then: window.__frondoseShowWorkflow + window.__frondoseSetMode; mode tabs keep local __frondoseSetMode; the existing
  //       'prompt' post is retained.
  // ★ P-Y2.2b RECONCILED: this was the 2.2a "render-only-pending" guard asserting NO workflow/mode/abort post
  //   literals. P-Y2.2b WIRED the transport (the buttons now ACT), so that negative is INVERTED — the literals
  //   ARE present now. The canonical transport assertion lives in tests/overlay/bootstrap-pY2.2b.mock.test.ts
  //   T-Wire.1 (this kept here, inverted, as the historical 2.2a guard's continuation).
  it("T-Shell.5 (P-Y2.2b FLIP): defines window.__frondoseShowWorkflow + window.__frondoseSetMode; mode tabs keep local __frondoseSetMode + the existing 'prompt' post; transport literals are NOW present (wired in 2.2b — superseded by T-Wire.1)", () => {
    assert.ok(BOOTSTRAP.includes("window.__frondoseShowWorkflow"), "must define window.__frondoseShowWorkflow");
    assert.ok(BOOTSTRAP.includes("window.__frondoseSetMode"), "must define window.__frondoseSetMode");
    assert.ok(BOOTSTRAP.includes("__frondoseSetMode("), "mode tabs keep local __frondoseSetMode");
    // FLIP: 2.2b added the transport — the workflow/mode/abort post literals ARE present now.
    const transport = BOOTSTRAP.match(/post\(\s*\{\s*type:\s*['"](workflow-|mode|abort)/g) ?? [];
    assert.ok(
      transport.length > 0,
      "P-Y2.2b wired the transport: workflow/mode/abort post literals must now be present (was the 2.2a no-transport guard; see bootstrap-pY2.2b T-Wire.1)",
    );
    // the existing prompt transport is KEPT
    assert.ok(/post\(\s*\{\s*type:\s*['"]prompt/.test(BOOTSTRAP), "the existing 'prompt' post transport is retained");
  });
});

describe("OVERLAY_BOOTSTRAP_JS — preserved+recolored load-bearing legacy (G-PY2.2a.8)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched.
  // Then: HOST_STYLE + position self-heal + __FRONDOSE_PASSIVE_ENABLED__ + __frondoseShowCard + installPageObservers +
  //       FRONDOSE_DIALOG_KEY all present; legacy LinkedIn-blue '#0a66c2' ABSENT (recolored).
  it("T-Shell.6: preserves HOST_STYLE + position self-heal + __FRONDOSE_PASSIVE_ENABLED__ + __frondoseShowCard + installPageObservers + FRONDOSE_DIALOG_KEY; legacy '#0a66c2' recolored away", () => {
    for (const token of [
      "HOST_STYLE",
      "!== 'fixed'",
      "__FRONDOSE_PASSIVE_ENABLED__",
      "__frondoseShowCard",
      "installPageObservers",
      "FRONDOSE_DIALOG_KEY",
    ]) {
      assert.ok(BOOTSTRAP.includes(token), `load-bearing legacy must survive extraction: ${token}`);
    }
    assert.ok(!BOOTSTRAP.includes("#0a66c2"), "legacy LinkedIn-blue must be recolored away");
  });
});

describe("inject.ts facade — re-exports the public surface (G-PY2.2a.3)", () => {
  // Given: import * as inject.  When: inspected.
  // Then: OVERLAY_BOOTSTRAP_JS (string) + installOverlay/subscribeContextId/callInOverlay (functions) present.
  it("T-Extract.1: the inject.ts facade re-exports OVERLAY_BOOTSTRAP_JS (string) + installOverlay/subscribeContextId/callInOverlay (functions)", () => {
    const m = inject as Record<string, unknown>;
    assert.equal(typeof m.OVERLAY_BOOTSTRAP_JS, "string", "OVERLAY_BOOTSTRAP_JS string re-exported");
    for (const fn of ["installOverlay", "subscribeContextId", "callInOverlay"]) {
      assert.equal(
        typeof m[fn],
        "function",
        `${fn} re-exported as a function (existing importers + mock.module depend on it)`,
      );
    }
  });
});

describe("extraction — every split file ≤ 800 lines (G-PY2.2a.3)", () => {
  // Given: the repo after builder 4b.  When: wc -l each file.  Then: each ≤ 800.
  it("T-Extract.2: bootstrap.ts/bootstrapShell.ts/bootstrapLegacy.ts/host.ts/inject.ts/cssTransform.ts/sharedEntry.ts/render.ts are each ≤ 800 lines", () => {
    const files = [
      "src/overlay/bootstrap.ts",
      "src/overlay/bootstrapShell.ts",
      "src/overlay/bootstrapLegacy.ts",
      "src/overlay/host.ts",
      "src/overlay/inject.ts",
      "src/overlay/cssTransform.ts",
      "src/overlay/sharedEntry.ts",
      "src/tauri/ui/render.ts",
    ];
    for (const f of files) {
      const lines = readFileSync(join(REPO, f), "utf8").split("\n").length;
      assert.ok(lines <= 800, `${f} must be ≤ 800 lines; got ${lines}`);
    }
  });
});

describe("scope — production write-range confined to the allowed paths (G-PY2.2a.9)", () => {
  // Given: the COMMITTED P-Y2.2a diff (pinned by commit message).  When: production paths are listed.
  // Then: each ⊆ {src/overlay/**, src/tauri/ui/render.ts, scripts/**, package.json, biome.json};
  //       none matches serve/turn/dispatch/routes/cron/passive/context/eventBus/main.rs/app.ts/index.html/tools.
  // ★ P-Y2.2b RECONCILED: this was a `git status` (working-tree) check — point-in-time, so once P-Y2.2b started
  //   the working tree carried later-phase serve files and the guard false-flagged them. P-Y2.2a is now COMMITTED,
  //   so pin to the COMMITTED 2.2a diff (by message) — stable across all future phases.
  it("T-Scope.1: the COMMITTED P-Y2.2a diff ⊆ {src/overlay/**, src/tauri/ui/render.ts, scripts/**, package.json, biome.json}; no serve/turn/dispatch/main.rs/app.ts/index.html/tools", () => {
    // P-OPEN-SOURCE-SPLIT Step 5: the exported App root has no git history — the
    // committed-diff pin is a writable-repo regression guard and is vacuous there.
    const gitProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO, encoding: "utf8" });
    if (!(gitProbe.status === 0 && gitProbe.stdout.trim() === "true")) {
      assert.ok(true, "exported root has no git history — committed-diff pin skipped");
      return;
    }
    const sha = execSync('git log --grep="render the shared UI in the in-page CDP host" --format=%H -1', {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    if (!sha) {
      const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" });
      if (shallow.status === 0 && shallow.stdout.trim() === "true") {
        assert.ok(true, "shallow checkout (e.g. CI depth=1) has no searchable history — committed-diff pin skipped");
        return;
      }
    }
    assert.ok(sha, "the P-Y2.2a commit must be findable by message");
    const raw = execSync(`git show --name-only --format= ${sha}`, { cwd: REPO, encoding: "utf8" });
    const paths = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((p) => /^(src\/|scripts\/|package\.json|biome\.json)/.test(p));
    const allow = (p: string) =>
      p.startsWith("src/overlay/") ||
      p === "src/tauri/ui/render.ts" ||
      p.startsWith("scripts/") ||
      p === "package.json" ||
      p === "biome.json";
    const forbidden =
      /serve|turn|dispatch|routes|cron|passive|context|eventBus|main\.rs|app\.ts|index\.html|src\/tools/;
    const offenders = paths.filter((p) => !allow(p));
    assert.deepEqual(
      offenders,
      [],
      `production write-range must stay in the allow-list; offenders ${JSON.stringify(offenders)}`,
    );
    const forbiddenHits = paths.filter((p) => forbidden.test(p));
    assert.deepEqual(
      forbiddenHits,
      [],
      `no forbidden transport/drive/desktop path may change in 2.2a; found ${JSON.stringify(forbiddenHits)}`,
    );
  });
});
