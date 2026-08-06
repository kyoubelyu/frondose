import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { readConfig } from "../../src/persistence/config.js";

const REPO = process.cwd();
const TSX_IMPORT = createRequire(import.meta.url).resolve("tsx");
const PUBLIC_UPDATE_BASE = "https://github.com/kyoubelyu/frondose/releases/latest/download";
const LEGACY_UPDATE_BASE = "http://192.0.2.105:4875";
const PUBLIC_CREDENTIAL_GENERATOR = join(REPO, "scripts", "gen-public-default-credentials.ts");
const PUBLIC_POLICY = join(REPO, "scripts", "public-release-policy.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("public runtime defaults are internet-safe and BYOK", () => {
  it("T-OS.Update.1: TypeScript and Rust use the same public HTTPS updater base and preserve explicit disable semantics", async () => {
    // Given both updater owners, when their constants and branches are inspected, then defaults match and null/blank still disable.
    const ts = await readFile(join(REPO, "src/persistence/config.ts"), "utf8");
    const rust = await readFile(join(REPO, "src/tauri/src-tauri/src/updater.rs"), "utf8");
    assert.ok(ts.includes(PUBLIC_UPDATE_BASE));
    assert.ok(rust.includes(PUBLIC_UPDATE_BASE));
    assert.ok(ts.includes("nullable()"));
    assert.match(rust, /Value::Null\) => None/);
    assert.match(rust, /s\.is_empty\(\).*=> None/);
    assert.ok(!ts.includes("192.0.2.105"));
    assert.ok(!rust.includes("192.0.2.105"));
  });

  it("T-OS.Update.2: the TypeScript resolver executes every default, migration, disable and override branch", async () => {
    // Given fresh, malformed, legacy-default, disabled and custom configs, when read, then only the historical baked value migrates.
    const cases: Array<[string, string | null | undefined, string | null]> = [
      ["missing file", undefined, PUBLIC_UPDATE_BASE],
      ["malformed JSON", "{", PUBLIC_UPDATE_BASE],
      ["non-string", JSON.stringify({ schema_version: 2, updateServerUrl: 7 }), PUBLIC_UPDATE_BASE],
      [
        "legacy baked default",
        JSON.stringify({ schema_version: 2, updateServerUrl: LEGACY_UPDATE_BASE }),
        PUBLIC_UPDATE_BASE,
      ],
      ["explicit null", JSON.stringify({ schema_version: 2, updateServerUrl: null }), null],
      ["explicit blank", JSON.stringify({ schema_version: 2, updateServerUrl: "  " }), null],
      [
        "public default",
        JSON.stringify({ schema_version: 2, updateServerUrl: PUBLIC_UPDATE_BASE }),
        PUBLIC_UPDATE_BASE,
      ],
      [
        "custom override",
        JSON.stringify({ schema_version: 2, updateServerUrl: "https://updates.example.com" }),
        "https://updates.example.com",
      ],
    ];
    for (const [name, raw, expected] of cases) {
      const directory = await mkdtemp(join(tmpdir(), "frondose-public-updater-ts-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "config.json");
      if (raw !== undefined) await writeFile(path, raw, "utf8");
      assert.equal(readConfig(path).updateServerUrl, expected, name);
    }
  });

  it("T-OS.Update.3: Tauri updater configuration permits only the public HTTPS channel", async () => {
    // Given the compiled updater configuration, when parsed, then no private HTTP fallback or insecure transport allowance remains.
    const config = JSON.parse(await readFile(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf8"));
    const endpoints = config.plugins?.updater?.endpoints ?? [];
    assert.deepEqual(endpoints, [`${PUBLIC_UPDATE_BASE}/latest.json`]);
    assert.notEqual(config.plugins?.updater?.dangerousInsecureTransportProtocol, true);
  });

  it("T-OS.Cred.1: public credential generation ignores historical embedding env vars and emits only null defaults", async () => {
    // Given credential canaries in every legacy env, when the generator runs in an isolated tree, then generated values remain null.
    const dir = await mkdtemp(join(tmpdir(), "frondose-keyless-generator-"));
    temporaryDirectories.push(dir);
    await cp(PUBLIC_CREDENTIAL_GENERATOR, join(dir, "gen-public-default-credentials.ts"));
    const canary = "sk-public-release-canary-must-never-ship";
    const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, join(dir, "gen-public-default-credentials.ts")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        FRONDOSE_DEFAULT_LLM_BASEURL: "https://llm.example.com/v1",
        FRONDOSE_DEFAULT_LLM_MODEL: "provider:model/canary",
        FRONDOSE_DEFAULT_LLM_KEY: canary,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const generated = await readFile(join(dir, "src/persistence/defaultCredentials.generated.json"), "utf8");
    assert.deepEqual(JSON.parse(generated), {
      _generated: "GENERATED by scripts/gen-public-default-credentials.ts — public BYOK build; DO NOT COMMIT.",
      llmBaseUrl: null,
      llmModel: null,
      llmKey: null,
    });
    assert.ok(!generated.includes(canary));
    assert.ok(!run.stdout.includes(canary));
    assert.ok(!run.stderr.includes(canary));
  });

  it("T-OS.Cred.2: public build graphs can invoke only the keyless generator and cannot select the private embedding path", async () => {
    // Given parsed public workflow/package graphs, when reachability is evaluated, then only the keyless generator is callable and each bypass mutation fails.
    const { validatePublicBuildGraph } = (await import(pathToFileURL(PUBLIC_POLICY).href)) as {
      validatePublicBuildGraph(input: { ci: string; release: string; packageJson: string }): {
        ok: boolean;
        findings: unknown[];
      };
    };
    const valid = {
      ci: "jobs:\n  build:\n    steps:\n      - run: npm run credentials:public\n      - run: npm run build\n",
      release:
        "jobs:\n  release:\n    needs: build\n    steps:\n      - run: npm run credentials:public\n      - run: npm run release:inspect\n",
      packageJson: JSON.stringify({
        scripts: {
          "credentials:public": "tsx scripts/gen-public-default-credentials.ts",
          build: "npm run credentials:public && tsc",
          "release:inspect": "node scripts/public-release-policy.mjs inspect",
        },
      }),
    };
    assert.deepEqual(validatePublicBuildGraph(valid), { ok: true, findings: [] });
    const mutations = [
      { ...valid, ci: valid.ci.replace("credentials:public", "credentials:private") },
      {
        ...valid,
        packageJson: valid.packageJson.replace("gen-public-default-credentials.ts", "gen-default-credentials.ts"),
      },
      { ...valid, release: `${valid.release}        env:\n          FRONDOSE_ALLOW_KEYLESS: "1"\n` },
      { ...valid, ci: valid.ci.replace("npm run credentials:public", "npm run $CREDENTIAL_MODE") },
      { ...valid, packageJson: valid.packageJson.replace("&& tsc", "&& npm run credentials:private && tsc") },
    ];
    for (const mutation of mutations) assert.equal(validatePublicBuildGraph(mutation).ok, false);
  });
});
