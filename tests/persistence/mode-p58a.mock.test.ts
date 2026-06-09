/**
 * P-58a Step 4a — T-Mode.1..7 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * cronEnabled persistence (plan §6.4-F/G/H/N): a `~/.mai/agent/mode.json` sidecar (NO config-v3 migration),
 * default "manual" (supervised). `setCronMode(state, enabled)` sets runtime cronEnabled AND persists in ONE
 * place, so EVERY operator-initiated mode change persists identically — the `/agent/cron-mode` HTTP route AND
 * the P-Y2.2b overlay `mode` event (dispatch.ts). The D-RUN-1 safety auto-stop sets cronEnabled DIRECTLY (must
 * NOT persist a transient disconnect).
 *
 * LOAD: MIXED. `src/persistence/mode.ts` is NEW (builder 4b B3) → GATE-ON-BUILDER (dynamic import of readMode/
 * writeMode/setCronMode). `createOverlayDispatcher` (dispatch.ts) LOADS NOW (the `mode` case exists from P-Y2.2b;
 * its persistence rewire to setCronMode is the builder's 4b §6.4-N change). T-Mode.4/.6 are STRUCTURAL (read
 * serve.ts/routes.ts source — loads now). All bodies `assert.fail("TODO Step 5: …")`. HOME-isolated via a temp
 * MAI_HOME_BASE (set per-test at Step 5).
 *
 * Gate coverage: G-P58a.6 (mode.json default/round-trip/both-paths-persist/D-RUN-1-non-persist), G-P58a.7.
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/persistence/mode-p58a.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServeDeps, ServeState } from "../../src/cli/subcommands/serve/context.js";
import { createOverlayDispatcher } from "../../src/cli/subcommands/serve/dispatch.js";
import type { OverlayEvent } from "../../src/overlay/eventBus.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVE_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve.ts"), "utf8");
const ROUTES_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes.ts"), "utf8");
// P-72 slice 6: setCronMode call moved to routes/agent.ts; cronEnabled=false on disconnect moved to routes/events.ts
const ROUTES_AGENT_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes", "agent.ts"), "utf8");
const ROUTES_EVENTS_TS = readFileSync(join(REPO, "src", "cli", "subcommands", "serve", "routes", "events.ts"), "utf8");

/** Run `fn` with MAI_HOME_BASE pointed at a fresh temp dir (so DEFAULT_MODE_PATH → temp mode.json). */
function withTempHome<T>(fn: () => T): T {
  const prev = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = mkdtempSync(join(tmpdir(), "p58a-mode-home-"));
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MAI_HOME_BASE;
    else process.env.MAI_HOME_BASE = prev;
  }
}
const tmpModePath = (): string => join(mkdtempSync(join(tmpdir(), "p58a-mode-")), "mode.json");

// gate-on-builder: mode.ts is NEW (builder 4b B3)
type ModeApi = {
  readMode: (path?: string) => "manual" | "auto";
  writeMode: (mode: "manual" | "auto", path?: string) => void;
  setCronMode: (state: { cronEnabled: boolean }, enabled: boolean) => void;
  DEFAULT_MODE_PATH: () => string;
};
let mode: ModeApi | undefined;
before(async () => {
  try {
    const spec = "../../src/persistence/mode.js";
    mode = (await import(spec)) as unknown as ModeApi;
  } catch {
    // mode.ts not built yet (pre-4b)
  }
});

// Minimal createOverlayDispatcher harness — the `mode` case touches only state.cronEnabled + deps.emitFrame.
function makeDispatcher() {
  const emitted: Array<{ type: string; cronEnabled?: boolean }> = [];
  const state = { cronEnabled: false } as ServeState;
  // biome-ignore lint/suspicious/noExplicitAny: minimal deps stub (mode case uses only emitFrame)
  const deps = { emitFrame: (f: { type: string; cronEnabled?: boolean }) => emitted.push(f) } as any as ServeDeps;
  // biome-ignore lint/suspicious/noExplicitAny: turn/passive unused by the mode case
  const { dispatchOverlayEvent } = createOverlayDispatcher(state, deps, {} as any, {} as any);
  return { dispatchOverlayEvent, state, emitted };
}

