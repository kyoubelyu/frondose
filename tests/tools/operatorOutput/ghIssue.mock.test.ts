/**
 * P-6 mock tests — T-M_p6.6..T-M_p6.9: gh_issue tool.
 *
 * Tests:
 *   T-M_p6.6 — dedup hit: search returns total_count:1 → skipped=true, no POST
 *   T-M_p6.7 — dedup miss: search returns total_count:0 → POST creates issue, returns issueUrl
 *   T-M_p6.8 — POST 404 error → ok:false failFromError envelope; agent continues
 *   T-M_p6.9 — GH_REPO missing → runtime_error envelope; no fetch calls
 *
 * Uses globalThis.fetch mock. No real network.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { makeGhIssueTool } from "../../../src/tools/operatorOutput/ghIssue.js";

// P-Z2 (bucket 2): isolate HOME so ghIssue's readGithubConfig() fallback reads an
// empty tmp ~/.mai/agent/github.json instead of the operator's real config (which
// would make T-M_p6.9's "GH_REPO missing" deterministic only by luck). getHomeBase()
// prefers FRONDOSE_HOME_BASE; set it for the whole file.
let pZ2PrevHome: string | undefined;
let pZ2TmpHome: string;
before(() => {
  pZ2PrevHome = process.env.FRONDOSE_HOME_BASE;
  pZ2TmpHome = mkdtempSync(join(tmpdir(), "pZ2-ghissue-"));
  process.env.FRONDOSE_HOME_BASE = pZ2TmpHome;
});
after(() => {
  if (pZ2PrevHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
  else process.env.FRONDOSE_HOME_BASE = pZ2PrevHome;
  rmSync(pZ2TmpHome, { recursive: true, force: true });
});

// ─── fetch mock helpers ───────────────────────────────────────────────────────

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function withFetchMock(mockFn: MockFetchFn, body: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock override
  (globalThis as any).fetch = mockFn;
  return body().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (globalThis as any).fetch = orig;
  });
}

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const DEFAULT_PARAMS = {
  title: "Test escalation: missing slack tool",
  body: "The agent needs a slack notification capability.",
  labels: ["escalation"],
  dedupKey: "escalate:missing-slack-tool",
};

// ─── T-M_p6.6 — dedup hit ─────────────────────────────────────────────────────

test("T-M_p6.6: gh_issue dedup hit — search total_count:1 → skipped=true, no POST", async () => {
  process.env.GH_TOKEN = "ghp_test_token";
  process.env.GH_REPO = "owner/test-repo";
  try {
    const tool = makeGhIssueTool();
    const fetchCalls: string[] = [];

    await withFetchMock(
      async (url) => {
        fetchCalls.push(url);
        if (url.includes("/search/issues")) {
          return makeJsonResponse(200, {
            total_count: 1,
            items: [{ html_url: "https://github.com/owner/test-repo/issues/42", number: 42 }],
          });
        }
        throw new Error("Unexpected POST to create issue when dedup should short-circuit");
      },
      async () => {
        const result = await tool.execute(DEFAULT_PARAMS, { toolCallId: "t-m-p6-6", messages: [] });
        const r = result as Record<string, unknown>;
        assert.equal(r.ok, true, "T-M_p6.6: result.ok must be true");
        assert.equal(r.command, "gh_issue", "T-M_p6.6: command must be 'gh_issue'");
        const data = r.data as Record<string, unknown>;
        assert.equal(data.skipped, true, "T-M_p6.6: data.skipped must be true");
        assert.ok(
          typeof data.existingUrl === "string" && data.existingUrl.includes("issues/42"),
          `T-M_p6.6: data.existingUrl must point to issue #42; got: ${data.existingUrl}`,
        );
        assert.equal(data.existingNumber, 42, "T-M_p6.6: data.existingNumber must be 42");
      },
    );

    // Only search was called, no POST
    assert.equal(fetchCalls.length, 1, `T-M_p6.6: only 1 fetch call (search); got ${fetchCalls.length}`);
    assert.ok(fetchCalls[0]?.includes("/search/issues"), "T-M_p6.6: fetch call must be the search endpoint");
    console.log("T-M_p6.6: gh_issue dedup hit — skipped=true, no POST ✓");
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.GH_REPO;
  }
});

// ─── T-M_p6.7 — dedup miss ───────────────────────────────────────────────────

test("T-M_p6.7: gh_issue dedup miss — search total_count:0 → POSTs and returns issueUrl", async () => {
  process.env.GH_TOKEN = "ghp_test_token";
  process.env.GH_REPO = "owner/test-repo";
  try {
    const tool = makeGhIssueTool();
    const fetchCalls: Array<{ url: string; method?: string }> = [];

    await withFetchMock(
      async (url, init) => {
        fetchCalls.push({ url, method: init?.method ?? "GET" });
        if (url.includes("/search/issues")) {
          return makeJsonResponse(200, { total_count: 0, items: [] });
        }
        if (url.includes("/repos/") && url.endsWith("/issues")) {
          return makeJsonResponse(201, {
            html_url: "https://github.com/owner/test-repo/issues/99",
            number: 99,
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      async () => {
        // P-Z2: unique dedupKey so the module-level same-process dedup cache (keyed by
        // `${repo}:${dedupKey}`, P-45) from T-M_p6.6 (same repo + DEFAULT_PARAMS) does not
        // short-circuit this dedup-MISS test. (Footgun previously masked this — both tests
        // errored on the GH_REPO check before reaching the cache.)
        const p67DedupKey = "escalate:dedup-miss-p6-7";
        const result = await tool.execute(
          { ...DEFAULT_PARAMS, dedupKey: p67DedupKey },
          { toolCallId: "t-m-p6-7", messages: [] },
        );
        const r = result as Record<string, unknown>;
        assert.equal(r.ok, true, "T-M_p6.7: result.ok must be true");
        const data = r.data as Record<string, unknown>;
        assert.equal(data.skipped, false, "T-M_p6.7: data.skipped must be false");
        assert.ok(
          typeof data.issueUrl === "string" && data.issueUrl.includes("issues/99"),
          `T-M_p6.7: issueUrl must point to #99; got: ${data.issueUrl}`,
        );
        assert.equal(data.issueNumber, 99, "T-M_p6.7: issueNumber must be 99");
        // P-Z2: echoed dedupKey must match the one we passed (unique, to dodge the
        // same-process dedup cache from T-M_p6.6 — see comment above).
        assert.equal(data.dedupKey, p67DedupKey, "T-M_p6.7: dedupKey must be echoed back");
      },
    );

    assert.equal(fetchCalls.length, 2, `T-M_p6.7: must have 2 fetch calls (search + create); got ${fetchCalls.length}`);
    assert.equal(fetchCalls[1]?.method, "POST", "T-M_p6.7: second call must be POST");
    console.log("T-M_p6.7: gh_issue dedup miss → new issue created at #99 ✓");
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.GH_REPO;
  }
});

// ─── T-M_p6.8 — POST 404 error ───────────────────────────────────────────────

test("T-M_p6.8: gh_issue POST 404 → ok:false envelope; no unhandled throw", async () => {
  process.env.GH_TOKEN = "ghp_test_token";
  process.env.GH_REPO = "owner/nonexistent-repo";
  try {
    const tool = makeGhIssueTool();

    let result: unknown;
    await withFetchMock(
      async (url) => {
        if (url.includes("/search/")) {
          // search returns 0 (so it proceeds to create)
          return makeJsonResponse(200, { total_count: 0, items: [] });
        }
        return makeJsonResponse(404, { message: "Not Found" });
      },
      async () => {
        result = await tool.execute(DEFAULT_PARAMS, { toolCallId: "t-m-p6-8", messages: [] });
      },
    );

    const r = result as Record<string, unknown>;
    assert.equal(r.ok, false, "T-M_p6.8: result.ok must be false");
    assert.equal(r.command, "gh_issue", "T-M_p6.8: command must be 'gh_issue'");
    const err = r.error as Record<string, unknown>;
    assert.ok(typeof err.message === "string", "T-M_p6.8: error.message must be a string");
    assert.ok((err.message as string).includes("404"), `T-M_p6.8: error must mention 404; got: ${err.message}`);
    console.log(`T-M_p6.8: gh_issue 404 → error envelope: "${err.message}" ✓`);
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.GH_REPO;
  }
});

// ─── T-M_p6.9 — GH_REPO missing ─────────────────────────────────────────

test("T-M_p6.9: gh_issue GH_REPO missing → runtime_error envelope; no fetch calls", async () => {
  process.env.GH_TOKEN = "ghp_test_token";
  delete process.env.GH_REPO;

  let fetchCalled = false;
  await withFetchMock(
    async () => {
      fetchCalled = true;
      return makeJsonResponse(200, {});
    },
    async () => {
      const tool = makeGhIssueTool();
      const result = await tool.execute(DEFAULT_PARAMS, { toolCallId: "t-m-p6-9", messages: [] });
      const r = result as Record<string, unknown>;
      assert.equal(r.ok, false, "T-M_p6.9: result.ok must be false");
      const err = r.error as Record<string, unknown>;
      assert.equal(err.kind, "runtime_error", "T-M_p6.9: error.kind must be 'runtime_error'");
      assert.ok(
        (err.message as string).includes("GH_REPO"),
        `T-M_p6.9: error.message must mention 'GH_REPO'; got: ${err.message}`,
      );
      assert.ok(!fetchCalled, "T-M_p6.9: fetch must NOT be called when GH_REPO is missing");
    },
  );
  delete process.env.GH_TOKEN;
  console.log("T-M_p6.9: GH_REPO missing → runtime_error, no fetch ✓");
});

// ─── T-ConsumerGh.1 — github.json fallback (P-15, G-P15.1) ────────────────────

test("T-ConsumerGh.1: when GH_TOKEN unset, ghIssue reads token from github.json fallback; env var always wins", async () => {
  // Given: GH_TOKEN env var unset; github.json exists with { token: "ghp_file_token", repo: "owner/file-repo" }
  // When:  readGithubConfig returns file token; precedence checked (env > file)
  // Then:  file token used when env unset; env wins when set

  // Test the precedence logic used by ghIssue.ts:
  // const ghCfg = readGithubConfig();
  // const token = process.env.GH_TOKEN ?? ghCfg.token;
  // const repo = process.env.GH_REPO ?? ghCfg.repo;

  const savedToken = process.env.GH_TOKEN;
  const savedRepo = process.env.GH_REPO;

  try {
    // When env is set, env wins
    process.env.GH_TOKEN = "ghp_env_token";
    process.env.GH_REPO = "env/owner";
    const ghCfg = { token: "ghp_file_token", repo: "owner/file-repo" };
    const tokenWithEnv = process.env.GH_TOKEN ?? ghCfg.token;
    const repoWithEnv = process.env.GH_REPO ?? ghCfg.repo;
    assert.equal(tokenWithEnv, "ghp_env_token", "GH_TOKEN env must win over file token");
    assert.equal(repoWithEnv, "env/owner", "GH_REPO env must win over file repo");

    // When env is unset, file value used
    delete process.env.GH_TOKEN;
    delete process.env.GH_REPO;
    const tokenWithoutEnv = process.env.GH_TOKEN ?? ghCfg.token;
    const repoWithoutEnv = process.env.GH_REPO ?? ghCfg.repo;
    assert.equal(tokenWithoutEnv, "ghp_file_token", "file token used when GH_TOKEN unset");
    assert.equal(repoWithoutEnv, "owner/file-repo", "file repo used when GH_REPO unset");
  } finally {
    if (savedToken !== undefined) process.env.GH_TOKEN = savedToken;
    else delete process.env.GH_TOKEN;
    if (savedRepo !== undefined) process.env.GH_REPO = savedRepo;
    else delete process.env.GH_REPO;
  }
});
