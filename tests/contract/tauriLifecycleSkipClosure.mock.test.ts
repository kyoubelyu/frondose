import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const CARRIER = join(process.cwd(), "tests", "tauri", "lifecycle-drun1-pY5.test.ts");
const source = readFileSync(CARRIER, "utf8");

function count(pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe("P-TAURI-LIFECYCLE-SKIP-CLOSURE completion contract", () => {
  // Given/When/Then: the exact lifecycle owner is scanned, then no executable test skip may remain.
  it("T-TauriLifeSkip.1: the lifecycle carrier contains zero runtime skip calls", () => {
    assert.equal(count(/\b(?:it|test|describe)\.skip\s*\(/g), 0, "expected zero runtime skips in lifecycle carrier");
  });

  // Given/When/Then: the historical safety titles are scanned, then each remains exactly once.
  it("T-TauriLifeSkip.2: both historical lifecycle titles remain exactly once", () => {
    assert.equal(count(/T-Life\.2:/g), 1);
    assert.equal(count(/T-Life\.3:/g), 1);
  });

  // Given/When/Then: the current Pi configuration is inspected, then it targets the isolated DeepSeek-compatible fake.
  it("T-TauriLifeSkip.3: the carrier configures current Pi and Frondose environment keys", () => {
    assert.match(source, /providers:\s*\{\s*deepseek:/);
    assert.match(source, /default:\s*"deepseek:test-model"/);
    for (const key of ["FRONDOSE_HOME_BASE", "FRONDOSE_AUTOUPDATE", "FRONDOSE_DOTENV", "FRONDOSE_MODEL"]) {
      assert.ok(source.includes(key), `missing current env key ${key}`);
    }
  });

  // Given/When/Then: spawnSidecar is inspected, then current TCP transport and closed state isolation are mandatory.
  it("T-TauriLifeSkip.4: spawnSidecar uses app-owned TCP and a closed environment", () => {
    const body = source.slice(source.indexOf("async function spawnSidecar"), source.indexOf("function cleanupSidecar"));
    assert.match(body, /\[APP_SIDECAR,\s*"--port-file",\s*portFile,\s*"--token"/);
    assert.match(source, /host:\s*"127\.0\.0\.1"/);
    assert.ok(!source.includes('"--sock"'), "retired --sock transport must not return anywhere in the carrier");
    assert.ok(!source.includes("socketPath"), "retired UDS request path must not return anywhere in the carrier");
    assert.ok(!body.includes("...process.env"), "spawnSidecar must not inherit ambient environment wholesale");
    for (const retired of ["MAI_AUTOUPDATE", "MAI_DOTENV", "MAI_MODEL", "MAI_HOME_BASE"]) {
      assert.ok(!body.includes(retired), `retired config key remains: ${retired}`);
    }
  });

  // Given/When/Then: fake/readiness/health evidence is inspected, then crash or incidental traffic cannot satisfy a carrier.
  it("T-TauriLifeSkip.5: endpoint, readiness, liveness, and teardown gates fail closed", () => {
    assert.match(source, /req\.method\s*!==\s*"POST"/);
    assert.match(source, /req\.url\s*!==\s*"\/v1\/chat\/completions"/);
    assert.match(source, /serve\.exitCode\s*!==\s*null/);
    assert.match(source, /if\s*\(port\s*===\s*0\)/);
    assert.match(source, /await tcpGet\(candidate,\s*token,\s*"\/health"\)/);
    assert.equal(count(/req\.setTimeout\(5000,/g), 2, "GET and POST must each retain a five-second timeout");
    assert.match(source, /SSE connect timed out"\)\),\s*5000/);
    assert.match(source, /await withTimeout\(exited,\s*5000,\s*"sidecar did not exit within 5s of SIGKILL"\)/);
    assert.match(source, /await withTimeout\([\s\S]{0,180}fake\.server\.close/);
    assert.match(source, /fake LLM server must close within 5s after sidecar teardown/);
    assert.equal(
      count(/assert\.equal\(await tcpGet\(s\.port,\s*s\.token,\s*"\/health"\),\s*200,/g),
      2,
      "both abort and reconnect carriers must prove the sidecar remains healthy",
    );
    assert.equal(
      count(/assert\.equal\(s\.serve\.exitCode,\s*null,/g),
      2,
      "both abort and reconnect carriers must prove the sidecar remains alive",
    );
    assert.ok(!source.includes("Promise.race("), "teardown bounds must cancel their winning-path timers");
    assert.ok(!source.includes("--test-force-exit"), "the carrier must prove natural process exit");
  });
});
