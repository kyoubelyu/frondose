/**
 * P-6 mock tests — T-M_p6.1..T-M_p6.5: telegram_notify tool.
 *
 * Tests:
 *   T-M_p6.1 — success path: mock fetch returns ok → tool returns ok envelope + messageId
 *   T-M_p6.2 — severity emoji prefix: info/warning/error produce ℹ️/⚠️/🚨 prefixes
 *   T-M_p6.3 — HTTP 400 error: tool returns failFromError envelope; no throw
 *   T-M_p6.4 — TELEGRAM_TOKEN missing: tool returns runtime_error envelope
 *   T-M_p6.5 — audit redaction: TELEGRAM_TOKEN never appears in tool input/envelope
 *
 * Uses globalThis.fetch mock. No real network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeTelegramNotifyTool } from "../../../src/tools/operatorOutput/telegram.js";

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

function makeTgSuccessResponse(messageId: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
  } as unknown as Response;
}

function makeTgErrorResponse(status: number, description?: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, description: description ?? `Error ${status}` }),
  } as unknown as Response;
}

// ─── T-M_p6.1 — success path ─────────────────────────────────────────────────

test("T-M_p6.1: telegram_notify returns ok envelope with messageId on success", async () => {
  process.env.TELEGRAM_TOKEN = "test-token-abc";
  process.env.TELEGRAM_CHAT_ID = "999";
  try {
    const tool = makeTelegramNotifyTool();
    const capturedUrls: string[] = [];

    await withFetchMock(
      async (url) => {
        capturedUrls.push(url);
        return makeTgSuccessResponse(12345);
      },
      async () => {
        const result = await tool.execute(
          { body: "hello from test", severity: "info" },
          { toolCallId: "t-m-p6-1", messages: [] },
        );
        const r = result as Record<string, unknown>;
        assert.equal(r.ok, true, "T-M_p6.1: result.ok must be true");
        assert.equal(r.command, "telegram_notify", "T-M_p6.1: result.command must be 'telegram_notify'");
        const data = r.data as Record<string, unknown>;
        assert.equal(data.messageId, 12345, "T-M_p6.1: data.messageId must be 12345");
        assert.equal(data.severity, "info", "T-M_p6.1: data.severity must be 'info'");
      },
    );

    // URL must embed token but NEVER appear in the tool envelope (audit safe)
    assert.ok(capturedUrls[0]?.includes("test-token-abc"), "T-M_p6.1: fetch URL must include TELEGRAM_TOKEN");
    console.log("T-M_p6.1: telegram_notify ok envelope + messageId ✓");
  } finally {
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});

// ─── T-M_p6.2 — severity emoji prefix ────────────────────────────────────────

test("T-M_p6.2: telegram_notify severity emoji: info=ℹ️ warning=⚠️ error=🚨", async () => {
  process.env.TELEGRAM_TOKEN = "tok";
  process.env.TELEGRAM_CHAT_ID = "1";
  try {
    const tool = makeTelegramNotifyTool();
    const capturedBodies: string[] = [];

    const mockFetch: MockFetchFn = async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { text?: string };
      capturedBodies.push(body.text ?? "");
      return makeTgSuccessResponse(1);
    };

    await withFetchMock(mockFetch, async () => {
      for (const sev of ["info", "warning", "error"] as const) {
        await tool.execute({ body: "test body", severity: sev }, { toolCallId: `t-m-p6-2-${sev}`, messages: [] });
      }
    });

    assert.ok(capturedBodies[0]?.startsWith("ℹ️"), `T-M_p6.2: info must start with ℹ️; got: "${capturedBodies[0]}"`);
    assert.ok(capturedBodies[1]?.startsWith("⚠️"), `T-M_p6.2: warning must start with ⚠️; got: "${capturedBodies[1]}"`);
    assert.ok(capturedBodies[2]?.startsWith("🚨"), `T-M_p6.2: error must start with 🚨; got: "${capturedBodies[2]}"`);
    console.log("T-M_p6.2: severity emoji prefixes verified ✓");
  } finally {
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});

// ─── T-M_p6.3 — HTTP 400 error ───────────────────────────────────────────────

test("T-M_p6.3: telegram_notify HTTP 400 → ok:false envelope; no unhandled throw", async () => {
  process.env.TELEGRAM_TOKEN = "bad-token";
  process.env.TELEGRAM_CHAT_ID = "1";
  try {
    const tool = makeTelegramNotifyTool();
    let result: unknown;

    await withFetchMock(
      async () => makeTgErrorResponse(400, "Bad Request"),
      async () => {
        result = await tool.execute({ body: "test", severity: "info" }, { toolCallId: "t-m-p6-3", messages: [] });
      },
    );

    const r = result as Record<string, unknown>;
    assert.equal(r.ok, false, "T-M_p6.3: result.ok must be false");
    assert.equal(r.command, "telegram_notify", "T-M_p6.3: command must be 'telegram_notify'");
    const err = r.error as Record<string, unknown>;
    assert.ok(typeof err.message === "string", "T-M_p6.3: error.message must be a string");
    assert.ok(
      (err.message as string).includes("400"),
      `T-M_p6.3: error.message must include '400'; got: ${err.message}`,
    );
    console.log(`T-M_p6.3: HTTP 400 → error envelope: "${err.message}" ✓`);
  } finally {
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});

// ─── T-M_p6.4 — TELEGRAM_TOKEN missing ───────────────────────────────────────

test("T-M_p6.4: telegram_notify TELEGRAM_TOKEN missing → runtime_error envelope; no fetch call", async () => {
  delete process.env.TELEGRAM_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  let fetchCalled = false;
  await withFetchMock(
    async () => {
      fetchCalled = true;
      return makeTgSuccessResponse(1);
    },
    async () => {
      const tool = makeTelegramNotifyTool();
      const result = await tool.execute(
        { body: "test", severity: "warning" },
        { toolCallId: "t-m-p6-4", messages: [] },
      );
      const r = result as Record<string, unknown>;
      assert.equal(r.ok, false, "T-M_p6.4: result.ok must be false");
      const err = r.error as Record<string, unknown>;
      assert.equal(err.kind, "runtime_error", "T-M_p6.4: error.kind must be 'runtime_error'");
      assert.ok(
        (err.message as string).includes("TELEGRAM_TOKEN"),
        `T-M_p6.4: error.message must mention 'TELEGRAM_TOKEN'; got: ${err.message}`,
      );
      assert.ok(!fetchCalled, "T-M_p6.4: fetch must NOT be called when token is missing");
    },
  );
  console.log("T-M_p6.4: TELEGRAM_TOKEN missing → runtime_error, no fetch ✓");
});

// ─── T-M_p6.5 — TELEGRAM_TOKEN never in tool envelope (audit redaction) ───────

test("T-M_p6.5: telegram_notify input envelope never contains TELEGRAM_TOKEN value", async () => {
  // The audit writer logs `tr.args` (the Zod-validated params) — these are { body, severity, parseMode? }.
  // The token lives only in the URL (never in args). This test verifies the input schema.
  const tool = makeTelegramNotifyTool();
  // Access the tool's parameter schema and verify no field could carry a token value.
  // The parameters only allow: body (string), severity (enum), parseMode (enum | undefined).
  // The token CANNOT be in the input because the Zod schema doesn't have a token field.
  const schema = (tool as unknown as { parameters: { shape?: Record<string, unknown> } }).parameters;
  const schemaShape = schema?.shape ?? {};
  const fields = Object.keys(schemaShape);
  assert.ok(!fields.includes("token"), "T-M_p6.5: 'token' must NOT be a parameter field");
  assert.ok(!fields.includes("TELEGRAM_TOKEN"), "T-M_p6.5: 'TELEGRAM_TOKEN' must NOT be a parameter field");
  assert.ok(fields.includes("body"), "T-M_p6.5: 'body' must be a parameter field");
  assert.ok(fields.includes("severity"), "T-M_p6.5: 'severity' must be a parameter field");

  // Also verify: a successful execute result envelope does NOT stringify to contain the token.
  process.env.TELEGRAM_TOKEN = "SUPER_SECRET_TG_TOKEN";
  process.env.TELEGRAM_CHAT_ID = "42";
  try {
    let result: unknown;
    await withFetchMock(
      async () => makeTgSuccessResponse(9999),
      async () => {
        result = await tool.execute(
          { body: "envelope audit test", severity: "info" },
          { toolCallId: "t-m-p6-5", messages: [] },
        );
      },
    );
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes("SUPER_SECRET_TG_TOKEN"),
      `T-M_p6.5: TELEGRAM_TOKEN must NOT appear in serialized result envelope`,
    );
    console.log("T-M_p6.5: TELEGRAM_TOKEN absent from input schema + result envelope ✓");
  } finally {
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});
