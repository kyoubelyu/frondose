/**
 * T-FE-CHAT bug 2 (+ bug 1 wiring) — mock tests for src/tauri/ui/app.ts.
 *
 * app.ts has zero exports + boot()/mustGet() run on import (no DOM harness at this tier), so these
 * are SOURCE-STRUCTURAL assertions — same established pattern as thinkingDisplay-pThink.mock.test.ts
 * / autoRunCompletedUi-pWLC.mock.test.ts. The markdown parser's own BEHAVIOR is covered functionally
 * in markdownRenderer-tfeChat.mock.test.ts (imported via the render.js barrel, executed for real).
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tauri/ui/imeAndClear-tfeChat.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_TS = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf-8");
const TYPES_TS = readFileSync(join(REPO, "src/tauri/ui/render/types.ts"), "utf-8");
const APP_DEPS_TS = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppDependencies.ts"), "utf-8");

// Bounded at the NEXT top-level function declaration (async or not) — sendCommand/performSteer
// are both `async function`, so a plain "\nfunction " boundary (the thinkingDisplay-test pattern,
// safe there since its neighbors are non-async) would overrun past sendCommand into performSteer.
function fnBody(sig: string): string {
  const start = APP_TS.indexOf(sig);
  assert.ok(start >= 0, `app.ts must define ${sig}`);
  const rest = APP_TS.slice(start + sig.length);
  const match = /\n(async )?function /.exec(rest);
  return match && match.index > 0 ? rest.slice(0, match.index) : rest;
}

describe("app.ts — IME-safe Enter guard (T-FE-CHAT bug 2)", () => {
  it("T-Ime.1: a module-level commandComposing flag is tracked via compositionstart/compositionend on commandEl", () => {
    // Given: app.ts top-level wiring source
    // When:  scanned for composition event listeners
    // Then:  compositionstart sets the flag true, compositionend sets it false
    assert.ok(/let\s+commandComposing\s*=\s*false;/.test(APP_TS), "must declare a module-level commandComposing flag");
    const startIdx = APP_TS.indexOf('commandEl.addEventListener("compositionstart"');
    assert.ok(startIdx >= 0, 'must listen for "compositionstart" on commandEl');
    assert.ok(
      APP_TS.slice(startIdx, startIdx + 120).includes("commandComposing = true"),
      "compositionstart must set commandComposing = true",
    );
    const endIdx = APP_TS.indexOf('commandEl.addEventListener("compositionend"');
    assert.ok(endIdx >= 0, 'must listen for "compositionend" on commandEl');
    assert.ok(
      APP_TS.slice(endIdx, endIdx + 120).includes("commandComposing = false"),
      "compositionend must set commandComposing = false",
    );
  });

  it("T-Ime.2: the keydown Enter guard checks isComposing, keyCode!==229, AND !commandComposing before sending", () => {
    // Given: the commandEl keydown listener
    // When:  scanned for the Enter branch condition
    // Then:  all three IME guards are present (isComposing !== true, keyCode !== 229, !commandComposing)
    const idx = APP_TS.indexOf('commandEl.addEventListener("keydown"');
    assert.ok(idx >= 0, "commandEl must have a keydown listener");
    const body = APP_TS.slice(idx, idx + 400);
    assert.ok(body.includes('e.key === "Enter"'), "must guard on Enter");
    assert.ok(body.includes("e.isComposing !== true"), "must guard on isComposing");
    assert.ok(body.includes("e.keyCode !== 229"), "must guard on the legacy keyCode 229 fallback");
    assert.ok(body.includes("!commandComposing"), "must also guard on the module-level commandComposing flag");
    assert.ok(body.includes("void sendCommand()"), "a plain (non-IME) Enter must still dispatch sendCommand");
  });

  it("T-Ime.3: render/types.ts InputElementLike declares compositionstart/compositionend + isComposing/keyCode on the keydown event", () => {
    // Given: the InputElementLike structural interface
    // When:  scanned
    // Then:  a compositionstart|compositionend overload exists, and the keydown listener event
    //        param type carries isComposing?/keyCode?
    assert.ok(
      /addEventListener\(\s*type:\s*"compositionstart"\s*\|\s*"compositionend"/.test(TYPES_TS),
      "InputElementLike must declare a compositionstart/compositionend addEventListener overload",
    );
    assert.ok(TYPES_TS.includes("isComposing?: boolean"), "keydown event type must carry isComposing?");
    assert.ok(TYPES_TS.includes("keyCode?: number"), "keydown event type must carry keyCode?");
  });
});

describe("app.ts — clear-after-success / preserve-on-failure (T-FE-CHAT bug 2)", () => {
  it("T-Clear.1: sendCommand clears only after invoke resolves ok, before lifecycle start", () => {
    // Given: sendCommand's idle-branch body
    // When:  scanned
    // Then:  commandEl.value = "" appears AFTER the r.ok===false early-return and BEFORE transition("running")
    const body = fnBody("async function sendCommand(");
    const okFalseIdx = body.indexOf("r.ok === false");
    const clearIdx = body.indexOf('commandEl.value = "";');
    const runningIdx = body.indexOf("assistantAppComposition.handleEvent");
    assert.ok(okFalseIdx >= 0 && clearIdx >= 0 && runningIdx >= 0, "expected all three markers in sendCommand");
    assert.ok(okFalseIdx < clearIdx, "the failure early-return must be checked BEFORE the clear (preserve-on-failure)");
    assert.ok(clearIdx < runningIdx, "the clear must happen before the accepted turn-start lifecycle event");
  });

  it("T-Clear.2: replacement steer clears only after the replacement turn is accepted", () => {
    // Given the replacement dependency, when the backend rejects, then it throws before clearing.
    const start = APP_DEPS_TS.indexOf("async function startReplacement");
    const body = APP_DEPS_TS.slice(start, APP_DEPS_TS.indexOf("\n  return {", start));
    const rejectedIdx = body.indexOf("if (!result.ok)");
    const clearIdx = body.indexOf('deps.setCommand("");');
    const runningIdx = body.indexOf('deps.transition("running")');
    assert.ok(rejectedIdx >= 0 && clearIdx >= 0 && runningIdx >= 0);
    assert.ok(rejectedIdx < clearIdx && clearIdx < runningIdx);
  });

  it("T-Clear.3: sendCommand's running branch delegates without clearing commandEl.value", () => {
    // Given: sendCommand's running-composer dispatch body
    // When:  scanned
    // Then:  it reads commandEl.value (to build `text`) but never assigns to it directly
    const body = fnBody("async function sendCommand(");
    const steerBranch = body.slice(0, body.indexOf("// P-ONBOARD:"));
    assert.ok(
      steerBranch.includes("await assistantAppComposition.dispatchRunning(text)"),
      "must dispatch through the shared assistant composition",
    );
    assert.ok(
      !/commandEl\.value\s*=/.test(steerBranch),
      "sendCommand's steer branch must not assign commandEl.value itself",
    );
  });
});
