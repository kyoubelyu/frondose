/**
 * F-REN-3 Step 5 — Filled assertions: T-FREN3.1..T-FREN3.6, T-FREN3.9, T-FREN3.10
 *
 * frondoseEnv reads FRONDOSE_<name> ONLY — the MAI_ back-compat shim was removed in
 * the full rebrand (2026-06-15). Tests that previously asserted the ?? MAI_ fallback
 * now assert that MAI_-only returns undefined / homedir() (no fallback).
 *
 * Gate coverage:
 *   G-FREN3.back-compat (T-FREN3.1) — flipped: MAI_-only returns homedir() (no shim)
 *   G-FREN3.precedence  (T-FREN3.2) — FRONDOSE_ still wins when both set
 *   G-FREN3.default     (T-FREN3.3) — neither set → homedir() unchanged
 *   G-FREN3.shim        (T-FREN3.4) — flipped: MAI_-only returns undefined (no shim)
 *   G-FREN3.outcome     (T-FREN3.5) — flipped: MAI_-only falls through to DEFAULT_MODEL_SPEC
 *   G-FREN3.empty       (T-FREN3.6) — FRONDOSE_='' still returns '' (not MAI_ value)
 *   G-FREN3.lockstep    (T-FREN3.9) — case 1 still works; case 2 flipped: MAI_-only → undefined
 *   G-FREN3.suffix-na   (T-FREN3.10) — overlay placeholders unchanged
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/env/frondoseEnv.mock.test.ts
 */

import assert from "node:assert/strict";
import os from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
// T-FREN3.5 exercises this (reads via frondoseEnv("MODEL")):
import { DEFAULT_MODEL_SPEC, resolveModelSpec } from "../../src/agent/modelResolver.js";
import { frondoseEnv } from "../../src/env.js";
// Imports that exist now (production reads go through frondoseEnv):
import { getHomeBase } from "../../src/persistence/paths.js";

const REPO = resolve(process.cwd());
const HOST_TS_PATH = resolve(REPO, "src/overlay/host.ts");

// ─── env save/restore helper ──────────────────────────────────────────────────

/** Save env keys and return a restore function. */
function saveEnv(...keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  };
}

// ─── T-FREN3.1 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — MAI_ back-compat shim REMOVED: MAI_-only returns homedir() (G-FREN3.back-compat)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_HOME_BASE", "FRONDOSE_HOME_BASE");
  });
  afterEach(() => restore());

  it("T-FREN3.1: when MAI_HOME_BASE set + FRONDOSE_HOME_BASE unset, getHomeBase() returns os.homedir() (shim removed — MAI_ not honored)", () => {
    // Given: process.env.MAI_HOME_BASE = "/tmp/fren3-legacy"; FRONDOSE_HOME_BASE unset
    // When:  getHomeBase() is called (reads frondoseEnv("HOME_BASE") = FRONDOSE_HOME_BASE only)
    // Then:  returns os.homedir() — the MAI_ shim was removed; FRONDOSE_HOME_BASE unset → homedir fallback
    process.env.MAI_HOME_BASE = "/tmp/fren3-legacy";
    delete process.env.FRONDOSE_HOME_BASE;

    assert.equal(getHomeBase(), os.homedir());
  });
});

// ─── T-FREN3.2 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — FRONDOSE_* wins when set (G-FREN3.precedence)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_HOME_BASE", "FRONDOSE_HOME_BASE");
  });
  afterEach(() => restore());

  it("T-FREN3.2: when both MAI_HOME_BASE + FRONDOSE_HOME_BASE set, getHomeBase() returns the FRONDOSE_ value", () => {
    // Given: process.env.MAI_HOME_BASE = "/tmp/legacy"; FRONDOSE_HOME_BASE = "/tmp/new"
    // When:  getHomeBase() is called
    // Then:  returns "/tmp/new" (FRONDOSE_ is the only key honored — MAI_ is ignored)
    process.env.MAI_HOME_BASE = "/tmp/legacy";
    process.env.FRONDOSE_HOME_BASE = "/tmp/new";

    assert.equal(getHomeBase(), "/tmp/new");
  });
});

