/**
 * P-34 Step 4a — T-HBS.1..2 scaffolds (assertion bodies TODO)
 *
 * Tests for the handleBootstrapScript installToken guard in serverHttp.ts.
 * The handler must:
 *   - Return HTTP 200 + text/x-sh + a bash error script when installToken is unset (G-P34.5)
 *   - Return HTTP 200 + the real rendered script when installToken is set (G-P34.6)
 *
 * Gate coverage:
 *   G-P34.5 — T-HBS.1 (installToken undefined → bash error script, no install-core)
 *   G-P34.6 — T-HBS.2 (installToken set → rendered script with GITHUB_TOKEN embedded)
 *
 * All assertion bodies are TODO — intentionally fail until Step 5.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startServerHttp } from "../../src/cli/serverHttp.js";
import { insertInvite, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { openWorkersDb } from "../../src/persistence/workersRegistry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p34-hbs-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Start server on a random port with the given installToken value (undefined or string).
 *  Uses an as-any cast to forward the optional P-34 field through the pre-Step-4b interface. */
async function startAndWait(opts: {
  dir: string;
  installToken: string | undefined;
}): Promise<{ server: Server; port: number; invitesDb: ReturnType<typeof openInvitesDb> }> {
  const { dir, installToken } = opts;
  const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
  const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
  const invitesDb = openInvitesDb(":memory:");
  return new Promise((resolve, reject) => {
    const handlers = {
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://100.64.0.5:3031",
      maiVersion: "0.4.32",
      credentialsDb: null,
      installToken,
    };
    // biome-ignore lint/suspicious/noExplicitAny: P-34 installToken not yet in compiled type at Step 4a
    const srv = startServerHttp(handlers as any, "127.0.0.1", 0);
    srv.on("listening", () => resolve({ server: srv, port: (srv.address() as AddressInfo).port, invitesDb }));
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

interface TextReqResult {
  status: number;
  body: string;
  contentType: string;
}

async function getScript(port: number, path: string): Promise<TextReqResult> {
  return new Promise((resolve, reject) => {
    const r = httpReq({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: (res.headers["content-type"] ?? "") as string,
        }),
      );
    });
    r.on("error", reject);
    r.end();
  });
}

const PLAIN_TOKEN = "a1b2c3d4".repeat(8); // 64-char hex — fake invite token

// ─── T-HBS.1 ──────────────────────────────────────────────────────────────────

describe("handleBootstrapScript — installToken unset → bash error script (G-P34.5)", () => {
  it(
    "T-HBS.1: given pending invite + handlers.installToken=undefined, GET /bootstrap/<token>.sh returns HTTP 200 + Content-Type: text/x-sh + bash error script (#!/usr/bin/env bash, ERROR: …install-token set…, exit 1); no install-core (no releases/latest, no GITHUB_TOKEN=) in body",
    async () => {
      // Given: valid pending invite in invitesDb; handlers.installToken = undefined
      // When:  GET /bootstrap/<plain-token>.sh
      // Then:  status 200; Content-Type: text/x-sh; body starts with #!/usr/bin/env bash;
      //        body contains ERROR message + 'install-token set' + 'exit 1';
      //        body does NOT contain 'releases/latest' or 'GITHUB_TOKEN='
      const { dir, cleanup } = makeTmpDir();
      const { server, port, invitesDb } = await startAndWait({ dir, installToken: undefined });
      // Insert a pending invite so the route reaches the installToken guard.
      insertInvite(invitesDb, sha256(PLAIN_TOKEN), "p1", null, Date.now() + 3_600_000);
      try {
        const res = await getScript(port, `/bootstrap/${PLAIN_TOKEN}.sh`);
        // CONCERN-1 resolution: HTTP 200, not 500
        assert.equal(res.status, 200, `expected 200 (bash error script); got ${res.status}`);
        assert.ok(res.contentType.startsWith("text/x-sh"), `expected text/x-sh; got: ${res.contentType}`);
        // Valid bash error script
        assert.ok(res.body.startsWith("#!/usr/bin/env bash"), "body must start with #!/usr/bin/env bash shebang");
        assert.ok(
          res.body.includes("ERROR:") && res.body.includes("install-token set"),
          `body must contain ERROR message + 'install-token set'; got: ${res.body.slice(0, 120)}`,
        );
        assert.ok(res.body.includes("exit 1"), "body must contain 'exit 1'");
        // D-9: real install-core + token NOT served in the error path
        assert.ok(!res.body.includes("releases/latest"), "error body must NOT contain releases/latest (no install-core)");
        assert.ok(!res.body.includes("GITHUB_TOKEN="), "error body must NOT contain GITHUB_TOKEN= (no PAT in error)");
      } finally {
        await closeServer(server);
        invitesDb.close();
        cleanup();
      }
    },
  );
});

// ─── T-HBS.2 ──────────────────────────────────────────────────────────────────

describe("handleBootstrapScript — installToken set → real rendered script (G-P34.6)", () => {
  it(
    'T-HBS.2: given pending invite + handlers.installToken="ghp_PLACEHOLDER", GET /bootstrap/<token>.sh returns HTTP 200 + Content-Type: text/x-sh + script body containing GITHUB_TOKEN="ghp_PLACEHOLDER"',
    async () => {
      // Given: valid pending invite in invitesDb; handlers.installToken = "ghp_PLACEHOLDER"
      // When:  GET /bootstrap/<plain-token>.sh
      // Then:  status 200; Content-Type: text/x-sh; body contains GITHUB_TOKEN="ghp_PLACEHOLDER"
      const INSTALL_TOKEN = "ghp_PLACEHOLDER_not_real_github_pat";
      const { dir, cleanup } = makeTmpDir();
      const { server, port, invitesDb } = await startAndWait({ dir, installToken: INSTALL_TOKEN });
      insertInvite(invitesDb, sha256(PLAIN_TOKEN), "p1", null, Date.now() + 3_600_000);
      try {
        const res = await getScript(port, `/bootstrap/${PLAIN_TOKEN}.sh`);
        assert.equal(res.status, 200, `expected 200 (real rendered script); got ${res.status}`);
        assert.ok(res.contentType.startsWith("text/x-sh"), `expected text/x-sh; got: ${res.contentType}`);
        assert.ok(
          res.body.includes(`GITHUB_TOKEN="${INSTALL_TOKEN}"`),
          `body must contain GITHUB_TOKEN assignment with placeholder PAT; got snippet: ${res.body.slice(0, 200)}`,
        );
      } finally {
        await closeServer(server);
        invitesDb.close();
        cleanup();
      }
    },
  );
});
