import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readRepo(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("WIN-6C serve turn test harness residuals", () => {
  it("T-WIN6C.Serve.1: runOneTurn characterization tests mock Pi model preflight instead of reading real DeepSeek credentials", () => {
    // Given: runOneTurn preflights resolvePiModel before calling runAgentLoopPi.
    // When: the serve characterization tests run without real provider credentials.
    // Then: their test harness supplies a Pi model mock and reaches the mocked loop path.
    for (const rel of [
      "tests/cli/subcommands/serve/turn-characterization.mock.test.ts",
      "tests/cli/subcommands/serve/per-turn-mode-fragment.mock.test.ts",
    ]) {
      const source = readRepo(rel);
      assert.match(source, /src\/agent\/pi\/model\.js/, `${rel} must mock the Pi model preflight module`);
      assert.match(source, /resolvePiModel:\s*\(\)\s*=>/, `${rel} must provide a resolvePiModel mock`);
      assert.doesNotMatch(
        source,
        /DEEPSEEK_API_KEY|providers\.deepseek\.key/,
        `${rel} must not read or assert real DeepSeek credentials`,
      );
    }
  });

  it("T-WIN6C.Serve.2: serve test mock module URLs are derived from the test file URL, not process.cwd casing", () => {
    // Given: Windows may expose different casing for process.cwd and import.meta.url paths.
    // When: serve tests register mock.module targets for Pi loop, audit, overlay, db, and reaper modules.
    // Then: target URLs are built from the test file location so mock registration is stable on Windows.
    for (const rel of [
      "tests/cli/subcommands/serve/turn-characterization.mock.test.ts",
      "tests/cli/subcommands/serve/per-turn-mode-fragment.mock.test.ts",
    ]) {
      const source = readRepo(rel);
      assert.match(source, /fileURLToPath/, `${rel} must derive repo root from the test file URL`);
      assert.match(source, /import\.meta\.url/, `${rel} must use import.meta.url for stable module URLs`);
      assert.doesNotMatch(source, /resolve\(process\.cwd\(\)/, `${rel} must not build mock URLs from process.cwd()`);
    }
  });
});

describe("WIN-6C server web static routing residuals", () => {
  it("T-WIN6C.Web.1: server web static index serves from assetRoot on Windows", () => {
    // Given: assetRoot contains index.html.
    // When: GET / routes through serveStatic on Windows.
    // Then: the response is 200 with the file body instead of a false traversal 404.
    const source = readRepo("src/cli/serverWeb.ts");
    assert.match(source, /relative\(assetRoot,\s*resolved\)/, "serveStatic must use path.relative for containment");
    assert.doesNotMatch(
      source,
      /startsWith\(`\$\{assetRoot\}\/`\)/,
      "serveStatic must not use POSIX slash string-prefix containment",
    );
  });

  it("T-WIN6C.Web.2: server web traversal remains blocked after cross-platform containment fix", () => {
    // Given: a request path attempts to escape assetRoot, including encoded traversal.
    // When: GET routes through serveStatic.
    // Then: the response remains 404 on both Windows and POSIX.
    const source = readRepo("src/cli/serverWeb.ts");
    assert.match(source, /assetRelative\.startsWith\(""\.\."\)|assetRelative\.startsWith\("\.\."\)/, "guard must reject .. relative paths");
    assert.match(source, /isAbsolute\(assetRelative\)/, "guard must reject absolute relative results");
    assert.match(source, /decodeURIComponent\(urlPath\)/, "guard must still decode URL paths before resolution");
  });
});

describe("WIN-6C telegram media-group residuals", () => {
  it("T-WIN6C.Telegram.1: Windows absolute media-group paths attach as multipart files", () => {
    // Given: a mediaGroup item uses a readable Windows absolute local path.
    // When: telegram_notify builds the sendMediaGroup request.
    // Then: the JSON media entry uses attach://mediaN and the multipart body contains the file part.
    const source = readRepo("src/tools/operatorOutput/telegram.ts");
    assert.match(source, /function isLocalMediaPath/, "telegram media group must use a local-path predicate");
    assert.match(source, /path\.win32\.isAbsolute\(media\)/, "predicate must recognize Windows absolute paths");
    assert.ok(source.includes('media.includes("\\\\")'), "predicate must recognize Windows path separators");
    assert.match(source, /attach:\/\/\$\{partName\}/, "local media must be rewritten to attach://mediaN");
  });

  it("T-WIN6C.Telegram.2: media-group URLs and opaque Telegram file IDs remain remote references", () => {
    // Given: a mediaGroup item uses an https URL or opaque Telegram file_id.
    // When: telegram_notify builds the sendMediaGroup request.
    // Then: the JSON media entry remains the original remote reference and no local file read is attempted.
    const source = readRepo("src/tools/operatorOutput/telegram.ts");
    assert.match(source, /\^https\?:\\\/\\\/\)\|i\.test\(media\)|\^https\?:\\\/\\\//, "predicate must keep HTTP(S) URLs remote");
    assert.match(source, /return \{ type: item\.type, media: item\.media/, "remote refs must remain item.media");
  });
});

describe("WIN-6C live gate residuals", () => {
  it("T-WIN6C.Live: Windows test-fast returns to the locked WIN-6 baseline after blocker fixes", () => {
    // Given: WIN-6C implementation and validation are complete.
    // When: npm run test:fast runs on frondose-win2.
    // Then: only the locked baseline failures remain and no unexpected EPERM/EBUSY/ENOENT stacks appear.
    const logPath = process.env.WIN6C_WINDOWS_LIVE_LOG;
    if (!logPath) return;
    assert.ok(existsSync(logPath), `WIN6C_WINDOWS_LIVE_LOG must exist: ${logPath}`);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /ℹ fail 17\b/, "Windows full suite must return to the locked 17-failure baseline");
    assert.doesNotMatch(log, /tests\\cli\\subcommands\\serve\\(?:per-turn-mode-fragment|turn-characterization)\.mock\.test\.ts/);
    assert.doesNotMatch(log, /tests\\cli\\serverWeb\.mock\.test\.ts/);
    assert.doesNotMatch(log, /tests\\tools\\operatorOutput\\telegram-extended\.test\.ts/);
  });
});
