import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AuditEntry } from "../../src/persistence/audit.js";
import { boundedSanitize, makeAuditWriter, writeAuditRow } from "../../src/persistence/audit.js";
import { cleanupTmpDir } from "../_helpers/tmp";

const TRUNCATE_BYTES = 2000;
const MAX_JSON_LENGTH = 7000;

function makeDeepObject(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < levels; index += 1) {
    const next: Record<string, unknown> = { level: index };
    cursor.next = next;
    cursor = next;
  }
  return root;
}

function makeWideObject(width: number, value: unknown): Record<string, unknown> {
  const object = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < width; index += 1) {
    object[index] = value;
  }
  return object;
}

function makeStep(
  toolResults: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }>,
  finishReason = "tool-calls",
) {
  return {
    toolResults,
    finishReason,
  } as unknown as Parameters<ReturnType<typeof makeAuditWriter>>[0];
}

describe("P-AUTO-L3FIX-3 bounded audit sanitization", () => {
  it("bounds deeply nested, wide, and circular values without full serialization", () => {
    const sharedLargeString = "x".repeat(2000);
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    const cases: Array<{ name: string; value: unknown }> = [
      { name: "deep object", value: makeDeepObject(120) },
      { name: "wide array", value: new Array(1_000_000).fill(sharedLargeString) },
      { name: "wide object", value: makeWideObject(1_000_000, sharedLargeString) },
      { name: "circular object", value: circular },
    ];

    for (const testCase of cases) {
      // Given a pathological audit payload (1e6 elems/keys), when it is sanitized, then output stays small —
      // proving an EARLY-EXIT walk: an unbounded full walk would time the test out, not return a small clone.
      const result = boundedSanitize(testCase.value, TRUNCATE_BYTES);
      const json = JSON.stringify(result.value);

      assert.equal(result.truncated, true, `${testCase.name}: result must be marked truncated`);
      assert.ok(json.length <= MAX_JSON_LENGTH, `${testCase.name}: JSON length must stay bounded; got ${json.length}`);
    }
  });

  it("defends against accessors and unreadable data properties", () => {
    let getterCalls = 0;
    const accessors: Record<string, unknown> = { normal: "ok" };
    Object.defineProperty(accessors, "large", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { payload: new Array(1_000_000).fill("x") };
      },
    });
    Object.defineProperty(accessors, "fresh", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return makeWideObject(1_000_000, "x");
      },
    });

    const unreadable = new Proxy<{ safe: string; boom?: unknown }>(
      { safe: "ok" },
      {
        get(target, property, receiver) {
          if (property === "boom") throw new Error("read failed");
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          if (property === "boom") {
            return { configurable: true, enumerable: true, value: "placeholder", writable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
          return [...Reflect.ownKeys(target), "boom"];
        },
      },
    );

    // Given accessor and throwing-read properties, when sanitized, then getters are not invoked and throws become markers.
    const result = boundedSanitize({ accessors, unreadable }, TRUNCATE_BYTES);
    const value = result.value as {
      accessors: Record<string, unknown>;
      unreadable: Record<string, unknown>;
    };

    assert.equal(result.truncated, true, "accessor markers must mark the result truncated");
    assert.equal(getterCalls, 0, "getters must not be invoked");
    assert.equal(value.accessors.large, "[getter]", "large getter must be represented by a marker");
    assert.equal(value.accessors.fresh, "[getter]", "fresh getter must be represented by a marker");
    assert.equal(value.unreadable.safe, "ok", "readable data properties must be preserved");
    assert.equal(value.unreadable.boom, "[unreadable]", "throwing data reads must be represented by a marker");
  });

  it("preserves normal small plain-object JSON shape", () => {
    const value = {
      ok: true,
      text: "hello",
      nested: { count: 2, list: ["a", 3, null] },
    };

    // Given a normal small JSON-like payload, when sanitized, then JSON output is identical and not marked truncated.
    const result = boundedSanitize(value, TRUNCATE_BYTES);

    assert.equal(result.truncated, false, "small payload must not be marked truncated");
    assert.equal(JSON.stringify(result.value), JSON.stringify(value), "small payload JSON must be byte-identical");
    assert.notEqual(result.value, value, "small object payload should still be returned as a capped clone");
  });

  it("bounds audit input rows and preserves circular markers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frondose-audit-bounded-"));
    const auditPath = join(dir, "audit.jsonl");
    const input: Record<string, unknown> = {
      items: new Array(1_000_000).fill("x"),
      reason: "bounded input",
    };
    input.self = input;

    try {
      const writer = makeAuditWriter(auditPath);
      await writer(makeStep([{ toolCallId: "tc-input", toolName: "inspect", args: input, result: { ok: true } }]));

      const directRow: AuditEntry = {
        ts: "2026-06-19T00:00:00.000Z",
        toolCallId: "tc-direct-input",
        toolName: "stop",
        input,
        output: { ok: true },
        error: null,
        stepFinishReason: "stop-tool",
      };
      writeAuditRow(auditPath, directRow);

      // Given huge circular tool args, when audit rows are written, then final JSONL lines contain bounded cloned input.
      const lines = readFileSync(auditPath, "utf-8").trim().split("\n");
      assert.equal(lines.length, 2, "writer and direct row should both append a line");

      for (const line of lines) {
        assert.ok(line.length <= MAX_JSON_LENGTH, `audit JSONL line must stay bounded; got ${line.length}`);
        const entry = JSON.parse(line) as AuditEntry;
        const inputJson = JSON.stringify(entry.input);
        assert.ok(inputJson.includes("[circular]"), "sanitized input must preserve circular marker");
        assert.ok(inputJson.includes("[+999950 more]"), "sanitized input must preserve array width marker");
      }
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
