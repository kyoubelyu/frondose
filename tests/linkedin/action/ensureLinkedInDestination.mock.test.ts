/**
 * Phase native-port-S2 — Step 5 (validator, Sonnet) — assertions filled
 * T-Dest.1–5: `ensureLinkedInDestination` behaviors.
 *
 * Source-under-test: src/linkedin/action/readiness.ts
 *
 * Timing assertions (T-Dest.1 settle, T-Dest.2 settle): the module-local
 * `const sleep = (ms) => new Promise(r => setTimeout(r, ms))` is captured via
 * a globalThis.setTimeout spy that records ms values and runs callbacks at 0ms.
 *
 * Gates covered: §5.A T-Dest.1–5.
 *
 * Runner:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/linkedin/action/ensureLinkedInDestination.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Disable inter-tool pacing for the mock suite.
process.env.FRONDOSE_PACE_MIN_MS = "0";

// ---------------------------------------------------------------------------
// Dynamic loader for readiness.ts
// ---------------------------------------------------------------------------

const READINESS_SPEC = new URL("../../../src/linkedin/action/readiness.js", import.meta.url).href;

type EnsureLinkedInDestinationFn = (client: unknown, dest: string) => Promise<{ url: string; reusedSession: boolean }>;

async function loadReadiness(): Promise<{
  ensureLinkedInDestination: EnsureLinkedInDestinationFn;
}> {
  const mod = (await import(READINESS_SPEC)) as Record<string, unknown>;
  return {
    ensureLinkedInDestination: mod["ensureLinkedInDestination"] as EnsureLinkedInDestinationFn,
  };
}

// ---------------------------------------------------------------------------
// Minimal fake CdpClient for destination tests
// Only getCurrentUrl + navigate are exercised by ensureLinkedInDestination.
// ---------------------------------------------------------------------------

interface FakeDestClientOpts {
  currentUrl: string;
  postNavigateUrl?: string;
  navigateLog: string[];
  navigateShouldThrow?: boolean;
}

function makeFakeDestClient(opts: FakeDestClientOpts): unknown {
  return {
    getCurrentUrl: async () => {
      if (opts.navigateLog.length > 0 && opts.postNavigateUrl) {
        return opts.postNavigateUrl;
      }
      return opts.currentUrl;
    },
    navigate: async (url: string) => {
      opts.navigateLog.push(url);
      if (opts.navigateShouldThrow) {
        throw new Error("navigate: simulated failure");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// setTimeout spy helper
// Runs all sleep callbacks at 0ms (for fast tests) while recording the
// original ms values in sleepLog.
// ---------------------------------------------------------------------------

type OriginalSetTimeout = typeof setTimeout;

function installSleepSpy(): { sleepLog: number[]; restore: () => void } {
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  const orig: OriginalSetTimeout = (globalThis as any).setTimeout;
  const sleepLog: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: spy override
  (globalThis as any).setTimeout = (cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    sleepLog.push(ms ?? 0);
    // biome-ignore lint/suspicious/noExplicitAny: run at 0ms for speed
    return orig(cb as any, 0, ...rest);
  };
  return {
    sleepLog,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (globalThis as any).setTimeout = orig;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — T-Dest.1–5
// ---------------------------------------------------------------------------

describe("ensureLinkedInDestination — already on feed (T-Dest.1)", () => {
  it(
    "T-Dest.1: given currentUrl starts with /feed/ and isSupportedLinkedInSurfaceUrl is true, " +
      "when ensureLinkedInDestination(client,'feed') is called, " +
      "then navigate is called zero times and returns {reusedSession:true,url:currentUrl}",
    async () => {
      // Given: currentUrl is the LinkedIn feed home and no auth interruption.
      // When: ensureLinkedInDestination is called with dest="feed".
      // Then: navigate is NOT called; reusedSession:true; url === currentUrl; one ~300ms settle.
      const { ensureLinkedInDestination } = await loadReadiness();
      const navigateLog: string[] = [];
      const currentUrl = "https://www.linkedin.com/feed/";
      const client = makeFakeDestClient({ currentUrl, navigateLog });

      const { sleepLog, restore } = installSleepSpy();
      let result: { url: string; reusedSession: boolean };
      try {
        result = await ensureLinkedInDestination(client, "feed");
      } finally {
        restore();
      }

      assert.equal(navigateLog.length, 0, "T-Dest.1: navigate must NOT be called when already on feed");
      assert.equal(result.reusedSession, true, "T-Dest.1: reusedSession must be true");
      assert.equal(result.url, currentUrl, "T-Dest.1: url must be the original currentUrl");

      // Timing: exactly one SETTLE_AFTER_NAV_MS=300 sleep (reused-session path)
      assert.equal(sleepLog.length, 1, "T-Dest.1: exactly one sleep (the 300ms settle)");
      assert.ok(
        sleepLog[0] >= 280 && sleepLog[0] <= 350,
        `T-Dest.1: settle sleep must be ~300ms, got ${sleepLog[0]}ms`,
      );
    },
  );
});

describe("ensureLinkedInDestination — navigates when off-destination (T-Dest.2)", () => {
  it(
    "T-Dest.2: given currentUrl is https://www.linkedin.com/jobs/, " +
      "when ensureLinkedInDestination(client,'feed') is called, " +
      "then client.navigate('https://www.linkedin.com/feed/') is called exactly once and returns {reusedSession:false,url:postNavigateUrl}",
    async () => {
      // Given: the page is on /jobs/ (not the feed destination prefix).
      // When: ensureLinkedInDestination is called with dest="feed".
      // Then: navigate fires once with the feed URL; reusedSession:false.
      const { ensureLinkedInDestination } = await loadReadiness();
      const navigateLog: string[] = [];
      const postNavigateUrl = "https://www.linkedin.com/feed/";
      const client = makeFakeDestClient({
        currentUrl: "https://www.linkedin.com/jobs/",
        postNavigateUrl,
        navigateLog,
      });

      const { sleepLog, restore } = installSleepSpy();
      let result: { url: string; reusedSession: boolean };
      try {
        result = await ensureLinkedInDestination(client, "feed");
      } finally {
        restore();
      }

      assert.equal(navigateLog.length, 1, "T-Dest.2: navigate must be called exactly once");
      assert.equal(
        navigateLog[0],
        "https://www.linkedin.com/feed/",
        "T-Dest.2: navigate must target the feed URL prefix",
      );
      assert.equal(result.reusedSession, false, "T-Dest.2: reusedSession must be false after navigate");
      assert.equal(result.url, postNavigateUrl, "T-Dest.2: url must be the post-navigate URL");

      // Timing: one ~300ms settle (navigate path)
      assert.equal(sleepLog.length, 1, "T-Dest.2: exactly one sleep (the 300ms settle after navigate)");
      assert.ok(
        sleepLog[0] >= 280 && sleepLog[0] <= 350,
        `T-Dest.2: settle sleep must be ~300ms, got ${sleepLog[0]}ms`,
      );
    },
  );
});

describe("ensureLinkedInDestination — throws on pre-navigate auth interruption (T-Dest.3)", () => {
  it(
    "T-Dest.3: given isLinkedInAuthInterruptionUrl(currentUrl) is true (e.g. /checkpoint/), " +
      "when ensureLinkedInDestination is called, " +
      "then it throws an Error containing 'auth' or 'checkpoint' and navigate is NEVER called",
    async () => {
      // Given: the page URL is a LinkedIn checkpoint (auth interruption).
      // When: ensureLinkedInDestination is called.
      // Then: throws with auth-related message; navigate is never invoked.
      const { ensureLinkedInDestination } = await loadReadiness();
      const navigateLog: string[] = [];
      const client = makeFakeDestClient({
        currentUrl: "https://www.linkedin.com/checkpoint/challenge",
        navigateLog,
      });

      await assert.rejects(
        async () => {
          await ensureLinkedInDestination(client, "feed");
        },
        (err: unknown) => {
          assert.ok(err instanceof Error, "T-Dest.3: must throw an Error");
          const msg = err.message.toLowerCase();
          assert.ok(
            msg.includes("auth") || msg.includes("checkpoint") || msg.includes("sign-in"),
            `T-Dest.3: error message must mention auth/checkpoint/sign-in, got: "${err.message}"`,
          );
          return true;
        },
      );

      assert.equal(navigateLog.length, 0, "T-Dest.3: navigate must NOT be called on pre-navigate auth interruption");
    },
  );
});

describe("ensureLinkedInDestination — preserves open composer (T-Dest.4)", () => {
  it(
    "T-Dest.4: given currentUrl is /feed/ and a composer is already open, " +
      "when ensureLinkedInDestination(client,'feed') is called, " +
      "then navigate is called zero times (composer preserved — Spike-3 contract pin)",
    async () => {
      // Given: the page is already on /feed/ and a composer modal is open.
      // When: ensureLinkedInDestination is called with dest="feed".
      // Then: navigate fires zero times (existing session reused); composer unaffected.
      const { ensureLinkedInDestination } = await loadReadiness();
      const navigateLog: string[] = [];
      // Even with a query string (e.g. the composer-open URL variant), /feed/ prefix matches.
      const client = makeFakeDestClient({
        currentUrl: "https://www.linkedin.com/feed/?shareActive=true",
        navigateLog,
      });

      const { restore } = installSleepSpy();
      let result: { url: string; reusedSession: boolean };
      try {
        result = await ensureLinkedInDestination(client, "feed");
      } finally {
        restore();
      }

      assert.equal(navigateLog.length, 0, "T-Dest.4: navigate must NOT fire when URL starts with /feed/");
      assert.equal(result.reusedSession, true, "T-Dest.4: reusedSession must be true — composer preserved");
    },
  );
});

describe("ensureLinkedInDestination — throws on post-navigate auth interruption (T-Dest.5)", () => {
  it(
    "T-Dest.5: given the post-navigate getCurrentUrl() resolves to a checkpoint URL, " +
      "when ensureLinkedInDestination is called, " +
      "then the function throws an Error containing 'auth'",
    async () => {
      // Given: page starts off-feed; navigate succeeds but lands on a checkpoint URL.
      // When: ensureLinkedInDestination is called.
      // Then: throws with auth-related message after the navigate.
      const { ensureLinkedInDestination } = await loadReadiness();
      const navigateLog: string[] = [];
      const client = makeFakeDestClient({
        currentUrl: "https://www.linkedin.com/jobs/",
        postNavigateUrl: "https://www.linkedin.com/checkpoint/challenge",
        navigateLog,
      });

      const { restore } = installSleepSpy();
      try {
        await assert.rejects(
          async () => {
            await ensureLinkedInDestination(client, "feed");
          },
          (err: unknown) => {
            assert.ok(err instanceof Error, "T-Dest.5: must throw an Error");
            const msg = err.message.toLowerCase();
            assert.ok(
              msg.includes("auth") || msg.includes("checkpoint") || msg.includes("sign-in"),
              `T-Dest.5: error message must mention auth/checkpoint/sign-in, got: "${err.message}"`,
            );
            return true;
          },
        );
      } finally {
        restore();
      }

      // navigate WAS called (we navigated then hit auth on the post-nav URL check)
      assert.equal(navigateLog.length, 1, "T-Dest.5: navigate must have been called before the post-nav auth check");
    },
  );
});
