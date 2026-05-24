/**
 * P-58a Step 4a — T-Lock.1..5 — SCAFFOLD (assertion bodies = TODO; intentionally RED).
 *
 * F-PROFILE-LOCK self-heal (plan §6.4-A): `clearStaleSingletonLocks(profileDir, killFn=process.kill)` unlinks
 * Singleton{Lock,Cookie,Socket} ONLY when the lock's owner pid is DEAD (process.kill(pid,0) throws ESRCH).
 * A LIVE owner (no throw) OR EPERM (alive-but-not-ours — the shared-symlinked-profile safety) → KEEP everything.
 * fs + process.kill ONLY (no child_process; src/cdp/ infra, not src/tools/**). DI `killFn` for determinism —
 * NEVER touches a real Chrome / the operator profile.
 *
 * LOAD: GATE-ON-BUILDER. `src/cdp/profileLock.ts` is NEW (builder 4b B1). Captured via a try/catch dynamic
 * import in before(); undefined until 4b → every body is `assert.fail("TODO Step 5: …")`.
 *
 * Gate coverage: G-P58a.1 (self-heal: dead→clear, alive/EPERM→keep, no/malformed symlink→no-op, fs+kill only).
 *
 * Run (mock): node --import tsx --test --test-force-exit --test-timeout=30000 \
 *   tests/cdp/profileLock-p58a.mock.test.ts
 */

import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// gate-on-builder: profileLock.ts does not exist until 4b. NOTE: the builder implemented it ASYNC
// (node:fs/promises; returns Promise<void>) — awaited at the ensureChrome call site (launcher.ts:102).
let clearStaleSingletonLocks:
  | ((profileDir: string, killFn?: (pid: number, signal: 0) => void) => Promise<void>)
  | undefined;

before(async () => {
  try {
    // Non-literal specifier: tsc can't statically resolve the not-yet-existing module (no TS2307 at 4a);
    // node/tsx resolves the relative path against import.meta.url at runtime once builder 4b creates it.
    const spec = "../../src/cdp/profileLock.js";
    const mod = await import(spec);
    clearStaleSingletonLocks = (mod as { clearStaleSingletonLocks?: typeof clearStaleSingletonLocks })
      .clearStaleSingletonLocks;
  } catch {
    // profileLock.ts not built yet (pre-4b) — bodies are assert.fail TODO regardless.
  }
});

/** A throwaway temp profile dir with a SingletonLock symlink → `target` (+ sibling Cookie/Socket files). */
function makeProfile(target?: string, withSiblings = true): string {
  const dir = mkdtempSync(join(tmpdir(), "p58a-lock-"));
  if (target !== undefined) symlinkSync(target, join(dir, "SingletonLock")); // dangling symlink is fine
  if (withSiblings) {
    writeFileSync(join(dir, "SingletonCookie"), "c");
    writeFileSync(join(dir, "SingletonSocket"), "s");
  }
  return dir;
}
/** lstat-based existence (does NOT follow the symlink → a dangling SingletonLock still counts as present). */
function lexists(dir: string, f: string): boolean {
  try {
    lstatSync(join(dir, f));
    return true;
  } catch {
    return false;
  }
}
const killDead = (): void => {
  throw Object.assign(new Error("no such process"), { code: "ESRCH" });
};
const killAlive = (): void => {
  /* returns = pid alive */
};
const killEperm = (): void => {
  throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
};

describe("clearStaleSingletonLocks — dead owner pid clears all three (G-P58a.1)", () => {
  // Given: SingletonLock → "host-999999999" (+ Cookie/Socket) and a killFn that throws ESRCH (dead).
  // When:  clearStaleSingletonLocks(dir, killDead).
  // Then:  none of SingletonLock/Cookie/Socket exist afterwards.
  it("T-Lock.1: dead pid (ESRCH) → unlinks SingletonLock + SingletonCookie + SingletonSocket", async () => {
    assert.ok(clearStaleSingletonLocks, "builder 4b must export clearStaleSingletonLocks");
    const dir = makeProfile("host-999999999");
    await clearStaleSingletonLocks(dir, killDead);
    assert.ok(!lexists(dir, "SingletonLock"), "dead-owner SingletonLock removed");
    assert.ok(!lexists(dir, "SingletonCookie"), "SingletonCookie removed");
    assert.ok(!lexists(dir, "SingletonSocket"), "SingletonSocket removed");
  });
});

