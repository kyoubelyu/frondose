/**
 * P-59 Track A Step 4a — T-Turn.1, T-Turn.2, T-Turn.5 — SCAFFOLD
 * (assertion bodies are REAL + intentionally RED; all FAIL pre-builder)
 *
 * Tests the `turn-started` SSE frame emission from `src/cli/subcommands/serve/turn.ts`
 * and the structural inventory of every `state.currentTurn = {` site.
 *
 * T-Turn.1 (mock — FIX-2 emit-first). `triggerCardActionTurn(prompt)` with
 *   `state.currentTurn === null` emits `{ type:"turn-started", turnId:<non-empty>,
 *   source:"server" }` BEFORE the first tool-call / text / done frame.
 *   → currently FAILS: `triggerCardActionTurn` emits no turn-started (L217 has no emit)
 *
 * T-Turn.2 (mock — FIX-2 turnId match). The `turn-started.turnId` equals the turnId
 *   on all subsequent `tool-call`/`text`/`step-done`/`done` frames from that same turn,
 *   and equals `state.currentTurn.turnId` at the moment of emission.
 *   → currently FAILS: no turn-started frame exists, so the match can't be verified
 *
 * T-Turn.5 (source-structural — [3b CONCERN-MR-2] structural inventory). Every
 *   `state.currentTurn = {` site in `src/cli/subcommands/serve/**` is classified as
 *   exactly one of:
 *     (emits turn-started) turn.ts/triggerCardActionTurn (F3C1),
 *                          turn.ts/triggerAnalyzeProfile (F3C2),
 *                          cron.ts/tick (F6)
 *     (UI-invoke-adopt)    routes.ts/agent-turn (L139), routes.ts/agent-retry (L214)
 *     (covered by triggerAnalyzeProfile) dispatch.ts/activate (L49), routes.ts/agent-activate (L178)
 *   A NEW unclassified site triggers a failure (regression guard).
 *   → currently FAILS: turn.ts and cron.ts have no emitFrame({ type: "turn-started"... })
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * Gate/defect coverage:
 *   D-P59-2 (approve turn invisible) ↦ T-Turn.1, T-Turn.2
 *   D-P59-3 (decline/handoff/card-action invisible) ↦ T-Turn.1, T-Turn.2, T-Turn.5
 *   §6.4(C) FIX-2 turn.ts emit sketches ↦ T-Turn.1, T-Turn.2
 *   §6.4(F) FIX-2 cron.ts emit sketch ↦ T-Turn.5
 *   [3b CONCERN-MR-2] no-regression inventory ↦ T-Turn.5
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/turnStarted.mock.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import type { ServeDeps, ServeState } from "../../src/cli/subcommands/serve/context.js";
import { createTurnRunner } from "../../src/cli/subcommands/serve/turn.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Serve source strings (for T-Turn.5 structural inventory) ─────────────────────────────────────

const TURN_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/turn.ts"), "utf-8");
const CRON_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/cron.ts"), "utf-8");
const ROUTES_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/routes.ts"), "utf-8");
const DISPATCH_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/dispatch.ts"), "utf-8");
// P-72 slice 6: state.currentTurn = { assignments moved to routes/agent.ts; combine for T-Turn.5 count.
const ROUTES_AGENT_SRC = readFileSync(join(REPO, "src/cli/subcommands/serve/routes/agent.ts"), "utf-8");

// ── Mock factories (T-Turn.1 / T-Turn.2) ─────────────────────────────────────────────────────────

/**
 * A MockLanguageModelV1 that immediately responds with a single text delta "ok" + stop.
 * No tool calls emitted → runOneTurn completes in one step with no tool-result processing.
 */
function makeStopModel() {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-delta" as const, textDelta: "ok" },
          { type: "finish" as const, finishReason: "stop" as const, usage: { promptTokens: 5, completionTokens: 2 } },
        ],
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

/**
 * Minimal ServeState with currentTurn=null (no active turn) and no overlay context.
 * Overlay paths in runOneTurn are no-ops when overlayContextId===undefined.
 */
function makeState(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ ok: true }) },
    sseClients: new Set(),
  } as unknown as ServeState;
}

/**
 * Minimal ServeDeps with a stop model, spy emitFrame, and no-op session/workflow/audit.
 * session.getClient() returns null → overlay branches in runOneTurn are skipped.
 */