// ─── T-FREN3.3 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — neither set → default behavior unchanged (G-FREN3.default)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_HOME_BASE", "FRONDOSE_HOME_BASE");
  });
  afterEach(() => restore());

  it("T-FREN3.3: when both MAI_HOME_BASE + FRONDOSE_HOME_BASE unset, getHomeBase() returns homedir()", () => {
    // Given: both MAI_HOME_BASE and FRONDOSE_HOME_BASE unset
    // When:  getHomeBase() is called
    // Then:  returns os.homedir() (unchanged default)
    delete process.env.MAI_HOME_BASE;
    delete process.env.FRONDOSE_HOME_BASE;

    assert.equal(getHomeBase(), os.homedir());
  });
});

// ─── T-FREN3.4 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — reads FRONDOSE_ only; MAI_-only returns undefined (G-FREN3.shim)", () => {
  it("T-FREN3.4: frondoseEnv with injected env — FRONDOSE_ wins; MAI_-only returns undefined (shim removed); {} returns undefined", () => {
    // Given: three injected env objects exercising each case
    // When:  frondoseEnv("MODEL", injectedEnv) for each
    // Then:  both-set → FRONDOSE_ value; MAI_-only → undefined (shim removed); empty → undefined

    // Case 1: both set → FRONDOSE_ wins
    assert.equal(
      frondoseEnv("MODEL", { FRONDOSE_MODEL: "deepseek:new", MAI_MODEL: "deepseek:old" }),
      "deepseek:new",
    );

    // Case 2: MAI_-only → returns undefined (shim removed — FRONDOSE_ key is absent)
    assert.equal(
      frondoseEnv("MODEL", { MAI_MODEL: "deepseek:legacy" }),
      undefined,
    );

    // Case 3: neither set → returns undefined
    assert.equal(frondoseEnv("MODEL", {}), undefined);
  });
});

// ─── T-FREN3.5 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — outcome-anchored: resolveModelSpec reads FRONDOSE_MODEL only (G-FREN3.outcome)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_MODEL", "FRONDOSE_MODEL");
  });
  afterEach(() => restore());

  it("T-FREN3.5 case 1: when MAI_MODEL set + FRONDOSE_MODEL unset, resolveModelSpec({}) returns DEFAULT_MODEL_SPEC (MAI_ not honored — shim removed)", () => {
    // Given: process.env.MAI_MODEL = "deepseek:legacy"; FRONDOSE_MODEL unset
    // When:  resolveModelSpec({}) is called
    // Then:  returns DEFAULT_MODEL_SPEC (falls through to hardcoded default — MAI_ shim gone)
    delete process.env.FRONDOSE_MODEL;
    process.env.MAI_MODEL = "deepseek:legacy";

    assert.equal(resolveModelSpec({}), DEFAULT_MODEL_SPEC);
  });

  it("T-FREN3.5 case 2: when both MAI_MODEL + FRONDOSE_MODEL set, resolveModelSpec({}) returns the FRONDOSE_ value", () => {
    // Given: FRONDOSE_MODEL = "deepseek:new"; MAI_MODEL = "deepseek:legacy"
    // When:  resolveModelSpec({}) is called
    // Then:  returns "deepseek:new" (FRONDOSE_ is the only env key consulted)
    process.env.MAI_MODEL = "deepseek:legacy";
    process.env.FRONDOSE_MODEL = "deepseek:new";

    assert.equal(resolveModelSpec({}), "deepseek:new");
  });
});

// ─── T-FREN3.6 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — empty-string semantics: explicit empty FRONDOSE_ does NOT fall through (G-FREN3.empty)", () => {
  it("T-FREN3.6: when FRONDOSE_AUTOUPDATE='' + MAI_AUTOUPDATE='skip', frondoseEnv returns '' not 'skip'", () => {
    // Given: injected env { FRONDOSE_AUTOUPDATE: "", MAI_AUTOUPDATE: "skip" }
    // When:  frondoseEnv("AUTOUPDATE", injectedEnv) is called
    // Then:  returns "" — the FRONDOSE_ key is present (empty string); MAI_ is ignored entirely
    const result = frondoseEnv("AUTOUPDATE", { FRONDOSE_AUTOUPDATE: "", MAI_AUTOUPDATE: "skip" });

    assert.equal(result, "");
    assert.notEqual(result, "skip");
  });
});

