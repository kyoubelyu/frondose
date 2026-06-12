/**
 * F-REN-3 Step 5 — Filled assertions: T-FREN3.1..T-FREN3.6, T-FREN3.9, T-FREN3.10
 *
 * Back-compat shim unit + precedence + real product-env outcome + Rust↔Node
 * SIDECAR_OWNER lockstep + overlay placeholder guard.
 *
 * Gate coverage:
 *   G-FREN3.back-compat (T-FREN3.1)
 *   G-FREN3.precedence  (T-FREN3.2)
 *   G-FREN3.default     (T-FREN3.3)
 *   G-FREN3.shim        (T-FREN3.4)
 *   G-FREN3.outcome     (T-FREN3.5)
 *   G-FREN3.empty       (T-FREN3.6)
 *   G-FREN3.lockstep    (T-FREN3.9)
 *   G-FREN3.suffix-na   (T-FREN3.10)
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
// T-FREN3.5 exercises this (reads via frondoseEnv("MODEL") after Step 4 swap):
import { resolveModelSpec } from "../../src/agent/modelResolver.js";
import { frondoseEnv } from "../../src/env.js";
// Imports that exist now (production reads go through frondoseEnv after Step 4):
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

describe("frondoseEnv — back-compat: legacy MAI_* resolves via shim fallback (G-FREN3.back-compat)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_HOME_BASE", "FRONDOSE_HOME_BASE");
  });
  afterEach(() => restore());

  it("T-FREN3.1: when MAI_HOME_BASE set + FRONDOSE_HOME_BASE unset, getHomeBase() returns the MAI_ value", () => {
    // Given: process.env.MAI_HOME_BASE = "/tmp/fren3-legacy"; FRONDOSE_HOME_BASE unset
    // When:  getHomeBase() is called (reads via frondoseEnv("HOME_BASE") after Step 4 swap)
    // Then:  returns "/tmp/fren3-legacy" — legacy MAI_* flows through the shim ?? fallback
    process.env.MAI_HOME_BASE = "/tmp/fren3-legacy";
    delete process.env.FRONDOSE_HOME_BASE;

    assert.equal(getHomeBase(), "/tmp/fren3-legacy");
  });
});

// ─── T-FREN3.2 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — FRONDOSE_* takes precedence over MAI_* (G-FREN3.precedence)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_HOME_BASE", "FRONDOSE_HOME_BASE");
  });
  afterEach(() => restore());

  it("T-FREN3.2: when both MAI_HOME_BASE + FRONDOSE_HOME_BASE set, getHomeBase() returns the FRONDOSE_ value", () => {
    // Given: process.env.MAI_HOME_BASE = "/tmp/legacy"; FRONDOSE_HOME_BASE = "/tmp/new"
    // When:  getHomeBase() is called
    // Then:  returns "/tmp/new" (FRONDOSE_ wins via ?? — legacy is present but ignored)
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

describe("frondoseEnv — bare-suffix contract: prefix prepend + ?? ordering (G-FREN3.shim)", () => {
  it("T-FREN3.4: frondoseEnv with injected env — FRONDOSE_ wins over MAI_; MAI_-only returns MAI_ value; {} returns undefined", () => {
    // Given: three injected env objects exercising each ?? branch
    // When:  frondoseEnv("MODEL", injectedEnv) for each
    // Then:  both-set → FRONDOSE_ value; MAI_-only → MAI_ value; empty → undefined

    // Case 1: both set → FRONDOSE_ wins
    assert.equal(
      frondoseEnv("MODEL", { FRONDOSE_MODEL: "deepseek:new", MAI_MODEL: "deepseek:old" }),
      "deepseek:new",
    );

    // Case 2: MAI_-only → returns MAI_ value via ?? fallback
    assert.equal(
      frondoseEnv("MODEL", { MAI_MODEL: "deepseek:legacy" }),
      "deepseek:legacy",
    );

    // Case 3: neither set → returns undefined
    assert.equal(frondoseEnv("MODEL", {}), undefined);
  });
});

// ─── T-FREN3.5 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — outcome-anchored: resolveModelSpec reads env via shim (G-FREN3.outcome)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_MODEL", "FRONDOSE_MODEL");
  });
  afterEach(() => restore());

  it("T-FREN3.5 case 1: when MAI_MODEL set + FRONDOSE_MODEL unset, resolveModelSpec({}) returns the MAI_ value", () => {
    // Given: process.env.MAI_MODEL = "deepseek:legacy"; FRONDOSE_MODEL unset
    // When:  resolveModelSpec({}) is called
    // Then:  returns "deepseek:legacy" — legacy env still configures the model via shim fallback
    delete process.env.FRONDOSE_MODEL;
    process.env.MAI_MODEL = "deepseek:legacy";

    assert.equal(resolveModelSpec({}), "deepseek:legacy");
  });

  it("T-FREN3.5 case 2: when both MAI_MODEL + FRONDOSE_MODEL set, resolveModelSpec({}) returns the FRONDOSE_ value", () => {
    // Given: FRONDOSE_MODEL = "deepseek:new"; MAI_MODEL = "deepseek:legacy"
    // When:  resolveModelSpec({}) is called
    // Then:  returns "deepseek:new" (FRONDOSE_ wins — proves outcome-anchored precedence)
    process.env.MAI_MODEL = "deepseek:legacy";
    process.env.FRONDOSE_MODEL = "deepseek:new";

    assert.equal(resolveModelSpec({}), "deepseek:new");
  });
});

// ─── T-FREN3.6 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — empty-string ?? semantics: explicit empty FRONDOSE_ does NOT fall through (G-FREN3.empty)", () => {
  it("T-FREN3.6: when FRONDOSE_AUTOUPDATE='' + MAI_AUTOUPDATE='skip', frondoseEnv returns '' not 'skip'", () => {
    // Given: injected env { FRONDOSE_AUTOUPDATE: "", MAI_AUTOUPDATE: "skip" }
    // When:  frondoseEnv("AUTOUPDATE", injectedEnv) is called
    // Then:  returns "" — ?? falls through only on undefined, not on empty string;
    //        locking this prevents a future || "simplification" from breaking the operator contract
    const result = frondoseEnv("AUTOUPDATE", { FRONDOSE_AUTOUPDATE: "", MAI_AUTOUPDATE: "skip" });

    assert.equal(result, "");
    assert.notEqual(result, "skip");
  });
});

// ─── T-FREN3.9 ────────────────────────────────────────────────────────────────

describe("frondoseEnv — Rust↔Node SIDECAR_OWNER lockstep: both directions resolve 'frondose-app' (G-FREN3.lockstep)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("MAI_SIDECAR_OWNER", "FRONDOSE_SIDECAR_OWNER");
  });
  afterEach(() => restore());

  it("T-FREN3.9 case 1: FRONDOSE_SIDECAR_OWNER set (renamed Rust) + MAI_ unset → frondoseEnv returns 'frondose-app'", () => {
    // Given: FRONDOSE_SIDECAR_OWNER = "frondose-app" (what the renamed Rust .env() sets); MAI_ unset
    // When:  frondoseEnv("SIDECAR_OWNER") is called (simulating host.ts:13 after Step 4 swap)
    // Then:  returns "frondose-app" — new Rust SET + Node shim in lockstep
    process.env.FRONDOSE_SIDECAR_OWNER = "frondose-app";
    delete process.env.MAI_SIDECAR_OWNER;

    assert.equal(frondoseEnv("SIDECAR_OWNER"), "frondose-app");
  });

  it("T-FREN3.9 case 2: MAI_SIDECAR_OWNER set (legacy Rust not yet rebuilt) + FRONDOSE_ unset → frondoseEnv returns 'frondose-app'", () => {
    // Given: MAI_SIDECAR_OWNER = "frondose-app" (old Rust still setting legacy name); FRONDOSE_ unset
    // When:  frondoseEnv("SIDECAR_OWNER") is called
    // Then:  returns "frondose-app" via ?? MAI_ fallback — proves rename is order-independent
    process.env.MAI_SIDECAR_OWNER = "frondose-app";
    delete process.env.FRONDOSE_SIDECAR_OWNER;

    assert.equal(frondoseEnv("SIDECAR_OWNER"), "frondose-app");
  });
});

// ─── T-FREN3.10 ───────────────────────────────────────────────────────────────

describe("overlay placeholders untouched — __MAI_*__ tokens in host.ts are NOT env vars (G-FREN3.suffix-na)", () => {
  it("T-FREN3.10: host.ts .replace() calls for __MAI_OVERLAY_OWNER__ + __MAI_OVERLAY_VERSION__ + __MAI_PASSIVE_ENABLED__ remain unchanged; only env reads go through frondoseEnv", () => {
    // Given: src/overlay/host.ts source text
    // When:  source scan for placeholder .replace() calls and for raw process.env.MAI_ reads
    // Then:  all three __MAI_*__ placeholder patterns present (F-REN-3 must NOT rename them);
    //        zero raw process.env.MAI_ reads remain in host.ts (they are swapped to frondoseEnv)

    const hostSrc = readFileSync(HOST_TS_PATH, "utf8");

    // All three overlay placeholder tokens must still be present (F-REN-3 must NOT rename them)
    assert.ok(
      hostSrc.includes("__MAI_OVERLAY_OWNER__"),
      "host.ts must still contain __MAI_OVERLAY_OWNER__ placeholder (deferred to F-REN-4)",
    );
    assert.ok(
      hostSrc.includes("__MAI_OVERLAY_VERSION__"),
      "host.ts must still contain __MAI_OVERLAY_VERSION__ placeholder (deferred to F-REN-4)",
    );
    assert.ok(
      hostSrc.includes("__MAI_PASSIVE_ENABLED__"),
      "host.ts must still contain __MAI_PASSIVE_ENABLED__ placeholder (deferred to F-REN-4)",
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
