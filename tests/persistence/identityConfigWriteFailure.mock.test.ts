import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { IdentityRecord } from "../../src/persistence/identitySchema.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp";

const renameFailure = Object.assign(new Error("forced current-config rename failure"), { code: "EACCES" });
const renameSyncSpy = mock.fn((_from: string, _to: string) => {
  throw renameFailure;
});

mock.module("node:fs", { namedExports: { ...realFs, renameSync: renameSyncSpy } });

describe("identity current-config write failure is fail-closed", () => {
  it("T-NO-ID-LEGACY.10: real writeConfig rename failure preserves original bytes, cleans tmp, propagates, and has no secondary sink", async () => {
    // Given a valid current config and a forced failure at its real renameSync; When identity writes; Then original bytes survive and no fallback write occurs.
    const root = makeTmpDir("frondose-identity-rename-failure");
    const agentDir = join(root, ".frondose", "agent");
    const configPath = join(agentDir, "config.json");
    const legacyPath = join(agentDir, "identity.json");
    const previousHome = process.env.FRONDOSE_HOME_BASE;
    const original = JSON.stringify({
      schema_version: 2,
      identity: { fullName: "Original", updatedAt: "2026-08-12T00:00:00.000Z" },
      updateServerUrl: null,
    });
    const replacement: IdentityRecord = {
      fullName: "Replacement",
      updatedAt: "2026-08-12T00:00:01.000Z",
    };
    try {
      process.env.FRONDOSE_HOME_BASE = root;
      realFs.mkdirSync(agentDir, { recursive: true });
      realFs.writeFileSync(configPath, original, "utf8");
      const { writeIdentity } = await import("../../src/persistence/identity.js");

      assert.throws(
        () => writeIdentity(replacement, configPath),
        (error) => error === renameFailure,
      );
      assert.equal(realFs.readFileSync(configPath, "utf8"), original);
      assert.equal(realFs.existsSync(`${configPath}.tmp`), false);
      assert.equal(realFs.existsSync(legacyPath), false);
      assert.deepEqual(
        realFs.readdirSync(agentDir).filter((name) => name.includes(".tmp")),
        [],
      );
      assert.equal(renameSyncSpy.mock.callCount(), 1, "only current config may attempt a rename");
    } finally {
      if (previousHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = previousHome;
      cleanupTmpDir(root);
    }
  });
});
