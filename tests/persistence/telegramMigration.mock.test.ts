import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateTelegramIntoConfig } from "../../src/persistence/config.js";
import { cleanupTmpDir } from "../_helpers/tmp";

function makeTelegramFixture() {
  const dir = mkdtempSync(join(tmpdir(), "frondose-telegram-migrate-"));
  return {
    path: join(dir, "telegram.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

describe("migrateTelegramIntoConfig preserves the retained Telegram migration", () => {
  it("T-MIGRATE.TELEGRAM.1: enabled, bound user, and proxy migrate while runtime-only fields are ignored", () => {
    // Given a complete retired Telegram config, when migrated, then only current config-owned fields survive.
    const fixture = makeTelegramFixture();
    try {
      writeFileSync(
        fixture.path,
        JSON.stringify({
          enabled: true,
          boundUserId: 42,
          proxyUrl: "http://p.test",
          lastUpdateOffset: 7,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf8",
      );
      const migrated = migrateTelegramIntoConfig(fixture.path);
      assert.equal(migrated.telegram.enabled, true);
      assert.equal(migrated.telegram.boundUserId, 42);
      assert.equal(migrated.telegram.proxyUrl, "http://p.test");
    } finally {
      fixture.cleanup();
    }
  });

  it("T-MIGRATE.TELEGRAM.2: a missing proxy URL normalizes to null", () => {
    // Given a Telegram config without proxyUrl, when migrated, then the current config contains null and remains JSON-safe.
    const fixture = makeTelegramFixture();
    try {
      writeFileSync(
        fixture.path,
        JSON.stringify({
          enabled: false,
          boundUserId: null,
          lastUpdateOffset: 0,
          stickyFallbackIp: null,
          pollTimeoutSec: 30,
          pollBackoffSec: 5,
          lastReceivedAt: null,
        }),
        "utf8",
      );
      const migrated = migrateTelegramIntoConfig(fixture.path);
      assert.equal(migrated.telegram.proxyUrl, null);
      assert.equal(migrated.telegram.enabled, false);
      assert.equal(JSON.stringify(migrated).includes("undefined"), false);
    } finally {
      fixture.cleanup();
    }
  });
});
