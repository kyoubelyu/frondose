import assert from "node:assert/strict";
import { test } from "node:test";
import { echoTool } from "../../src/tools/control/echo.js";

// T-M12: echoTool execute contract + Zod schema

const abortSignal = new AbortController().signal;

test("T-M12: echoTool.execute returns { echoed: message }", async () => {
  const result = await echoTool.execute({ message: "hi" }, { toolCallId: "c1", messages: [], abortSignal });
  assert.deepEqual(result, { echoed: "hi" });
});

test("T-M12b: echoTool.execute handles empty string message", async () => {
  const result = await echoTool.execute({ message: "" }, { toolCallId: "c2", messages: [], abortSignal });
  assert.deepEqual(result, { echoed: "" });
});

test("T-M12c: echoTool Zod parameters schema validates correctly", () => {
  const params = echoTool.parameters;

  // Valid input
  const valid = params.parse({ message: "x" });
  assert.deepEqual(valid, { message: "x" });

  // Invalid input (missing message key)
  const invalid = params.safeParse({});
  assert.equal(invalid.success, false, "safeParse({}) must fail");
});

test("T-M12d: echoTool has expected description", () => {
  assert.ok(echoTool.description?.toLowerCase().includes("echo"), "echoTool.description must mention 'echo'");
});
