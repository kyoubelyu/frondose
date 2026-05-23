/**
 * Test fixture helper: calls runIdentityBootstrap(identityPath) and writes the
 * resulting record as JSON to stdout, then exits. Used by T-M123..T-M126 via
 * spawn with piped stdin so we can test readline behavior without real TTY.
 *
 * Usage:
 *   tsx tests/fixtures/identity-bootstrap-runner.ts
 * with env: MAI_IDENTITY_PATH=<path>
 * and stdin: canned input lines separated by newlines
 *
 * P-Z3: restored — this fixture was deleted in P-41 (SSH-provisioning sweep) but
 * T-M126 (identity-init.mock.test.ts) still spawns it. runIdentityBootstrap remains
 * exported at src/cli/identity-init.ts:44; the no-key path writes NO_KEY_ERROR
 * ("No LLM API key found …") to stderr and process.exit(1)s.
 */

import { runIdentityBootstrap } from "../../src/cli/identity-init.js";

const identityPath = process.env.MAI_IDENTITY_PATH;
if (!identityPath) {
  process.stderr.write("ERROR: MAI_IDENTITY_PATH not set\n");
  process.exit(1);
}

try {
  const record = await runIdentityBootstrap(identityPath);
  process.stdout.write(JSON.stringify(record));
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`BOOTSTRAP_ERROR: ${msg}\n`);
  process.exit(1);
}
