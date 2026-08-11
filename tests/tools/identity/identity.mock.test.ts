import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readConfig } from "../../../src/persistence/config.js";
import { makeIdentityTool } from "../../../src/tools/identity/identity.js";
import { cleanupTmpDir, makeTmpDir } from "../../_helpers/tmp";

describe("identity tool writes current config", () => {
  it("T-M110: tool exposes a non-empty description and optional patch schema", () => {
    // Given an isolated config path; When tool is built; Then its public shape remains valid.
    const tool = makeIdentityTool("/nonexistent/config.json");
    assert.ok(tool.description);
    assert.deepEqual(tool.parameters.parse({}), {});
  });

  it("T-M112: patch preserves existing current identity and writes merged fields", async () => {
    // Given current identity Alice; When role is patched; Then Alice and the new role persist in current config.
    const root = makeTmpDir("identity-tool-current");
    const path = join(root, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: 2,
          identity: { fullName: "Alice", updatedAt: "2026-08-12T00:00:00.000Z" },
          updateServerUrl: null,
        }),
      );
      const result = (await makeIdentityTool(path).execute({ role: "Founder" }, { toolCallId: "t", messages: [] })) as {
        ok: boolean;
      };
      assert.equal(result.ok, true);
      assert.equal(readConfig(path).identity?.fullName, "Alice");
      assert.equal(readConfig(path).identity?.role, "Founder");
    } finally {
      cleanupTmpDir(root);
    }
  });
});