describe("readMode — default 'manual' (G-P58a.6)", () => {
  // Given: no mode.json at the path. When: readMode(path). Then: "manual".
  it("T-Mode.1: readMode on an absent path → 'manual' (supervised default)", () => {
    assert.ok(mode, "builder 4b must export mode.ts");
    assert.equal(mode.readMode(tmpModePath()), "manual");
  });
});

describe("mode.json — round-trip (G-P58a.6)", () => {
  // Given: a temp path. When: writeMode('auto') then readMode → 'auto'; writeMode('manual') then readMode → 'manual'.
  it("T-Mode.2: writeMode/readMode round-trips both 'auto' and 'manual'", () => {
    assert.ok(mode, "builder 4b must export mode.ts");
    const p = tmpModePath();
    mode.writeMode("auto", p);
    assert.equal(mode.readMode(p), "auto");
    mode.writeMode("manual", p);
    assert.equal(mode.readMode(p), "manual");
  });
});

describe("readMode — malformed/unknown → default (G-P58a.6)", () => {
  // Given: mode.json = '{not json' OR {"mode":"bogus"}. When: readMode. Then: "manual".
  it("T-Mode.3: malformed JSON or unknown mode value → 'manual'", () => {
    assert.ok(mode, "builder 4b must export mode.ts");
    const p1 = tmpModePath();
    writeFileSync(p1, "{not json");
    assert.equal(mode.readMode(p1), "manual", "unparseable JSON → manual");
    const p2 = tmpModePath();
    writeFileSync(p2, JSON.stringify({ mode: "bogus" }));
    assert.equal(mode.readMode(p2), "manual", "unknown mode value → manual");
  });
});

describe("serve boot reads the persisted mode (structural) (G-P58a.6, .7)", () => {
  // Given: serve.ts. When: inspected. Then: cronEnabled is initialized from readMode()==="auto" (NOT hardcoded true).
  it("T-Mode.4: serve.ts initializes cronEnabled from readMode()==='auto' (not hardcoded true)", () => {
    assert.match(
      SERVE_TS,
      /const\s+cronEnabledAtBoot\s*=\s*readMode\(\)\s*===\s*"auto"/,
      "cronEnabledAtBoot initialized from readMode()",
    );
    assert.match(
      SERVE_TS,
      /cronEnabled:\s*cronEnabledAtBoot/,
      "cronEnabledAtBoot threaded into ServeState.cronEnabled",
    );
    assert.ok(!/cronEnabled:\s*true\b/.test(SERVE_TS), "no hardcoded cronEnabled: true remains");
  });
});

describe("setCronMode — sets runtime cronEnabled AND persists (the /agent/cron-mode path) (G-P58a.6)", () => {
  // Given: a temp MAI_HOME_BASE. When: setCronMode(state,true) then readMode(). Then: state.cronEnabled===true
  //        AND readMode()==='auto'; setCronMode(state,false) → readMode()==='manual'. Structural companion:
  //        the /agent/cron-mode handler in routes.ts calls setCronMode(state, enabled).
  it("T-Mode.5: setCronMode(state,enabled) flips state.cronEnabled + writes mode.json; routes.ts /agent/cron-mode calls it", () => {
    assert.ok(mode, "builder 4b must export mode.ts");
    const m = mode;
    withTempHome(() => {
      const st = { cronEnabled: false };
      m.setCronMode(st, true);
      assert.equal(st.cronEnabled, true, "runtime flag set true");
      assert.equal(m.readMode(), "auto", "persisted to mode.json (auto) at DEFAULT_MODE_PATH");
      m.setCronMode(st, false);
      assert.equal(st.cronEnabled, false, "runtime flag set false");
      assert.equal(m.readMode(), "manual", "persisted manual");
    });
    // structural companion: the /agent/cron-mode route calls setCronMode(state, enabled)
    // P-72 slice 6: the call moved to routes/agent.ts; widen to check EITHER location.
    assert.ok(
      /setCronMode\(state,\s*enabled\)/.test(ROUTES_AGENT_TS) ||
        /setCronMode\(state,\s*enabled\)/.test(ROUTES_TS),
      "routes.ts or routes/agent.ts (after P-72 slice 6) /agent/cron-mode routes through setCronMode",
    );
  });
});

