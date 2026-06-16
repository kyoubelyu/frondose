import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDotenv } from "../../src/cli/env.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// T-M5 + T-M6: inline .env reader contract

test("T-M5: loadDotenv populates new keys; ignores comments and blanks", () => {
  const dir = mkdtempSync(join(tmpdir(), "mai-env-t5-"));
  try {
    writeFileSync(join(dir, ".env"), "# comment\nKEY_A=value_a\n\nKEY_B=value_b\n", "utf-8");
    const prevA = process.env.KEY_A;
    const prevB = process.env.KEY_B;
    delete process.env.KEY_A;
    delete process.env.KEY_B;
    try {
      loadDotenv(dir);
      assert.equal(process.env.KEY_A, "value_a", "KEY_A should be populated");
      assert.equal(process.env.KEY_B, "value_b", "KEY_B should be populated");
    } finally {
      if (prevA === undefined) delete process.env.KEY_A;
      else process.env.KEY_A = prevA;
      if (prevB === undefined) delete process.env.KEY_B;
      else process.env.KEY_B = prevB;
    }
  } finally {
    cleanupTmpDir(dir);
  }
});

test("T-M6: loadDotenv no-clobber; FRONDOSE_DOTENV=skip; silent on missing file", async (t) => {
  await t.test("6a: does NOT clobber pre-existing keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "mai-env-t6a-"));
    const prevC = process.env.KEY_C;
    try {
      process.env.KEY_C = "preset";
      writeFileSync(join(dir, ".env"), "KEY_C=overwritten\n", "utf-8");
      loadDotenv(dir);
      assert.equal(process.env.KEY_C, "preset", "pre-existing KEY_C must not be overwritten");
    } finally {
      if (prevC === undefined) delete process.env.KEY_C;
      else process.env.KEY_C = prevC;
      cleanupTmpDir(dir);
    }
  });

  await t.test("6b: FRONDOSE_DOTENV=skip bypasses loading entirely", () => {
    const dir = mkdtempSync(join(tmpdir(), "mai-env-t6b-"));
    const prevSkip = process.env.FRONDOSE_DOTENV;
    const prevD = process.env.KEY_D;
    try {
      process.env.FRONDOSE_DOTENV = "skip";
      delete process.env.KEY_D;
      writeFileSync(join(dir, ".env"), "KEY_D=value_d\n", "utf-8");
      loadDotenv(dir);
      assert.equal(process.env.KEY_D, undefined, "KEY_D must remain unset when FRONDOSE_DOTENV=skip");
    } finally {
      if (prevSkip === undefined) delete process.env.FRONDOSE_DOTENV;
      else process.env.FRONDOSE_DOTENV = prevSkip;
      if (prevD === undefined) delete process.env.KEY_D;
      else process.env.KEY_D = prevD;
      cleanupTmpDir(dir);
    }
  });

  await t.test("6c: silent when .env file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mai-env-t6c-"));
    try {
      // Do NOT write .env — must not throw
      assert.doesNotThrow(() => loadDotenv(dir), "loadDotenv must be silent on missing .env");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});
