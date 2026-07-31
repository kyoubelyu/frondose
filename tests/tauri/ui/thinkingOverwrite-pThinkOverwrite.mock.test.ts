import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("classified assistant progress overwrites without entering final Markdown", () => {
  it("T-ThinkOw.1: each current progress phase replaces the same progress text sink", () => {
    // Given the production turn controller, when progress frames arrive, then the latest aggregate replaces rather than appends.
    const source = readFileSync(resolve("src/tauri/ui/assistantTurnController.ts"), "utf8");
    assert.match(source, /target\.progressTextEl\.textContent = frame\.text/);
    assert.doesNotMatch(source, /progressTextEl\.textContent \+=/);
    assert.match(source, /frame\.turnId !== owner/);
  });

  it("T-ThinkOw.2: final and terminal paths clear progress while final chunks keep exact append order", () => {
    // Given final and terminal paths, when their source contract is inspected, then progress clears first and only final chunks append to the Markdown buffer.
    const source = readFileSync(resolve("src/tauri/ui/assistantTurnController.ts"), "utf8");
    assert.match(source, /function appendFinal[\s\S]*clearProgress\(target\);[\s\S]*rawText \+= text/);
    assert.match(source, /function endTurn[\s\S]*clearProgress\(target\);[\s\S]*renderNow/);
    assert.match(source, /generation \+= 1/);
    assert.doesNotMatch(source, /pendingTextBreak|rawTextWithBreak/);
  });
});