describe("clearStaleSingletonLocks — alive owner pid keeps everything (G-P58a.1)", () => {
  // Given: SingletonLock → "host-4242" and a killFn that returns (no throw = alive).
  // When:  clearStaleSingletonLocks(dir, killAlive).
  // Then:  SingletonLock still exists (nothing unlinked — never stomp a live owner).
  it("T-Lock.2: alive pid (no throw) → keeps the lock (the live-owner safety)", async () => {
    assert.ok(clearStaleSingletonLocks, "builder 4b must export clearStaleSingletonLocks");
    const dir = makeProfile("host-4242");
    await clearStaleSingletonLocks(dir, killAlive);
    assert.ok(lexists(dir, "SingletonLock"), "live-owner lock kept (never stomped)");
    assert.ok(lexists(dir, "SingletonCookie"), "SingletonCookie kept");
    assert.ok(lexists(dir, "SingletonSocket"), "SingletonSocket kept");
  });
});

describe("clearStaleSingletonLocks — EPERM (alive-but-not-ours) keeps everything (G-P58a.1)", () => {
  // Given: a killFn that throws EPERM (the shared-symlinked-profile safety: a live Chrome we can't signal).
  // When:  clearStaleSingletonLocks(dir, killEperm).
  // Then:  the files are KEPT (EPERM treated as alive).
  it("T-Lock.3: EPERM → keeps (treated as alive — shared-profile safety guard)", async () => {
    assert.ok(clearStaleSingletonLocks, "builder 4b must export clearStaleSingletonLocks");
    const dir = makeProfile("host-4242");
    await clearStaleSingletonLocks(dir, killEperm);
    assert.ok(lexists(dir, "SingletonLock"), "EPERM (alive-but-not-ours) → lock kept");
    assert.ok(lexists(dir, "SingletonCookie"), "SingletonCookie kept");
    assert.ok(lexists(dir, "SingletonSocket"), "SingletonSocket kept");
  });
});

describe("clearStaleSingletonLocks — no SingletonLock is a no-op (G-P58a.1)", () => {
  // Given: an empty temp dir (no SingletonLock symlink).
  // When:  clearStaleSingletonLocks(dir).
  // Then:  it returns without throwing (and removes nothing — the siblings, if any, stay).
  it("T-Lock.4: no SingletonLock symlink → no-op, no throw", async () => {
    assert.ok(clearStaleSingletonLocks, "builder 4b must export clearStaleSingletonLocks");
    const clear = clearStaleSingletonLocks;
    const dir = makeProfile(undefined, true); // siblings present but NO SingletonLock symlink
    await assert.doesNotReject(() => clear(dir), "no lock to resolve → no throw");
    assert.ok(lexists(dir, "SingletonCookie"), "siblings untouched when there is no lock to resolve");
    assert.ok(lexists(dir, "SingletonSocket"), "siblings untouched");
  });
});

describe("clearStaleSingletonLocks — malformed target (no parseable pid) is a no-op (G-P58a.1)", () => {
  // Given: SingletonLock → "garbage-no-pid-x" (trailing token not an integer → NaN/≤0).
  // When:  clearStaleSingletonLocks(dir, killDead).
  // Then:  nothing is unlinked (the malformed-pid guard makes a wrong parse SAFE — falls back to today's behavior).
  it("T-Lock.5: malformed symlink target (non-integer pid) → no-op (NaN/≤0 guard)", async () => {
    assert.ok(clearStaleSingletonLocks, "builder 4b must export clearStaleSingletonLocks");
    const dir = makeProfile("garbage-no-pid-x"); // trailing token not an integer → NaN guard
    await clearStaleSingletonLocks(dir, killDead);
    assert.ok(lexists(dir, "SingletonLock"), "malformed pid → safe no-op (lock kept, falls back to today's behavior)");
    assert.ok(lexists(dir, "SingletonCookie"), "siblings kept");
  });
});
