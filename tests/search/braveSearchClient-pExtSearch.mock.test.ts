import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  BRAVE_SEARCH_API_URL,
  BRAVE_SEARCH_INTERVAL_MS,
  BRAVE_SEARCH_RAW_ENTRY_LIMIT,
  BRAVE_SEARCH_RAW_TEXT_LIMIT,
  callBraveWebSearch,
  resetBraveSearchLimiterForTest,
  type BraveSearchDeps,
} from "../../src/search/braveSearchClient.js";

/**
 * P-EXT-SEARCH scaffold (Step 2, RED against 0.5.25): direct Brave Search API client.
 * Fixtures mirror the real Brave API JSON shape (web.results[]). ALL network fixtures
 * are injected through deps.fetchImpl — the implementation never touches globalThis.fetch
 * in tests (Step-3a BLOCKER-2 fix).
 */
const API_KEY = "bsa_live_scaffold_key_123";
const QUERY = "vercel ai sdk";

function braveJson(results: Array<{ title?: unknown; url?: unknown; description?: unknown }>) {
  return { web: { results } };
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

/** Test clock + recorded fetch double. */
function makeDeps(clock: { value: number }, fetchImpl: typeof fetch): { deps: BraveSearchDeps; calls: Call[] } {
  const calls: Call[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {}, at: clock.value });
    return fetchImpl(input, init);
  };
  return {
    calls,
    deps: {
      fetchImpl: recordingFetch,
      now: () => clock.value,
      sleep: async (ms: number) => {
        clock.value += ms;
      },
    },
  };
}

const successFetch = async (): Promise<Response> =>
  okResponse(
    braveJson([
      { title: "AI SDK", url: "https://vercel.com/docs/ai-sdk", description: "Docs" },
      { title: "Vercel", url: "https://vercel.com", description: "Home" },
      { title: "x", url: "https://x.test", description: "d" },
    ]),
  );