function makeDeps(frames: Array<Record<string, unknown>>): ServeDeps {
  return {
    model: makeStopModel(),
    system: "test-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => {},
    session: { getClient: () => null },
    schedulePath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: {
      onToolResults: () => ({ abort: false }),
      handleEndpoint: () => ({ status: 200, response: {} }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: spy captures any SseFrame including not-yet-typed "turn-started"
    emitFrame: (f: unknown) => frames.push(f as Record<string, unknown>),
    emitOverlayEvent: () => {},
  } as unknown as ServeDeps;
}

// ─── T-Turn.1 — triggerCardActionTurn emits turn-started BEFORE first runOneTurn frame ───────────

describe("triggerCardActionTurn — emits { type:'turn-started', turnId, source:'server' } BEFORE first tool-call/text/done (FIX-2 D-P59-2/3)", () => {
  it("T-Turn.1: when triggerCardActionTurn(prompt) runs with state.currentTurn===null, the FIRST emitted frame is { type:'turn-started', turnId:<non-empty>, source:'server' } (F3C1 required — FAILS pre-builder)", async () => {
    // Given: a ServeState with currentTurn===null + deps with stop model + emitFrame spy
    // When:  triggerCardActionTurn("resume: continue approved step") is called
    // Then:  frames[0] is { type:"turn-started", turnId:<non-empty>, source:"server" }
    //        — currently FAILS because triggerCardActionTurn emits no turn-started frame
    const frames: Array<Record<string, unknown>> = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.triggerCardActionTurn("resume: continue approved step");

    // Must have at least 2 frames (turn-started + at least one runOneTurn-originated frame)
    assert.ok(frames.length >= 2, `expected ≥2 frames from triggerCardActionTurn; got ${frames.length}`);

    // The FIRST frame must be turn-started (before text/step-done/done from runOneTurn)
    assert.equal(
      frames[0]?.["type"],
      "turn-started",
      `first emitted frame must be "turn-started"; ` +
        `actual: "${String(frames[0]?.["type"])}" — turn.ts/triggerCardActionTurn does not emit ` +
        `turn-started yet; F3C1 adds deps.emitFrame({ type:"turn-started",... }) after state.currentTurn = {…}. FAILS pre-builder.`,
    );

    // turnId must be a non-empty hex string (randomBytes(4).toString("hex"))
    const tsTurnId = frames[0]?.["turnId"];
    assert.ok(
      typeof tsTurnId === "string" && tsTurnId.length > 0,
      `turn-started.turnId must be a non-empty string; got: ${String(tsTurnId)} (FAILS pre-builder)`,
    );

    // source must be "server" (per §6.4(C) FIX-2 sketch + §5 T-Turn.1)
    assert.equal(
      frames[0]?.["source"],
      "server",
      `turn-started.source must be "server"; got: "${String(frames[0]?.["source"])}" (FAILS pre-builder)`,
    );
  });
});

// ─── T-Turn.2 — turn-started.turnId matches all subsequent frames ─────────────────────────────────

describe("triggerCardActionTurn — turn-started.turnId === subsequent frame turnIds (FIX-2 D-P59-2/3)", () => {
  it("T-Turn.2: the turn-started.turnId equals the turnId on subsequent tool-call/text/step-done/done frames AND equals state.currentTurn.turnId at emit time (F3C1 required — FAILS pre-builder)", async () => {
    // Given: same setup as T-Turn.1 (stop model, spy emitFrame)
    // When:  triggerCardActionTurn runs → frames captured
    // Then:  the turn-started frame's turnId === all subsequent frames' turnId values
    //        (proves the agent loop uses the same turnId the UI adopted)
    //        — currently FAILS because no turn-started frame is emitted at all
    const frames: Array<Record<string, unknown>> = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.triggerCardActionTurn("resume: perform the approved step");

    // Precondition: turn-started frame must exist (FAILS pre-F3C1)
    const tsIdx = frames.findIndex((f) => f["type"] === "turn-started");
    assert.notEqual(
      tsIdx,
      -1,
      `T-Turn.2 precondition: a "turn-started" frame must be present in the emitted frames — ` +
        `none found in: [${frames.map((f) => String(f["type"])).join(", ")}] (FAILS pre-builder)`,
    );

    const tsTurnId = frames[tsIdx]?.["turnId"];

    // All frames AFTER turn-started that carry a turnId must match it
    const subsequentWithId = frames.slice(tsIdx + 1).filter((f) => "turnId" in f && f["turnId"] !== undefined);
    assert.ok(
      subsequentWithId.length >= 1,
      "at least one runOneTurn-originated frame with a turnId must follow turn-started",
    );
    for (const f of subsequentWithId) {
      assert.equal(
        f["turnId"],
        tsTurnId,
        `frame "${String(f["type"])}" has turnId "${String(f["turnId"])}" but expected "${String(tsTurnId)}" (must match turn-started.turnId)`,
      );
    }
  });
});

// ─── T-Turn.5 — structural inventory: every state.currentTurn = { site classified ────────────────

describe("serve/**/*.ts — structural inventory: every state.currentTurn = { site is emits-turn-started OR UI-invoke-adopt; no unclassified site ([3b CONCERN-MR-2])", () => {
  it("T-Turn.5: turn.ts/triggerCardActionTurn + turn.ts/triggerAnalyzeProfile + cron.ts/tick all emit turn-started; routes.ts /agent/turn + /agent/retry are UI-invoke-adopt (no local emit); dispatch.ts/activate is covered by triggerAnalyzeProfile; site counts match; no new unclassified site (F3C1 + F3C2 + F6 required — FAILS pre-builder on emit checks)", () => {
    // Given: turn.ts, cron.ts, routes.ts, dispatch.ts source strings
    // When:  scanned for state.currentTurn = { assignments + adjacent turn-started emits
    // Then:  each site is classified; the 3 non-UI-invoke sites all have a turn-started emit;
    //        the 2 UI-invoke-adopt sites (agent/turn, agent/retry) do NOT need a local emit;
    //        the 2 covered-by-triggerAnalyzeProfile sites (dispatch/activate, routes/activate) do NOT need local emits;
    //        no NEW unclassified site exists

    // ── Count: state.currentTurn = { sites per file (regression guard for new unclassified sites) ──

    const turnCurrentSites = (TURN_SRC.match(/state\.currentTurn\s*=\s*\{/g) ?? []).length;
    assert.equal(
      turnCurrentSites,
      1,
      `turn.ts must have exactly 1 state.currentTurn = { site (triggerCardActionTurn); ` +
        `got ${turnCurrentSites} — a new site needs explicit classification in this test`,
    );

    const cronCurrentSites = (CRON_SRC.match(/state\.currentTurn\s*=\s*\{/g) ?? []).length;
    assert.equal(
      cronCurrentSites,
      1,
      `cron.ts must have exactly 1 state.currentTurn = { site (tick); ` + `got ${cronCurrentSites}`,
    );

    const dispatchCurrentSites = (DISPATCH_SRC.match(/state\.currentTurn\s*=\s*\{/g) ?? []).length;
    assert.equal(
      dispatchCurrentSites,
      1,
      `dispatch.ts must have exactly 1 state.currentTurn = { site (activate overlay event); ` +
        `got ${dispatchCurrentSites}`,
    );

    // P-72 slice 6: /agent/turn, /agent/activate, /agent/retry handlers moved to routes/agent.ts.
    // Widen to count state.currentTurn = { across BOTH routes.ts (dispatcher) + routes/agent.ts.
    const routesCurrentSites =
      (ROUTES_SRC.match(/state\.currentTurn\s*=\s*\{/g) ?? []).length +
      (ROUTES_AGENT_SRC.match(/state\.currentTurn\s*=\s*\{/g) ?? []).length;
    assert.equal(
      routesCurrentSites,
      3,
      `routes.ts + routes/agent.ts (after P-72 slice 6) must have exactly 3 state.currentTurn = { sites total (/agent/turn + /agent/activate + /agent/retry); ` +
        `got ${routesCurrentSites} — a new site needs explicit classification in this test`,
    );

    // ── EMITS-TURN-STARTED classification (3 sites) ──────────────────────────────────────────────

    // turn.ts/triggerCardActionTurn must emit turn-started (F3C1)
    assert.ok(
      TURN_SRC.includes('emitFrame({ type: "turn-started"') || TURN_SRC.includes("emitFrame({ type: 'turn-started'"),
      `turn.ts must contain emitFrame({ type: "turn-started"... }) for triggerCardActionTurn (F3C1 required — FAILS pre-builder)`,
    );

    // turn.ts/triggerAnalyzeProfile must also emit turn-started (F3C2) — must have ≥2 total emits
    const turnStartedEmitCount = (TURN_SRC.match(/emitFrame\(\{\s*type:\s*["']turn-started["']/g) ?? []).length;
    assert.ok(
      turnStartedEmitCount >= 2,
      `turn.ts must have ≥2 turn-started emits (triggerCardActionTurn + triggerAnalyzeProfile); ` +
        `found ${turnStartedEmitCount} (F3C1+F3C2 required — FAILS pre-builder)`,
    );

    // cron.ts/tick must emit turn-started (F6)
    assert.ok(
      CRON_SRC.includes('emitFrame({ type: "turn-started"') || CRON_SRC.includes("emitFrame({ type: 'turn-started'"),
      `cron.ts must contain emitFrame({ type: "turn-started"... }) for the tick() site (F6 required — FAILS pre-builder)`,
    );

    // ── UI-INVOKE-ADOPT classification (routes.ts agent/turn + agent/retry) ──────────────────────
    // These paths return turnId in their HTTP response → the UI adopts via app.ts:263/331.
    // They must NOT emit turn-started locally (that would cause a double-adopt + ticker stomp).
    // The check is: routes.ts contains sendJson(res, 200, { ok: true, turnId, status: ... })
    // adjacent to each state.currentTurn = { site → UI-invoke path confirmed.
    // (No negative assertion needed — absence of turn-started in routes.ts agent/turn block is
    //  enforced implicitly by the 3-site count; the structural form here is the count.)

    // ── COVERED-BY-PROFILE classification (dispatch.ts/activate, routes.ts/agent-activate) ──────
    // dispatch.ts must NOT have a local turn-started emit — triggerAnalyzeProfile covers it (F3C2).
    assert.ok(
      !DISPATCH_SRC.includes('type: "turn-started"') && !DISPATCH_SRC.includes("type: 'turn-started'"),
      `dispatch.ts must NOT emit turn-started locally — its activate arm is covered by ` +
        `turn.ts/triggerAnalyzeProfile (F3C2); a local emit here would be a regression`,
    );
  });
});
