/**
 * P-59 turn-started contract, migrated by P-UI-THINK-COMPACT to the assistant
 * composition graph. Behavioral ordering is covered by the phase binding tests.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = readFileSync(join(REPO, "src/tauri/ui/app.ts"), "utf8");
const BINDINGS = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppBindings.ts"), "utf8");
const COMPOSITION = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppComposition.ts"), "utf8");
const DEPENDENCIES = readFileSync(join(REPO, "src/tauri/ui/app/assistantAppDependencies.ts"), "utf8");
const I18N = readFileSync(join(REPO, "src/tauri/ui/i18n.ts"), "utf8");

describe("turn-started is owned by the assistant composition", () => {
  it("T-Turn.3-A/B: the binding adopts ownership before beginning exactly one bubble", () => {
    // Given the shipped graph, when turn-started arrives, then composition adopts the id and binding begins the runtime.
    assert.match(
      BINDINGS,
      /event\.type === "turn-started"[\s\S]*deps\.onTurnStarted\(lifecycle\);[\s\S]*deps\.runtime\.beginTurn\(\);/,
    );
    assert.match(
      COMPOSITION,
      /onTurnStarted:[\s\S]*deps\.setCurrentTurnId\(frame\.turnId\);[\s\S]*deps\.onTurnStartedView\(frame\);/,
    );
    assert.match(
      APP,
      /assistantAppComposition\.handleEvent\(\{ type: "turn-started", turnId: r\.turnId, source: "server" \}\)/,
    );
  });

  it("T-Turn.3-C: the view keeps source-aware localized ticker text", () => {
    // Given a cron or server source, when the view starts, then the matching localized ticker is selected.
    assert.match(DEPENDENCIES, /frame\.source === "cron" \? "ticker\.cronRunning" : "ticker\.starting"/);
    assert.ok(I18N.includes('"cron running..."'));
    assert.ok(I18N.includes('"starting..."'));
  });

  it("T-Turn.3-D: app input keeps required turnId and the server-or-cron source", () => {
    // Given the local SSE union, when typechecked, then turn-started carries the required ownership fields.
    assert.match(APP, /"turn-started"[\s\S]*turnId:\s*string[\s\S]*source\?:\s*"server"\s*\|\s*"cron"/);
  });
});
