/**
 * ISSUE-CONFIG-BOM-STRIP — BOM-tolerant JSON file read helper.
 *
 * Test names follow BDD-light: "T-X.N: when <preconditions>, <action> → <expected>"
 *
 * Root cause: `readFileSync(path, "utf-8")` decodes a leading UTF-8 BOM
 * (EF BB BF) into the `﻿` (U+FEFF) character but does not strip it, so
 * `JSON.parse` throws on any file hand-edited on Windows via PowerShell
 * Out-File/Set-Content/`>` or legacy Notepad (both commonly emit a BOM).
 * `readJsonFileSync` (src/persistence/jsonFile.ts) strips it before parsing;
 * every persistence reader now routes through it.
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configJsonSchemaV2, readConfig, writeConfig } from "../../src/persistence/config.js";
import { readJsonFileSync } from "../../src/persistence/jsonFile.js";
import { readSecrets } from "../../src/persistence/secrets.js";
import { readServerIdentity, writeServerIdentity } from "../../src/persistence/serverIdentity.js";
import { cleanupTmpDir, makeTmpDir } from "../_helpers/tmp";

const UTF8_BOM = "﻿";

describe("readJsonFileSync (src/persistence/jsonFile.ts)", () => {
  it("T-JsonFile.1: when a file has a leading UTF-8 BOM, parses it as if the BOM were absent", () => {
    const dir = makeTmpDir("frondose-bom-jsonfile-");
    try {
      const path = join(dir, "bom.json");
      writeFileSync(path, `${UTF8_BOM}${JSON.stringify({ a: 1, b: "two" })}`, "utf-8");
      assert.deepEqual(readJsonFileSync(path), { a: 1, b: "two" });
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-JsonFile.1b: when a BOM is immediately followed by CRLF-formatted JSON, parses it correctly", () => {
    const dir = makeTmpDir("frondose-bom-jsonfile-crlf-");
    try {
      const path = join(dir, "bom-crlf.json");
      writeFileSync(path, `${UTF8_BOM}{\r\n  "a": 1\r\n}`, "utf-8");
      assert.deepEqual(readJsonFileSync(path), { a: 1 });
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-JsonFile.2: when a file has no BOM, parses identically (no regression)", () => {
    const dir = makeTmpDir("frondose-nobom-jsonfile-");
    try {
      const path = join(dir, "plain.json");
      writeFileSync(path, JSON.stringify({ a: 1, b: "two" }), "utf-8");
      assert.deepEqual(readJsonFileSync(path), { a: 1, b: "two" });
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-JsonFile.3: when the JSON is genuinely malformed (BOM-prefixed), still throws (no swallowing)", () => {
    const dir = makeTmpDir("frondose-corrupt-bom-jsonfile-");
    try {
      const path = join(dir, "corrupt.json");
      writeFileSync(path, `${UTF8_BOM}{ not valid json`, "utf-8");
      assert.throws(() => readJsonFileSync(path));
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-JsonFile.3b: when the JSON is genuinely malformed (no BOM), still throws (no regression)", () => {
    const dir = makeTmpDir("frondose-corrupt-nobom-jsonfile-");
    try {
      const path = join(dir, "corrupt.json");
      writeFileSync(path, "{ not valid json", "utf-8");
      assert.throws(() => readJsonFileSync(path));
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

describe("readConfig BOM tolerance (src/persistence/config.ts)", () => {
  it("T-ConfigBom.1: when config.json is BOM-prefixed but otherwise valid, returns the parsed config (not the default fallback)", () => {
    const dir = makeTmpDir("frondose-bom-config-");
    try {
      const path = join(dir, "config.json");
      // Write a valid v2 config via the real writer (language deliberately set
      // away from the "auto" default), then re-prepend a BOM to simulate a
      // hand-edit-on-Windows round-trip.
      const defaultCfg = configJsonSchemaV2.parse({ schema_version: 2 });
      writeConfig({ ...defaultCfg, language: "zh" }, path);
      const written = readJsonFileSync(path) as Record<string, unknown>;
      writeFileSync(path, `${UTF8_BOM}${JSON.stringify(written)}`, "utf-8");

      const cfg = readConfig(path);
      assert.equal(cfg.language, "zh"); // proves it did NOT silently fall back to the "auto" default
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-ConfigBom.2: when config.json is BOM-prefixed AND genuinely corrupt, falls back exactly like a non-BOM corrupt file (regression guard on the existing catch path)", () => {
    const bomDir = makeTmpDir("frondose-bom-config-corrupt-");
    const plainDir = makeTmpDir("frondose-plain-config-corrupt-");
    try {
      const bomPath = join(bomDir, "config.json");
      const plainPath = join(plainDir, "config.json");
      writeFileSync(bomPath, `${UTF8_BOM}{ this is not json`, "utf-8");
      writeFileSync(plainPath, "{ this is not json", "utf-8");

      const bomResult = readConfig(bomPath);
      const plainResult = readConfig(plainPath);
      assert.deepEqual(bomResult, plainResult); // BOM presence changes nothing about the fallback
      assert.equal(bomResult.schema_version, 2);
      assert.equal(bomResult.language, "auto"); // proves it's the default, not a partial parse
    } finally {
      cleanupTmpDir(bomDir);
      cleanupTmpDir(plainDir);
    }
  });
});

describe("other readers tolerate a BOM-prefixed file", () => {
  it("T-ServerIdentityBom.1: readServerIdentity parses a BOM-prefixed identity file correctly", () => {
    const dir = makeTmpDir("frondose-bom-serverIdentity-");
    try {
      const path = join(dir, "identity.json");
      writeServerIdentity(
        {
          operatorName: "Kyoube",
          orchestratorName: "mai-server",
          orchestratorRole: "Operator's chief-of-staff agent",
          priorities: [],
          traits: [],
          updatedAt: new Date().toISOString(),
        },
        path,
      );
      const written = readJsonFileSync(path) as Record<string, unknown>;
      writeFileSync(path, `${UTF8_BOM}${JSON.stringify(written)}`, "utf-8");

      const identity = readServerIdentity(path);
      assert.equal(identity?.operatorName, "Kyoube");
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it("T-SecretsBom.1: readSecrets on a BOM-prefixed secrets.json parses it directly (does not fall through to legacy migration)", () => {
    const dir = makeTmpDir("frondose-bom-secrets-");
    try {
      const path = join(dir, "secrets.json");
      // A minimal but schema-valid secrets.json (schema_version is the only
      // required field) — BOM-prefixed, simulating a hand-edit-on-Windows.
      // Legacy paths are pointed at nonexistent files so a schema-parse
      // FAILURE (i.e. the BOM not being stripped) would be visible as a
      // fall-through to EMPTY_SECRETS rather than a thrown error.
      writeFileSync(path, `${UTF8_BOM}${JSON.stringify({ schema_version: 1, default: "test-model" })}`, "utf-8");
      const result = readSecrets(path, {
        authPath: join(dir, "no-such-auth.json"),
        githubPath: join(dir, "no-such-github.json"),
        searchPath: join(dir, "no-such-search.json"),
        defaultCredentialsPath: join(dir, "no-such-defaults.json"),
      });
      assert.equal(result.default, "test-model");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

describe("source-level regression guard (per FM-1 Codex CONCERN-MR)", () => {
  it("T-SourceGuard.1: no src/persistence/** file (other than jsonFile.ts's own doc comment) calls JSON.parse(readFileSync(...)) directly", async () => {
    const { readdirSync, readFileSync: nodeReadFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const dir = pathJoin(process.cwd(), "src", "persistence");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts") || entry === "jsonFile.ts") continue;
      const text = nodeReadFileSync(pathJoin(dir, entry), "utf-8");
      if (/JSON\.parse\(\s*readFileSync/.test(text)) offenders.push(entry);
    }
    assert.deepEqual(offenders, []);
  });
});
