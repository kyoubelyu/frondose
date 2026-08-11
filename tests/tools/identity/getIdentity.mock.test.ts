import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { identityFieldNames } from "../../../src/persistence/identity.js";
import { makeGetIdentityTool } from "../../../src/tools/identity/getIdentity.js";
import { cleanupTmpDir, makeTmpDir } from "../../_helpers/tmp";

type GetIdentityResult = {
  data: {
    record: { fullName: string } | null;
    missing: string[];
  };
};

describe("getIdentity reads current config", () => {
  it("T-M115: missing config returns null and all fields missing", async () => {
    // Given an isolated missing config; When tool executes; Then record is null and all fields are missing.
    const root = makeTmpDir("get-identity-missing");
    try {
      const result = (await makeGetIdentityTool(join(root, "config.json")).execute(
        {},
        { toolCallId: "t", messages: [] },
      )) as GetIdentityResult;
      assert.equal(result.data.record, null);
      assert.deepEqual(result.data.missing, [...identityFieldNames]);
    } finally {
      cleanupTmpDir(root);
    }
  });

  it("T-M116: schema-v2 identity is returned", async () => {
    // Given a current config identity; When tool executes; Then that record is projected.
    const root = makeTmpDir("get-identity-current");
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
      const result = (await makeGetIdentityTool(path).execute(
        {},
        { toolCallId: "t", messages: [] },
      )) as GetIdentityResult;
      assert.equal(result.data.record.fullName, "Alice");
    } finally {
      cleanupTmpDir(root);
    }
  });
});