describe("P-EXT-SEARCH Brave client — fetch behavior", () => {
  beforeEach(() => {
    resetBraveSearchLimiterForTest();
  });

  it("T-Brave.Fetch.1: given a valid Brave JSON response, returns ok:true with mapped results capped at maxResults", async () => {
    // Given: a fetch double returning web.results[3] for maxResults 2.
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, successFetch);
    // When: the client is called with maxResults 2.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 2 }, deps);
    // Then: ok:true, exactly 2 mapped results, command web_search.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.command, "web_search");
      assert.equal(result.data.results.length, 2);
      assert.deepEqual(result.data.results[0], {
        title: "AI SDK",
        url: "https://vercel.com/docs/ai-sdk",
        description: "Docs",
      });
      assert.equal(result.data.query, QUERY);
      assert.equal(result.data.raw.truncated, false);
    }
  });

  it("T-Brave.Fetch.2: issues a GET to the pinned Brave API URL with auth header and query params", async () => {
    // Given: a fetch double.
    const clock = { value: 0 };
    const { deps, calls } = makeDeps(clock, successFetch);
    // When: the client is called.
    await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: exactly one GET to BRAVE_SEARCH_API_URL with X-Subscription-Token and q/count/result_filter params.
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, BRAVE_SEARCH_API_URL);
    assert.equal(url.searchParams.get("q"), QUERY);
    assert.equal(url.searchParams.get("count"), "3");
    assert.equal(url.searchParams.get("result_filter"), "web");
    assert.equal(calls[0].init.method, "GET");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["X-Subscription-Token"], API_KEY);
    assert.match(headers["Accept"] ?? "", /json/);
  });

  it("T-Brave.Fetch.3: HTTP 429 returns search_error with a rate-limit message and no key leakage", async () => {
    // Given: a fetch double returning 429.
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () => okResponse({}, 429));
    // When: the client is called.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: ok:false kind search_error, message mentions 429, and the apiKey never appears.
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "search_error");
      assert.match(result.error.message, /429/i);
      assert.ok(!JSON.stringify(result).includes(API_KEY), "apiKey must be redacted from the envelope");
    }
  });

  it("T-Brave.Fetch.4: HTTP 500 returns the transient 5xx kind", async () => {
    // Given: a fetch double returning 500.
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () => okResponse({}, 500));
    // When: the client is called.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: kind 5xx.
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "5xx");
  });

  it("T-Brave.Status.1: other non-2xx statuses (e.g. 403) return search_error", async () => {
    // Given: a fetch double returning 403.
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () => okResponse({}, 403));
    // When: the client is called.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: kind search_error with the status in the message.
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "search_error");
      assert.match(result.error.message, /403/);
    }
  });

  it("T-Brave.Fetch.5: a network-level fetch rejection returns the transient network kind", async () => {
    // Given: a fetch double that rejects.
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    // When: the client is called.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: kind network.
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "network");
  });

  it("T-Brave.Timeout.1: the fetch receives a live signal that aborts at the configured timeout; the caller signal is preserved", async () => {
    // Given: a short injected timeout (deps.timeoutMs) and a fetch double that captures the signal and waits for it.
    const clock = { value: 0 };
    let capturedSignal: AbortSignal | undefined;
    let signalAbortedAt = 0;
    const { deps } = makeDeps(clock, async (_input, init) => {
      capturedSignal = init?.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        capturedSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      signalAbortedAt = Date.now();
      throw new Error(`aborted: ${String(capturedSignal.reason)}`);
    });
    // When: the client is called with timeoutMs 40.
    const startedAt = Date.now();
    const result = await callBraveWebSearch(
      { apiKey: API_KEY, query: QUERY, maxResults: 3 },
      { ...deps, timeoutMs: 40 },
    );
    // Then: the fetch received a real signal that aborted on its own (not a pre-created TimeoutError), quickly.
    assert.ok(capturedSignal, "the fetch must receive an abort signal");
    assert.ok(signalAbortedAt > 0, "the timeout signal must actually abort the fetch");
    assert.ok(signalAbortedAt - startedAt < 1000, "the injected timeout must fire promptly");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "network");
  });

  it("T-Brave.Timeout.2: aborting the caller signal propagates to the fetch signal and yields a graceful network envelope", async () => {
    // Given: a fetch double that captures the merged signal.
    const clock = { value: 0 };
    let capturedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const { deps } = makeDeps(clock, async (_input, init) => {
      capturedSignal = init?.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        capturedSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error(`aborted: ${String(capturedSignal.reason)}`);
    });
    // When: the client is called with the caller signal, and the caller aborts mid-flight.
    const pending = callBraveWebSearch(
      { apiKey: API_KEY, query: QUERY, maxResults: 3, abortSignal: controller.signal },
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("operator cancelled"));
    const result = await pending;
    // Then: the merged signal aborted because of the CALLER (preservation), and the envelope is graceful network.
    assert.ok(capturedSignal?.aborted, "the caller abort must propagate to the fetch signal");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "network");
  });

  it("T-Brave.Fetch.6: malformed payloads (bad JSON, missing web.results, missing fields, empty description) return search_error", async () => {
    // Given: fetch doubles returning four malformed payloads (empty description is invalid per plan §5).
    const clock = { value: 0 };
    const malformed = [
      new Response("not json", { status: 200 }),
      okResponse({ web: {} }),
      okResponse(braveJson([{ title: "t" }])),
      okResponse(braveJson([{ title: "t", url: "https://x", description: "" }])),
    ];
    let i = 0;
    const { deps } = makeDeps(clock, async () => malformed[i++]);
    // When: the client is called for each malformed payload.
    for (let n = 0; n < malformed.length; n++) {
      const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
      // Then: kind search_error each time.
      assert.equal(result.ok, false, `case ${n} must fail`);
      if (!result.ok) assert.equal(result.error.kind, "search_error");
    }
  });

  it("T-Brave.Fetch.7: an already-aborted signal yields a graceful network envelope with no fetch", async () => {
    // Given: an already-aborted AbortSignal and a fetch spy.
    const clock = { value: 0 };
    const { deps, calls } = makeDeps(clock, successFetch);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    // When: the client is called with the aborted signal.
    const result = await callBraveWebSearch(
      { apiKey: API_KEY, query: QUERY, maxResults: 3, abortSignal: controller.signal },
      deps,
    );
    // Then: graceful network envelope and zero fetch calls.
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "network");
    assert.equal(calls.length, 0);
  });

  it("T-Brave.Fetch.8: the apiKey never appears in success results, raw entries, or any error envelope", async () => {
    // Given: a successful payload whose title/url/description/extra fields embed the apiKey,
    //       plus hostile error responses that echo the key back or reject with the key in the message.
    const clock = { value: 0 };
    const success = okResponse(
      braveJson([
        { title: `title ${API_KEY}`, url: `https://x.test/${API_KEY}`, description: `desc ${API_KEY}` },
        { title: "ok", url: "https://y.test", description: "fine" },
      ]),
    );
    const payloads = [
      success,
      new Response(`leaked ${API_KEY} in body`, { status: 502 }),
      new Response("plain", { status: 502 }),
    ];
    let i = 0;
    const { deps } = makeDeps(clock, async () => {
      if (i === 3) throw new Error(`connection to ${API_KEY} refused`);
      return payloads[i++] as Response;
    });
    // When: the client is called against the success payload and the hostile responses.
    const first = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: the success envelope is fully redacted of the key (results AND raw entries).
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.ok(!JSON.stringify(first.data).includes(API_KEY), "apiKey leaked into normalized results/raw");
      assert.ok(!first.data.results.some((r) => JSON.stringify(r).includes(API_KEY)), "apiKey leaked into a result");
      assert.ok(!first.data.raw.entries.some((e) => e.includes(API_KEY)), "apiKey leaked into raw entries");
    }
    // And: hostile error envelopes are redacted too.
    for (let n = 0; n < 3; n++) {
      const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
      assert.equal(result.ok, false, `case ${n} must fail`);
      assert.ok(!JSON.stringify(result).includes(API_KEY), `case ${n}: apiKey leaked into the envelope`);
    }
  });
});

