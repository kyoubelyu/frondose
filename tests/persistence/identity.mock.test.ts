import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyIdentityPatch,
  icpSchema,
  identityFieldNames,
  identityRecordSchema,
  missingIdentityFields,
  readIdentity,
  writeIdentity,
} from "../../src/persistence/identity.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp";

describe("current-config identity persistence", () => {
  it("T-M91: missing current config returns null without creating a file", () => {
    // Given an isolated missing config; When identity is read; Then null returns with no write.
    const root = makeTmpDir("identity-current-missing");
    const configPath = join(root, "config.json");
    try {
      assert.equal(readIdentity(configPath), null);
      assert.equal(existsSync(configPath), false);
    } finally {
      cleanupTmpDir(root);
    }
  });

  it("T-M94/T-IW.1: writeIdentity writes current config atomically with no tmp residue", () => {
    // Given an isolated current config; When identity writes; Then it reads back and leaves no tmp.
    const root = makeTmpDir("identity-current-write");
    const configPath = join(root, "config.json");
    const record = identityRecordSchema.parse({ fullName: "Bob Jones", updatedAt: new Date().toISOString() });
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ schema_version: 2, updateServerUrl: null }), "utf8");
      writeIdentity(record, configPath);
      assert.deepEqual(readIdentity(configPath), record);
      assert.equal(existsSync(`${configPath}.tmp`), false);
    } finally {
      cleanupTmpDir(root);
    }
  });
});

describe("identity value helpers", () => {
  it("T-M95: patches merge and drop empty values", () => {
    // Given current fields and an empty replacement; When patched; Then values merge and empty fields disappear.
    const merged = applyIdentityPatch({ fullName: "Alice", role: "CEO" }, { company: "NewCo", role: "" });
    assert.equal(merged.fullName, "Alice");
    assert.equal(merged.company, "NewCo");
    assert.equal(merged.role, undefined);
  });

  it("T-M96: missingIdentityFields follows the seven-field inventory", () => {
    // Given an empty identity; When missing fields are listed; Then all canonical fields appear.
    assert.deepEqual(missingIdentityFields({}), [...identityFieldNames]);
  });

  it("T-M97: ICP requires at least one target role", () => {
    // Given empty and populated role arrays; When parsed; Then only the populated shape succeeds.
    assert.throws(() => icpSchema.parse({ targetRole: [] }));
    assert.deepEqual(icpSchema.parse({ targetRole: ["VP Engineering"] }).targetRole, ["VP Engineering"]);
  });
});
