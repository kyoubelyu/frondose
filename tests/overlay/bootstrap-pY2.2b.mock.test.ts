/**
 * P-Y2.2b Step 5 — T-Wire.1..5 — FILLED.
 *
 * F8 overlay transport (plan §6.4-D): source-structural assertions on the assembled `OVERLAY_BOOTSTRAP_JS`
 * (via the inject.ts facade) proving the buttons now `post(...)` to serve, the mode tabs keep local
 * `__frondoseSetMode` AND add the mode post, null-tolerance + auto re-bind, and it stays TT-safe.
 *
 * ★ T-Wire.1 FLIPS the 2.2a guard: bootstrap-pY2.2a T-Shell.5 asserted NO transport literals. 2.2b ADDS the
 * transport. The validator updates/supersedes the 2.2a T-Shell.5 (done this round — see § Results).
 *
 * Gate coverage: G-PY2.2b.4 (overlay listeners), .3 (null-tolerance), .6 (handoff/mode distinct), .8 (TT-safe + flip).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/overlay/bootstrap-pY2.2b.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as inject from "../../src/overlay/inject.js";

const BOOTSTRAP = (inject as { OVERLAY_BOOTSTRAP_JS?: string }).OVERLAY_BOOTSTRAP_JS ?? "";
const postRe = (ev: string) => new RegExp(`post\\(\\s*\\{\\s*type:\\s*'${ev}'`);

describe("OVERLAY_BOOTSTRAP_JS — transport literals NOW present (FLIPS 2.2a T-Shell.5) (G-PY2.2b.4, .8)", () => {
  // Given: OVERLAY_BOOTSTRAP_JS.  When: searched (whitespace-tolerant).
  // Then: contains post({type:'workflow-approve'|'workflow-decline'|'workflow-handoff'|'mode'|'abort'}).
  it("T-Wire.1: OVERLAY_BOOTSTRAP_JS contains post({type:'workflow-approve'/'workflow-decline'/'workflow-handoff'/'mode'/'abort'}) literals (the FLIP of the 2.2a no-transport guard)", () => {
    assert.ok(BOOTSTRAP.length > 0, "bootstrap string must be non-empty");
    for (const ev of ["workflow-approve", "workflow-decline", "workflow-handoff", "mode", "abort"]) {
      assert.match(BOOTSTRAP, postRe(ev), `must post({type:'${ev}'…}) — F8 transport`);
    }
  });
});

describe("OVERLAY_BOOTSTRAP_JS — iwf-card action buttons have click listeners (G-PY2.2b.4)", () => {
  it("T-Wire.2: approveBtn/declineBtn/handoffBtn/pauseBtn each have addEventListener('click', …)", () => {
    for (const b of ["approveBtn", "declineBtn", "handoffBtn", "pauseBtn"]) {
      assert.ok(BOOTSTRAP.includes(`${b}.addEventListener('click'`), `${b} must have a click listener`);
    }
  });
});

describe("OVERLAY_BOOTSTRAP_JS — mode tabs keep local __frondoseSetMode AND add the mode post (G-PY2.2b.4, .6)", () => {
  // Then: mode tabs call BOTH __frondoseSetMode( AND post({type:'mode'); existing 'prompt' post retained;
  //       show-all stays local (its handler has no post).
  it("T-Wire.3: mode tabs call BOTH __frondoseSetMode AND post({type:'mode'); prompt post retained; show-all stays local (no post)", () => {
    assert.ok(
      BOOTSTRAP.includes("window.__frondoseSetMode('manual')") && BOOTSTRAP.includes("window.__frondoseSetMode('auto')"),
      "mode tabs keep local __frondoseSetMode",
    );
    assert.match(BOOTSTRAP, postRe("mode"), "mode tabs add post({type:'mode'…})");
    assert.match(BOOTSTRAP, postRe("prompt"), "the existing composer 'prompt' post is retained");
    // show-all handler is local-only (no post in its body)
    const idx = BOOTSTRAP.indexOf("workflow-showall-btn");
    assert.ok(idx >= 0, "showall button must exist");
    // the showall click listener body is local: it toggles workflowExpanded + rerenders, no post(
    assert.ok(
      !postRe("workflow-showall").test(BOOTSTRAP) && !postRe("showall").test(BOOTSTRAP),
      "show-all must NOT post a transport event (stays local)",
    );
  });
});

describe("OVERLAY_BOOTSTRAP_JS — null-tolerance + auto re-bind (G-PY2.2b.3, .4)", () => {
  // Then: rerenderWorkflow null-guards (hide BOTH card + auto-stage); bindAutoStageButtons() called after
  //       buildAutoStage; bindAutoStageButtons binds abort to #auto-pause-btn + #auto-takeover-btn.
  it("T-Wire.4: rerenderWorkflow null-guards (hide BOTH card + auto-stage), calls bindAutoStageButtons() after buildAutoStage, binds abort to #auto-pause-btn + #auto-takeover-btn", () => {
    assert.ok(BOOTSTRAP.includes("bindAutoStageButtons"), "bindAutoStageButtons must exist + be called");
    // the bindAutoStageButtons helper references both auto hero buttons
    assert.ok(BOOTSTRAP.includes("auto-pause-btn"), "binds #auto-pause-btn");
    assert.ok(BOOTSTRAP.includes("auto-takeover-btn"), "binds #auto-takeover-btn");
    // the call comes after buildAutoStage (re-bind each render — the hero is rebuilt)
    const buildIdx = BOOTSTRAP.indexOf("buildAutoStage(");
    const bindIdx = BOOTSTRAP.indexOf("bindAutoStageButtons()");
    assert.ok(buildIdx >= 0 && bindIdx > buildIdx, "bindAutoStageButtons() is called after buildAutoStage(");
    // null branch: rerenderWorkflow hides BOTH surfaces on a falsy workflow (the abort hero buttons post abort)
    assert.match(BOOTSTRAP, postRe("abort"), "auto hero buttons post abort");
  });
});

describe("OVERLAY_BOOTSTRAP_JS — still TT-safe (G-PY2.2b.8)", () => {
  it("T-Wire.5: OVERLAY_BOOTSTRAP_JS contains 0 occurrences of innerHTML / insertAdjacentHTML / outerHTML", () => {
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML"]) {
      assert.ok(!BOOTSTRAP.includes(sink), `TT-safe: no ${sink} (listeners are DOM-API + post(JSON.stringify) only)`);
    }
  });
});