describe("P-EXT-SEARCH Brave client — bounds, query handling, pacing", () => {
  beforeEach(() => {
    resetBraveSearchLimiterForTest();
  });

  it("T-Brave.Bounds.1: title/url length caps, raw entry cap, and truncation flags apply deterministically", async () => {
    // Given: a payload with a 301-char title, a 2049-char URL, and 11 results.
    const longTitle = "t".repeat(301);
    const longUrl = `https://x.test/${"u".repeat(2037)}`;
    const results = Array.from({ length: 11 }, (_, idx) => ({
      title: idx === 0 ? longTitle : `t${idx}`,
      url: idx === 0 ? longUrl : `https://r${idx}.test`,
      description: "d",
    }));
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () => okResponse(braveJson(results)));
    // When: the client is called with maxResults 10.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 10 }, deps);
    // Then: caps apply (title 300, url 2048), raw entries capped at RAW_ENTRY_LIMIT, truncated flags set.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.results.length, 10);
      assert.equal(result.data.results[0].title.length, 300);
      assert.equal(result.data.results[0].url.length, 2048);
      assert.equal(result.data.raw.entries.length, BRAVE_SEARCH_RAW_ENTRY_LIMIT);
      assert.equal(result.data.raw.truncated, true, "11 results must set the truncated flag");
    }
  });

  it("T-Brave.Bounds.2: a raw entry exceeding the text cap sets the truncated flag and is cut at the cap", async () => {
    // Given: a payload whose first result description is 3000 chars (larger than the raw text cap).
    const clock = { value: 0 };
    const { deps } = makeDeps(clock, async () =>
      okResponse(braveJson([{ title: "t", url: "https://x.test", description: "d".repeat(3000) }])),
    );
    // When: the client is called.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
    // Then: every raw entry is <= RAW_TEXT_LIMIT and truncated is true.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.data.raw.entries.every((e) => e.length <= BRAVE_SEARCH_RAW_TEXT_LIMIT));
      assert.equal(result.data.raw.truncated, true);
    }
  });

  it("T-Brave.Query.1: the query is trimmed before use and echoed trimmed", async () => {
    // Given: a query with surrounding whitespace.
    const clock = { value: 0 };
    const { deps, calls } = makeDeps(clock, successFetch);
    // When: the client is called with '  hello world  '.
    const result = await callBraveWebSearch({ apiKey: API_KEY, query: "  hello world  ", maxResults: 3 }, deps);
    // Then: the request uses the trimmed query and the envelope echoes it trimmed.
    assert.equal(result.ok, true);
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("q"), "hello world");
    if (result.ok) assert.equal(result.data.query, "hello world");
  });

  it("T-Brave.Rate.1: concurrent calls start at least 3000ms apart and the chain recovers after a failure", async () => {
    // Given: a test clock, sleep that advances the clock, and a fetch double recording start times; the first call fails.
    const clock = { value: 1_000_000 };
    const starts: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      starts.push(clock.value);
      if (starts.length === 1) throw new Error("boom");
      return okResponse(braveJson([{ title: "t", url: "https://x.test", description: "d" }]));
    };
    const deps: BraveSearchDeps = {
      fetchImpl,
      now: () => clock.value,
      sleep: async (ms: number) => {
        clock.value += ms;
      },
    };
    // When: three calls are fired concurrently.
    const results = await Promise.all([
      callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps),
      callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps),
      callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps),
    ]);
    // Then: all three settle (first fails, later succeed) and spacing is steady at INTERVAL_MS
    // (audit MR: exact spacing — a double-counted clock would produce growing gaps 3000/6000/9000).
    assert.equal(starts.length, 3, "one failure must not permanently block the limiter chain");
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
    assert.equal(results[2].ok, true);
    assert.equal(starts[1] - starts[0], BRAVE_SEARCH_INTERVAL_MS, `second call must start exactly INTERVAL_MS later: ${starts.join(",")}`);
    assert.equal(starts[2] - starts[1], BRAVE_SEARCH_INTERVAL_MS, `third call must start exactly INTERVAL_MS later: ${starts.join(",")}`);
  });

  it("T-Brave.Rate.3: four sequential calls keep steady 3000ms pacing with no accumulated drift", async () => {
    // Given: a test clock and a fetch double recording start times.
    const clock = { value: 1_000_000 };
    const starts: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      starts.push(clock.value);
      return okResponse(braveJson([{ title: "t", url: "https://x.test", description: "d" }]));
    };
    const deps: BraveSearchDeps = {
      fetchImpl,
      now: () => clock.value,
      sleep: async (ms: number) => {
        clock.value += ms;
      },
    };
    // When: four calls are fired in sequence (each awaiting the previous).
    for (let i = 0; i < 4; i++) {
      const result = await callBraveWebSearch({ apiKey: API_KEY, query: QUERY, maxResults: 3 }, deps);
      assert.equal(result.ok, true);
    }
    // Then: start times are [0, 3000, 6000, 9000] relative — no 3s/6s/9s accumulation.
    const base = starts[0];
    assert.deepEqual(
      starts.map((s) => s - base),
      [0, BRAVE_SEARCH_INTERVAL_MS, BRAVE_SEARCH_INTERVAL_MS * 2, BRAVE_SEARCH_INTERVAL_MS * 3],
      `spacing must stay steady: ${starts.map((s) => s - base).join(",")}`,
    );
  });

  it("T-Brave.Rate.2: an empty apiKey returns missing_config without any fetch", async () => {
    // Given: a fetch spy and an empty key.
    const clock = { value: 0 };
    const { deps, calls } = makeDeps(clock, successFetch);
    // When: the client is called with an empty key.
    const result = await callBraveWebSearch({ apiKey: "   ", query: QUERY, maxResults: 3 }, deps);
    // Then: missing_config and zero fetch calls.
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, "missing_config");
      assert.match(result.error.message, /Brave/i);
    }
    assert.equal(calls.length, 0);
  });
});
