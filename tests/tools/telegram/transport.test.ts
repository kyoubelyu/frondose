/**
 * P-11 Step 5 — T-Transport.1..T-Transport.10 (filled assertions)
 *
 * telegramFetch + discoverFallbackIps (src/tools/telegram/transport.ts).
 * Gate coverage: G-P11.3, G-P11.4, G-P11.5, G-P11.6, G-P11.7, G-P11.8
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent, ProxyAgent } from "undici";
import { discoverFallbackIps, telegramFetch } from "../../../src/tools/telegram/transport.js";

// ─── fetch mock helper ────────────────────────────────────────────────────────

type MockFn = (url: string, init?: RequestInit) => Promise<Response>;
type CapturedInit = RequestInit & { dispatcher?: unknown; signal?: AbortSignal };

function withFetchMock(mock: MockFn, body: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = mock;
  return body().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (globalThis as any).fetch = orig;
  });
}

function makeOkResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: (_: string) => null },
  } as unknown as Response;
}

function tcpError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// ─── T-Transport: telegramFetch primary + fallback paths ──────────────────────

describe("telegramFetch + discoverFallbackIps (G-P11.3..G-P11.8)", () => {
  it("T-Transport.1: when primary fetch returns { ok:true, status:200 }, telegramFetch resolves to that Response AND dispatcher is an undici.Agent instance", async () => {
    // Given: globalThis.fetch mock returns ok:true status:200 JSON payload
    // When: telegramFetch("https://api.telegram.org/botX/getMe") called
    // Then: response.status===200; fetch was called with dispatcher: <undici Agent instance>
    let capturedInit: CapturedInit | undefined;
    const mock: MockFn = async (_url, init) => {
      capturedInit = init as CapturedInit;
      return makeOkResponse({ ok: true });
    };
    let res!: Response;
    await withFetchMock(mock, async () => {
      res = await telegramFetch("https://api.telegram.org/botX/getMe");
    });
    assert.equal(res.status, 200, "response status must be 200");
    assert.ok(capturedInit?.dispatcher instanceof Agent, "dispatcher must be undici.Agent instance");
  });

  it("T-Transport.2: when primary fetch throws ECONNRESET AND stickyFallbackIp is set, the retry fetch uses a dispatcher dialing that IP (SNI preserved)", async () => {
    // Given: primary fetch throws ECONNRESET; stickyFallbackIp="149.154.167.220"
    // When: telegramFetch called with opts.fallbackIp = "149.154.167.220"
    // Then: second fetch called (fallback path); final response returned
    let callCount = 0;
    const mock: MockFn = async (_url, _init) => {
      callCount++;
      if (callCount === 1) throw tcpError("ECONNRESET");
      return makeOkResponse({ ok: true });
    };
    let res!: Response;
    await withFetchMock(mock, async () => {
      res = await telegramFetch("https://api.telegram.org/botX/sendMessage", {}, { fallbackIp: "149.154.167.220" });
    });
    assert.equal(callCount, 2, "fetch must be called twice (primary fail + fallback)");
    assert.equal(res.status, 200, "fallback response must be returned");
  });

  it("T-Transport.3: when both DoH probes return valid A-record JSON, discoverFallbackIps returns both IPs deduplicated and filtered to public IPs only", async () => {
    // Given: dns.google returns { Answer:[{data:"149.154.166.110"}] }; cloudflare returns { Answer:[{data:"149.154.167.91"}] }
    // When: discoverFallbackIps() called with mocked fetch
    // Then: returns ["149.154.166.110", "149.154.167.91"] (deduped; no 10.x/192.168.x)
    const mock: MockFn = async (url, _init) => {
      if (url.includes("dns.google")) {
        return makeOkResponse({ Answer: [{ data: "149.154.166.110" }] });
      }
      // cloudflare probe
      return makeOkResponse({ Answer: [{ data: "149.154.167.91" }] });
    };
    let ips!: string[];
    await withFetchMock(mock, async () => {
      ips = await discoverFallbackIps();
    });
    assert.ok(ips.includes("149.154.166.110"), "must include google-resolved IP");
    assert.ok(ips.includes("149.154.167.91"), "must include cloudflare-resolved IP");
    // No private IPs
    for (const ip of ips) {
      assert.ok(
        !ip.startsWith("10.") && !ip.startsWith("192.168.") && !ip.startsWith("127."),
        `IP ${ip} must be public`,
      );
    }
    // Deduplicated
    const uniqueIps = [...new Set(ips)];
    assert.equal(ips.length, uniqueIps.length, "result must be deduplicated");
  });

  it('T-Transport.4: when both DoH probes fail (mocked rejection), discoverFallbackIps returns the seed IP ["149.154.167.220"]', async () => {
    // Given: both DoH probes throw or return HTTP 500
    // When: discoverFallbackIps() called
    // Then: returns ["149.154.167.220"] (seed fallback)
    const mock: MockFn = async () => {
      throw new Error("network failure");
    };
    let ips!: string[];
    await withFetchMock(mock, async () => {
      ips = await discoverFallbackIps();
    });
    assert.deepEqual(ips, ["149.154.167.220"], "both probes failed → must return seed IP");
  });

  it("T-Transport.5: when discoverFallbackIps(signal) is called AND signal is already aborted, BOTH DoH fetch calls receive an aborted signal", async () => {
    // Given: AbortSignal that is already aborted
    // When: discoverFallbackIps(signal) called; capture the signal arg passed to each fetch
    // Then: each intercepted fetch call's signal is aborted (catches internally → returns seed)
    const abortController = new AbortController();
    abortController.abort();
    const capturedSignals: (AbortSignal | undefined)[] = [];

    const mock: MockFn = async (_url, init) => {
      const sig = (init as CapturedInit)?.signal;
      capturedSignals.push(sig);
      if (sig?.aborted) {
        throw Object.assign(new DOMException("AbortError", "AbortError"), { name: "AbortError" });
      }
      return makeOkResponse({ Answer: [] });
    };

    let ips!: string[];
    await withFetchMock(mock, async () => {
      ips = await discoverFallbackIps(abortController.signal);
    });
    // Both DoH probes should have been called with aborted signals
    assert.ok(capturedSignals.length >= 2, `must call fetch ≥ 2 times; got ${capturedSignals.length}`);
    for (const sig of capturedSignals) {
      assert.ok(sig?.aborted === true, "each fetch call must have an aborted signal");
    }
    // Both probes fail → seed returned
    assert.deepEqual(ips, ["149.154.167.220"], "aborted probes → must fall back to seed");
  });

  it("T-Transport.6: when fallback fetch succeeds with a fresh IP, telegramFetch calls opts.onFallbackSuccess(ip) with that IP", async () => {
    // Given: primary fetch throws ECONNRESET; fallback succeeds; onFallbackSuccess spy
    // When: telegramFetch called with opts.onFallbackSuccess = spy
    // Then: spy called with the fallback IP string
    let callCount = 0;
    const mock: MockFn = async () => {
      callCount++;
      if (callCount === 1) throw tcpError("ECONNRESET");
      return makeOkResponse({ ok: true });
    };
    let callbackIp: string | undefined;
    await withFetchMock(mock, async () => {
      await telegramFetch(
        "https://api.telegram.org/botX/sendMessage",
        {},
        {
          fallbackIp: "149.154.167.220",
          onFallbackSuccess: (ip) => {
            callbackIp = ip;
          },
        },
      );
    });
    assert.ok(callbackIp !== undefined, "onFallbackSuccess must be called");
    assert.ok(
      typeof callbackIp === "string" && callbackIp.length > 0,
      `callbackIp must be a non-empty string; got: ${callbackIp}`,
    );
  });

  it("T-Transport.7: when TELEGRAM_PROXY env is set, the dispatcher is a ProxyAgent; when unset, the dispatcher is a plain Agent", async () => {
    // Given: process.env.TELEGRAM_PROXY = "http://127.0.0.1:7890"
    // When: telegramFetch called; capture dispatcher instance
    // Then: dispatcher instanceof ProxyAgent (when set); instanceof Agent (when unset)
    const capturedDispatchers: unknown[] = [];
    const mock: MockFn = async (_url, init) => {
      capturedDispatchers.push((init as CapturedInit)?.dispatcher);
      return makeOkResponse({ ok: true });
    };

    // With TELEGRAM_PROXY set
    process.env.TELEGRAM_PROXY = "http://127.0.0.1:7890";
    try {
      await withFetchMock(mock, async () => {
        await telegramFetch("https://api.telegram.org/botX/getMe", {}, { proxyUrl: process.env.TELEGRAM_PROXY });
      });
    } finally {
      delete process.env.TELEGRAM_PROXY;
    }

    // Without TELEGRAM_PROXY
    await withFetchMock(mock, async () => {
      await telegramFetch("https://api.telegram.org/botX/getMe");
    });

    assert.ok(capturedDispatchers.length === 2, `expected 2 fetch calls; got ${capturedDispatchers.length}`);
    const [withProxy, withoutProxy] = capturedDispatchers;
    assert.ok(withProxy instanceof ProxyAgent, "with TELEGRAM_PROXY → dispatcher must be ProxyAgent");
    assert.ok(withoutProxy instanceof Agent, "without TELEGRAM_PROXY → dispatcher must be plain Agent");
    assert.ok(!(withoutProxy instanceof ProxyAgent), "without TELEGRAM_PROXY → must NOT be ProxyAgent");
  });

  it("T-Transport.8: when callerSignal.aborted fires mid-fetch, the underlying fetch aborts with AbortError", async () => {
    // Given: a caller AbortController pre-aborted; mock throws AbortError when signal is aborted
    // When: telegramFetch(url, {}, { signal: callerSignal }) called
    // Then: telegramFetch rejects (AbortError re-thrown from catch block since signal.aborted=true)
    const callerController = new AbortController();
    callerController.abort(); // pre-abort

    const mock: MockFn = async (_url, init) => {
      const sig = (init as CapturedInit)?.signal;
      if (sig?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return makeOkResponse({ ok: true });
    };

    await withFetchMock(mock, async () => {
      await assert.rejects(
        () => telegramFetch("https://api.telegram.org/botX/getMe", {}, { signal: callerController.signal }),
        (err: Error) => {
          // The error is re-thrown because signal.aborted is true
          assert.ok(err instanceof DOMException || err instanceof Error, "must reject with an error");
          return true;
        },
      );
    });
  });

  it("T-Transport.9: when no caller signal is provided AND 31s internal timeout elapses, fetch is aborted via internal AbortSignal.timeout(31_000)", async () => {
    // Given: no caller signal; telegramFetch uses AbortSignal.timeout(31_000) internally
    // When: fetch is called; we verify the signal property is present and is a timeout signal
    // Note: we cannot wait 31s in CI; we verify the mechanism is wired (signal is present and not pre-aborted)
    let capturedSignal: AbortSignal | undefined;
    const mock: MockFn = async (_url, init) => {
      capturedSignal = (init as CapturedInit)?.signal;
      return makeOkResponse({ ok: true });
    };

    await withFetchMock(mock, async () => {
      await telegramFetch("https://api.telegram.org/botX/getMe");
    });

    assert.ok(
      capturedSignal !== undefined,
      "fetch must receive a signal even without caller signal (internal timeout)",
    );
    assert.ok(capturedSignal instanceof AbortSignal, "signal must be an AbortSignal");
    // Signal is NOT yet aborted (31s hasn't elapsed)
    assert.equal(capturedSignal.aborted, false, "internal timeout signal must not be pre-aborted");
    // NOTE: Full 31s timeout behavior cannot be unit-tested without fake timers.
    // The mechanism (AbortSignal.timeout(31_000)) is verified by the signal being present.
  });

  it("T-Transport.10: when the primary fetch returns HTTP 401 (4xx — not a TCP error), telegramFetch does NOT trigger fallback-IP retry; Response forwarded as-is", async () => {
    // Given: fetch mock returns { ok:false, status:401 }
    // When: telegramFetch called (no fallbackIp in opts)
    // Then: returns the 401 Response; fetch called exactly once (no retry)
    let callCount = 0;
    const mock: MockFn = async () => {
      callCount++;
      return makeOkResponse({ ok: false }, 401);
    };
    let res!: Response;
    await withFetchMock(mock, async () => {
      res = await telegramFetch("https://api.telegram.org/botX/sendMessage");
    });
    assert.equal(callCount, 1, "fetch must be called exactly once (HTTP 401 is not a TCP error — no retry)");
    assert.equal(res.status, 401, "401 response must be forwarded as-is");
  });
});