describe("D-RUN-1 auto-stop does NOT persist (structural guard) (G-P58a.6)", () => {
  // Given: routes.ts. When: the SSE-client-gone grace timer (the safety auto-stop) is inspected. Then: it sets
  //        state.cronEnabled = false DIRECTLY (NOT via setCronMode/writeMode) — a transient disconnect must not
  //        flip the persisted operator mode.
  it("T-Mode.6: the SSE-disconnect grace auto-stop sets state.cronEnabled=false directly (never setCronMode/writeMode)", () => {
    // The grace auto-stop lives in the res.on("close") handler.
    // P-72 slice 6: the handler moved to routes/events.ts; widen to check EITHER location.
    const eventsCloseIdx = ROUTES_EVENTS_TS.indexOf('res.on("close"');
    const routesCloseIdx = ROUTES_TS.indexOf('res.on("close"');
    const closeIdx = eventsCloseIdx > 0 ? eventsCloseIdx : routesCloseIdx;
    const src = eventsCloseIdx > 0 ? ROUTES_EVENTS_TS : ROUTES_TS;
    assert.ok(closeIdx > 0, "the SSE close handler exists (routes.ts or routes/events.ts after P-72 slice 6)");
    const block = src.slice(closeIdx, closeIdx + 700);
    assert.match(block, /state\.cronEnabled\s*=\s*false/, "the auto-stop flips cronEnabled DIRECTLY");
    assert.ok(!block.includes("setCronMode"), "the transient-disconnect auto-stop must NOT call setCronMode");
    assert.ok(!block.includes("writeMode"), "the transient-disconnect auto-stop must NOT writeMode (no persist)");
  });
});

describe("overlay 'mode' event persists, same as the route (Step-3b CONCERN-MR) (G-P58a.6)", () => {
  // Given: a temp MAI_HOME_BASE + createOverlayDispatcher. When: dispatchOverlayEvent({event_type:'mode',
  //        mode:'auto'}). Then: state.cronEnabled===true AND readMode()==='auto' (written via setCronMode) AND
  //        emitFrame called with {type:'cron-mode',cronEnabled:true}. AND mode:'manual' → false + readMode 'manual'.
  it("T-Mode.7: an overlay 'mode' event routes through setCronMode → persists to mode.json + emits cron-mode (same as the route)", () => {
    assert.ok(mode, "builder 4b must export mode.ts");
    const m = mode;
    withTempHome(() => {
      const d = makeDispatcher();
      d.dispatchOverlayEvent({ event_type: "mode", mode: "auto" } as unknown as OverlayEvent);
      assert.equal(d.state.cronEnabled, true, "overlay mode:auto → runtime cronEnabled true");
      assert.equal(m.readMode(), "auto", "overlay path PERSISTED to mode.json (the CONCERN-MR fix)");
      assert.ok(
        d.emitted.some((f) => f.type === "cron-mode" && f.cronEnabled === true),
        "emits cron-mode{cronEnabled:true} (same as the route)",
      );
      d.dispatchOverlayEvent({ event_type: "mode", mode: "manual" } as unknown as OverlayEvent);
      assert.equal(d.state.cronEnabled, false, "overlay mode:manual → false");
      assert.equal(m.readMode(), "manual", "persisted manual via the overlay path");
    });
  });
});