// ─── T-FREN3.9 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — Rust↔Node SIDECAR_OWNER lockstep (G-FREN3.lockstep)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_SIDECAR_OWNER", "FRONDOSE_SIDECAR_OWNER");
  });
  afterEach(() => restore());

  it("T-FREN3.9 case 1: FRONDOSE_SIDECAR_OWNER set + MAI_ unset → frondoseEnv returns 'frondose-app'", () => {
    // Given: FRONDOSE_SIDECAR_OWNER = "frondose-app"; MAI_ unset
    // When:  frondoseEnv("SIDECAR_OWNER") is called
    // Then:  returns "frondose-app" — FRONDOSE_ key is honored
    process.env.FRONDOSE_SIDECAR_OWNER = "frondose-app";
    delete process.env.MAI_SIDECAR_OWNER;

    assert.equal(frondoseEnv("SIDECAR_OWNER"), "frondose-app");
  });

  it("T-FREN3.9 case 2: MAI_SIDECAR_OWNER set + FRONDOSE_ unset → frondoseEnv returns undefined (shim removed — use FRONDOSE_SIDECAR_OWNER)", () => {
    // Given: MAI_SIDECAR_OWNER = "frondose-app" (old Rust not yet rebuilt); FRONDOSE_ unset
    // When:  frondoseEnv("SIDECAR_OWNER") is called
    // Then:  returns undefined — MAI_ shim was removed; Rust must set FRONDOSE_SIDECAR_OWNER
    process.env.MAI_SIDECAR_OWNER = "frondose-app";
    delete process.env.FRONDOSE_SIDECAR_OWNER;

    assert.equal(frondoseEnv("SIDECAR_OWNER"), undefined);
  });
});

// ─── T-FREN3.10 ───────────────────────────────────────────────────────────────

describe("overlay placeholders untouched — __MAI_*__ tokens in host.ts are NOT env vars (G-FREN3.suffix-na)", () => {
  it("T-FREN3.10: host.ts .replace() calls for __MAI_OVERLAY_OWNER__ + __MAI_OVERLAY_VERSION__ + __MAI_PASSIVE_ENABLED__ remain unchanged; only env reads go through frondoseEnv", () => {
    // Given: src/overlay/host.ts source text
    // When:  source scan for placeholder .replace() calls and for raw process.env.MAI_ reads
    // Then:  all three __MAI_*__ placeholder patterns present (overlay tokens deferred);
    //        zero raw process.env.MAI_ reads remain in host.ts (they are swapped to frondoseEnv)

    const hostSrc = readFileSync(HOST_TS_PATH, "utf8");

    // All three overlay placeholder tokens must still be present (deferred — NOT renamed)
    assert.ok(
      hostSrc.includes("__MAI_OVERLAY_OWNER__"),
      "host.ts must still contain __MAI_OVERLAY_OWNER__ placeholder (deferred)",
    );
    assert.ok(
      hostSrc.includes("__MAI_OVERLAY_VERSION__"),
      "host.ts must still contain __MAI_OVERLAY_VERSION__ placeholder (deferred)",
    );
    assert.ok(
      hostSrc.includes("__MAI_PASSIVE_ENABLED__"),
      "host.ts must still contain __MAI_PASSIVE_ENABLED__ placeholder (deferred)",
    );

    // Zero raw process.env.MAI_* reads may remain — all env reads must go through frondoseEnv
    const rawMaiReads = hostSrc.match(/process\.env\.MAI_[A-Z0-9_]+/g) ?? [];
    assert.deepEqual(
      rawMaiReads,
      [],
      `host.ts must have zero raw process.env.MAI_* reads; found: ${rawMaiReads.join(", ")}`,
    );

    // Confirm frondoseEnv is used for the env reads that were swapped
    assert.ok(
      hostSrc.includes('frondoseEnv("PASSIVE_SUGGEST")') || hostSrc.includes("frondoseEnv("),
      "host.ts env reads must go through frondoseEnv() after Step 4 swap",
    );
  });
});
